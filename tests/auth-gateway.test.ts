import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { HaAuth, HaOwnerRecoveryRequired } from '../src/auth.js'
import { HomeGateway } from '../src/gateway.js'
import { SecretStore } from '../src/storage.js'
import { validateSettings } from '../src/controller.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function mockHa(options: { userDelayMs?: number; ownerIsOwner?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cqai-home-auth-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const store = new SecretStore(dir)
  let owner: { username: string; password: string } | undefined
  let tokenCounter = 0
  let creations = 0
  const completed = new Set<string>()
  const steps = ['user', 'core_config', 'integration', 'analytics']
  const calls: string[] = []
  const server = createServer(async (req, res) => {
    const path = req.url!
    calls.push(path)
    let data = ''; for await (const chunk of req) data += String(chunk)
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (path === '/api/onboarding') return send(200, steps.map(step => ({ step, done: completed.has(step) })))
    if (path === '/api/onboarding/users') {
      if (owner) return send(400, { message_code: 'username_already_exists', message: 'private-username-and-password-never-echo' })
      owner = JSON.parse(data); creations++
      // Regression: account credentials must already be durably saved at this point.
      expect((await store.read()).managed?.password).toBe(owner!.password)
      if (options.userDelayMs) await new Promise(resolve => setTimeout(resolve, options.userDelayMs))
      if (res.destroyed) return
      completed.add('user')
      return send(200, { auth_code: 'code' })
    }
    if (path === '/auth/token') {
      const form = new URLSearchParams(data)
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') !== 'refresh-private') return send(400, { error: 'invalid_grant' })
      return send(200, { access_token: `access-${++tokenCounter}`, refresh_token: form.get('grant_type') === 'authorization_code' ? 'refresh-private' : undefined, expires_in: 1800 })
    }
    if (path === '/auth/login_flow') return send(200, { flow_id: 'flow' })
    if (path === '/auth/login_flow/flow') { expect(JSON.parse(data).password).toBe(owner?.password); return send(200, { type: 'create_entry', result: 'code' }) }
    if (path.startsWith('/api/onboarding/')) { expect(req.headers.authorization).toMatch(/^Bearer access-/); completed.add(path.split('/').at(-1)!); return send(200, {}) }
    if (path === '/' || path.startsWith('/?') || path === '/config/devices/dashboard') {
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "script-src 'self'; frame-ancestors 'self'" }); res.end('<!doctype html><html><head></head><body><home-assistant></home-assistant></body></html>'); return
    }
    if (path === '/api/') return send(200, { message: 'API running.' })
    if (path === '/api/core/state') return send(200, { state: 'RUNNING' })
    if (path === '/api/states') return send(200, [{ entity_id: 'light.test', state: 'off', attributes: {} }])
    if (path === '/api/error') return send(401, { access_token: 'never-log-this' })
    return send(404, {})
  })
  const ws = new WebSocketServer({ server, path: '/api/websocket' })
  ws.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'auth_required' }))
    socket.on('message', raw => {
      const msg = JSON.parse(String(raw))
      if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'auth_ok' }))
      else socket.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: msg.type === 'http/config' ? { active_config_type: 'stable', pending: null } : msg.type === 'auth/current_user' ? { is_owner: options.ownerIsOwner ?? true } : { acknowledged: msg.type } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('server')
  cleanup.push(async () => { for (const socket of ws.clients) socket.terminate(); ws.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const auth = new HaAuth(`http://127.0.0.1:${address.port}`, store, 'managed')
  return { store, auth, completed, calls, get tokens() { return tokenCounter }, get creations() { return creations } }
}
describe('managed authentication', () => {
  it('recovers an interrupted owner without generating another account or exposing the HA error body', async () => {
    const mock = await mockHa(); await mock.auth.initialize('测试家')
    mock.completed.delete('user')
    const original = await mock.store.read(); delete original.managed!.refreshToken; await mock.store.write(original)
    const resumed = new HaAuth(mock.auth.baseUrl, mock.store, 'managed')
    await expect(resumed.initialize('测试家')).rejects.toBeInstanceOf(HaOwnerRecoveryRequired)
    expect((await mock.store.read()).managed?.username).toBe(original.managed?.username)
    expect((await mock.store.read()).managed?.password).toBe(original.managed?.password)
    expect(mock.creations).toBe(1)
    // Official HA startup recognizes its existing owner and marks user done.
    mock.completed.add('user')
    await new HaAuth(mock.auth.baseUrl, mock.store, 'managed').initialize('测试家')
    expect(mock.creations).toBe(1)
    expect([...mock.completed].sort()).toEqual(['analytics', 'core_config', 'integration', 'user'])
  })
  it('recovers when a disconnected creation request leaves the owner before user-step completion', async () => {
    const mock = await mockHa({ userDelayMs: 80 })
    const interrupted = new HaAuth(mock.auth.baseUrl, mock.store, 'managed', { onboardingTimeoutMs: 30 })
    await expect(interrupted.initialize('测试家')).rejects.toBeInstanceOf(HaOwnerRecoveryRequired)
    expect(mock.completed.has('user')).toBe(false)
    expect(mock.creations).toBe(1)
    mock.completed.add('user')
    await new HaAuth(mock.auth.baseUrl, mock.store, 'managed').initialize('测试家')
    expect(mock.creations).toBe(1)
  })
  it('does not request owner recovery when stored credentials authenticate a non-owner', async () => {
    const mock = await mockHa({ ownerIsOwner: false }); await mock.auth.initialize('测试家'); mock.completed.delete('user')
    const auth = new HaAuth(mock.auth.baseUrl, mock.store, 'managed')
    await expect(auth.initialize('测试家')).rejects.toThrow('username_already_exists')
    await expect(auth.initialize('测试家')).rejects.not.toThrow('private-username-and-password-never-echo')
    expect(mock.creations).toBe(1)
  })
  it('creates durable account and finishes every official onboarding step without user tokens', async () => {
    const mock = await mockHa(); await mock.auth.initialize('我的测试家')
    expect([...mock.completed].sort()).toEqual(['analytics', 'core_config', 'integration', 'user'])
    expect((await mock.store.read()).managed?.refreshToken).toBe('refresh-private')
    expect((await stat(join(mock.store.stateDir, 'secrets.json'))).mode & 0o777).toBe(0o600)
    expect((await mock.auth.entities())[0]?.entity_id).toBe('light.test')
    expect(await mock.auth.command({ type: 'get_config' })).toEqual({ acknowledged: 'get_config' })
  })
  it('resumes after account creation when token exchange was interrupted', async () => {
    const mock = await mockHa(); await mock.auth.initialize('测试家')
    const secrets = await mock.store.read(); delete secrets.managed!.refreshToken; await mock.store.write(secrets)
    const recovered = new HaAuth(mock.auth.baseUrl, mock.store, 'managed'); await recovered.initialize('测试家')
    expect(mock.calls.filter(v => v === '/api/onboarding/users')).toHaveLength(1)
    expect(mock.calls).toContain('/auth/login_flow/flow')
  })
  it('serializes refresh requests and suppresses secret-bearing upstream errors', async () => {
    const mock = await mockHa(); await mock.auth.initialize('测试家'); const before = mock.tokens
    await Promise.all([mock.auth.accessGrant(true), mock.auth.accessGrant(true), mock.auth.accessGrant(true)])
    expect(mock.tokens).toBe(before + 1)
    await expect(mock.auth.api('/api/error')).rejects.toThrow('HTTP 401')
    await expect(mock.auth.api('/api/error')).rejects.not.toThrow('never-log-this')
  })
  it('never onboards an external HA', async () => {
    const mock = await mockHa(); await mock.store.write({ externalToken: 'external-private' })
    await new HaAuth(mock.auth.baseUrl, mock.store, 'external').initialize('测试家')
    expect(mock.calls).toEqual(['/api/'])
  })
})
describe('root gateway', () => {
  it('requires one-use tickets, restricts origin and serves complete authenticated HA paths', async () => {
    const mock = await mockHa(); await mock.auth.initialize('测试家')
    const gateway = new HomeGateway(() => mock.auth); cleanup.push(() => gateway.stop())
    const frame = await gateway.frame('http://127.0.0.1:33221'); const origin = new URL(frame).origin
    expect((await fetch(origin)).status).toBe(403)
    const entry = await fetch(frame, { redirect: 'manual' }); expect(entry.status).toBe(302)
    const cookie = entry.headers.get('set-cookie')!.split(';')[0]!
    expect((await fetch(frame, { redirect: 'manual' })).status).toBe(403)
    const page = await fetch(`${origin}/config/devices/dashboard`, { headers: { cookie } })
    expect(page.headers.get('x-frame-options')).toBeNull()
    expect(page.headers.get('content-security-policy')).toBe("script-src 'self'; frame-ancestors http://127.0.0.1:33221")
    expect(await page.text()).toContain('src="/__cqai/bridge.js"')
    const request = { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin }, body: '{}' }
    const grant = await fetch(`${origin}/__cqai/auth`, request); expect((await grant.json() as Record<string, unknown>).access_token).toMatch(/^access-/)
    expect((await fetch(`${origin}/__cqai/auth`, { ...request, headers: { ...request.headers, origin: 'https://evil.example' } })).status).toBe(403)
    expect((await fetch(`${origin}/__cqai/auth`, { headers: { cookie } })).status).toBe(404)
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/websocket', { headers: { cookie, origin } })
    const message = await new Promise<string>((resolve, reject) => { ws.once('message', raw => { resolve(String(raw)); ws.close() }); ws.once('error', reject) })
    expect(JSON.parse(message).type).toBe('auth_required')
    await fetch(`${origin}/__cqai/logout`, request)
    expect((await fetch(origin, { headers: { cookie } })).status).toBe(403)
  })
  it('rejects nonlocal parent embedding', async () => {
    const mock = await mockHa(); const gateway = new HomeGateway(() => mock.auth); cleanup.push(() => gateway.stop())
    await expect(gateway.frame('https://evil.example')).rejects.toThrow('本机')
  })
  it('contains WebSocket reconnect failures while the managed runtime is unavailable', async () => {
    const mock = await mockHa(); let available = true
    const gateway = new HomeGateway(() => { if (!available) throw new Error('尚未就绪'); return mock.auth }); cleanup.push(() => gateway.stop())
    const frame = await gateway.frame('http://127.0.0.1:33221'); const origin = new URL(frame).origin
    const entry = await fetch(frame, { redirect: 'manual' }); const cookie = entry.headers.get('set-cookie')!.split(';')[0]!
    available = false
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/websocket', { headers: { cookie, origin } })
    const status = await new Promise<number>((resolve, reject) => { socket.on('unexpected-response', (_, response) => { resolve(response.statusCode!); response.resume(); socket.terminate() }); socket.on('error', () => {}); setTimeout(() => reject(new Error('missing failure response')), 1000).unref() })
    expect(status).toBe(503)
    expect((await fetch(origin)).status).toBe(403)
  })
})
describe('settings boundary', () => {
  it('rejects credentials in URLs, arbitrary fields and malformed package versions', () => {
    expect(() => validateSettings({ externalBaseUrl: 'https://user:password@example.com' })).toThrow()
    expect(() => validateSettings({ haVersion: 'latest; echo bad' })).toThrow()
    expect(() => validateSettings({ timezone: 'unknown' })).toThrow()
    expect(() => validateSettings({ autoStart: 'true' } as never)).toThrow()
    expect(validateSettings({ externalBaseUrl: 'http://localhost:8123/' })).toEqual({ externalBaseUrl: 'http://localhost:8123' })
  })
})
