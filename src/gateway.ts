import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import type { HaAuth } from './auth.js'

interface Session { expires: number; parent: string }
const sessionLifetime = 12 * 60 * 60_000
function upstreamHeaders(req: IncomingMessage, target: URL) {
  const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' }
  delete headers.cookie
  if (headers.origin) headers.origin = target.origin
  return headers
}
const bridge = `(() => {
  const callback = (name, ...args) => { if (typeof name === 'string' && /^[A-Za-z_$][\\w$]*$/.test(name) && typeof window[name] === 'function') window[name](...args); };
  window.externalApp = {
    getExternalAuth: async (raw) => { let data; try { data = JSON.parse(raw); const response = await fetch('/__cqai/auth', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({force:!!data.force}),credentials:'same-origin',cache:'no-store'}); if (!response.ok) throw new Error(); callback(data.callback,true,await response.json()); } catch { if(data) callback(data.callback,false); } },
    revokeExternalAuth: async (raw) => { const data=JSON.parse(raw); await fetch('/__cqai/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}',credentials:'same-origin'}); callback(data.callback,true); }
  };
})();`
function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(value))
}
function validParent(origin: string): string {
  const parsed = new URL(origin)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('家庭智能嵌入入口只允许本机 DSH 窗口，请使用 http://127.0.0.1 打开宿主')
  return parsed.origin
}

/** A ticket-gated root-origin proxy preserves HA's routing, assets and WebSocket URLs. */
export class HomeGateway {
  private server?: Server
  private origin?: string
  private readonly cookie = `cqai_home_${randomBytes(8).toString('hex')}`
  private readonly tickets = new Map<string, Session>()
  private readonly sessions = new Map<string, Session>()
  private readonly sockets = new Set<Socket>()
  constructor(private readonly auth: () => HaAuth) {}
  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) reply(res, 502, { error: '家庭智能连接未完成，请检查运行状态' }); else res.destroy() }) })
    server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)) })
    server.on('upgrade', (req, socket, head) => {
      try {
      const session = this.session(req)
      if (!session || req.headers.origin !== this.origin || req.url !== '/api/websocket') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
      const target = new URL('/api/websocket', this.auth().baseUrl)
      const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { headers: upstreamHeaders(req, target) })
      upstream.on('upgrade', (response, remote, remoteHead) => {
        socket.write(`HTTP/1.1 ${response.statusCode ?? 101} Switching Protocols\r\n${Object.entries(response.headers).flatMap(([key, value]) => value === undefined ? [] : [`${key}: ${Array.isArray(value) ? value.join(', ') : value}`]).join('\r\n')}\r\n\r\n`)
        if (remoteHead.length) socket.write(remoteHead)
        if (head.length) remote.write(head)
        remote.pipe(socket); socket.pipe(remote)
        socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy()); socket.on('close', () => remote.destroy())
      })
      upstream.on('error', () => socket.destroy())
      upstream.on('response', () => socket.destroy())
      upstream.setTimeout(20_000, () => upstream.destroy())
      upstream.end()
      } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n') }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('家庭智能入口启动失败')
    this.origin = `http://127.0.0.1:${address.port}`
    this.server = server
  }
  async frame(parent: string): Promise<string> {
    await this.start()
    this.prune()
    const ticket = randomBytes(32).toString('base64url')
    this.tickets.set(ticket, { parent: validParent(parent), expires: Date.now() + 60_000 })
    return `${this.origin}/session/${ticket}`
  }
  private prune(): void {
    for (const map of [this.tickets, this.sessions]) for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key)
  }
  private session(req: IncomingMessage): Session | undefined {
    if (req.headers.host !== new URL(this.origin ?? 'http://127.0.0.1').host) return undefined
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${this.cookie}=`))?.slice(this.cookie.length + 1)
    const session = token ? this.sessions.get(token) : undefined
    if (!session || session.expires <= Date.now()) return undefined
    return session
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', this.origin).pathname
    if (req.headers.host !== new URL(this.origin!).host) return reply(res, 403, { error: '无效入口' })
    if (path.startsWith('/session/') && req.method === 'GET') {
      this.prune()
      const ticket = path.slice('/session/'.length)
      const session = this.tickets.get(ticket)
      this.tickets.delete(ticket)
      if (!session) return reply(res, 403, { error: '入口已过期，请在 DSH 中重新打开家庭智能' })
      const id = randomBytes(32).toString('base64url')
      this.sessions.set(id, { ...session, expires: Date.now() + sessionLifetime })
      res.writeHead(302, { location: '/?external_auth=1', 'set-cookie': `${this.cookie}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime / 1000}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return
    }
    const session = this.session(req)
    if (!session) return reply(res, 403, { error: '请从 DSH 家庭智能入口打开' })
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '') && req.headers.origin !== this.origin) return reply(res, 403, { error: '请求来源不正确' })
    if (path === '/__cqai/bridge.js' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' }); res.end(bridge); return
    }
    if (path === '/__cqai/auth' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) { body += String(chunk); if (body.length > 1024) return reply(res, 413, { error: '请求过大' }) }
      const force = Boolean((JSON.parse(body || '{}') as { force?: boolean }).force)
      return reply(res, 200, await this.auth().accessGrant(force))
    }
    if (path === '/__cqai/logout' && req.method === 'POST') {
      const id = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${this.cookie}=`))?.slice(this.cookie.length + 1)
      if (id) this.sessions.delete(id)
      res.setHeader('set-cookie', `${this.cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
      return reply(res, 200, { ok: true })
    }
    if (path.startsWith('/__cqai/') || path.startsWith('/session/')) return reply(res, 404, { error: '入口不存在' })
    await this.proxy(req, res, session)
  }
  private async proxy(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
    const target = new URL(this.auth().baseUrl)
    // Keep path bytes as received; never interpret a user path as an upstream URL.
    const upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)({ protocol: target.protocol, hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: upstreamHeaders(req, target) })
    await new Promise<void>((resolve, reject) => {
      upstream.on('response', response => {
        const headers = { ...response.headers }
        delete headers['x-frame-options']; delete headers['content-security-policy-report-only']
        const existingCsp = headers['content-security-policy']
        const csp = (Array.isArray(existingCsp) ? existingCsp.join('; ') : existingCsp ?? '').split(';').filter(value => !value.trim().startsWith('frame-ancestors')).join(';')
        headers['content-security-policy'] = `${csp ? `${csp}; ` : ''}frame-ancestors ${session.parent}`
        headers['referrer-policy'] = 'no-referrer'
        if (headers.location?.startsWith(target.origin)) headers.location = headers.location.replace(target.origin, this.origin!)
        const html = String(headers['content-type'] ?? '').includes('text/html') && req.method !== 'HEAD'
        if (html) {
          const chunks: Buffer[] = []; let bytes = 0
          response.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { response.destroy(); reject(new Error('HA 页面过大')); } else chunks.push(chunk) })
          response.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf8')
            body = body.replace(/<head([^>]*)>/i, '<head$1><script src="/__cqai/bridge.js"></script>')
            delete headers['content-length']; delete headers.etag; delete headers['content-encoding']; headers['cache-control'] = 'no-store'
            res.writeHead(response.statusCode ?? 502, headers); res.end(body); resolve()
          })
          response.on('error', reject)
        } else {
          res.writeHead(response.statusCode ?? 502, headers); response.pipe(res); response.on('end', resolve); response.on('error', reject)
        }
      })
      upstream.on('error', reject); upstream.setTimeout(60_000, () => upstream.destroy(new Error('HA 连接超时')))
      req.pipe(upstream)
    })
  }
  async stop(): Promise<void> {
    const server = this.server; this.server = undefined; this.origin = undefined; this.sessions.clear(); this.tickets.clear()
    for (const socket of this.sockets) socket.destroy()
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
