import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { SecretStore, type ManagedCredential } from './storage.js'
import type { HaEntity } from './protocol.js'

export interface AccessGrant { access_token: string; expires_in: number }
interface TokenReply extends AccessGrant { refresh_token?: string }
interface OnboardingStep { step: string; done: boolean }
export class HaRequestError extends Error {
  constructor(readonly status: number, readonly messageCode?: string) { super(`Home Assistant 请求失败 (HTTP ${status})${messageCode ? `：${messageCode}` : ''}`) }
}
export class HaOwnerRecoveryRequired extends Error {
  constructor() { super('本地账户已创建，正在恢复尚未完成的初始化步骤') }
}
export interface HaAuthOptions { onboardingTimeoutMs?: number }

export class HaAuth {
  private access?: { token: string; expires: number }
  private refreshing?: Promise<AccessGrant>
  constructor(readonly baseUrl: string, readonly store: SecretStore, readonly mode: 'managed' | 'external', private readonly options: HaAuthOptions = {}) {}

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
    let response: Response
    try { response = await fetch(new URL(path, this.baseUrl), { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }) }
    catch { throw new Error(`Home Assistant 请求未完成：${path.split('?')[0]}`) }
    if (!response.ok) {
      // HA messages can contain a username or echoed request data. Admit only
      // its fixed onboarding message codes, never the raw response body.
      let messageCode: string | undefined
      try { const value = await response.json() as { message_code?: unknown }; if (['username_already_exists', 'username_not_normalized'].includes(String(value.message_code))) messageCode = String(value.message_code) } catch {}
      const error = new HaRequestError(response.status, messageCode)
      error.message = `Home Assistant 请求失败：${path.split('?')[0]} (HTTP ${response.status})${messageCode ? `：${messageCode}` : ''}`
      throw error
    }
    return await response.json() as T
  }
  private async exchange(form: Record<string, string>): Promise<AccessGrant> {
    const token = await this.request<TokenReply>('/auth/token', { method: 'POST', body: new URLSearchParams(form) })
    if (!token.access_token || !Number.isFinite(token.expires_in)) throw new Error('Home Assistant 返回了无效认证结果')
    if (token.refresh_token) {
      await this.store.update(secrets => {
        if (!secrets.managed) throw new Error('本地账户状态缺失')
        secrets.managed.refreshToken = token.refresh_token
        return secrets
      })
    }
    this.access = { token: token.access_token, expires: Date.now() + token.expires_in * 1000 }
    return { access_token: token.access_token, expires_in: token.expires_in }
  }
  async accessGrant(force = false): Promise<AccessGrant> {
    if (this.mode === 'external') {
      const token = (await this.store.read()).externalToken
      if (!token) throw new Error('请在设置中配置外部 Home Assistant 的访问令牌')
      return { access_token: token, expires_in: 1800 }
    }
    if (!force && this.access && this.access.expires > Date.now() + 60_000) return { access_token: this.access.token, expires_in: Math.floor((this.access.expires - Date.now()) / 1000) }
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const saved = (await this.store.read()).managed
      if (!saved?.refreshToken) throw new Error('本地授权尚未完成')
      return this.exchange({ grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: saved.clientId })
    })()
    try { return await this.refreshing } finally { this.refreshing = undefined }
  }
  invalidate(): void { this.access = undefined }

  private async login(saved: ManagedCredential): Promise<void> {
    const flow = await this.request<{ flow_id: string }>('/auth/login_flow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: saved.clientId, handler: ['homeassistant', null], redirect_uri: saved.clientId }) })
    const result = await this.request<{ type: string; result?: string }>(`/auth/login_flow/${encodeURIComponent(flow.flow_id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: saved.clientId, username: saved.username, password: saved.password }) })
    if (result.type !== 'create_entry' || !result.result) throw new Error('托管账户登录失败，请恢复认证备份或在 HA 中重新授权')
    await this.exchange({ grant_type: 'authorization_code', code: result.result, client_id: saved.clientId })
  }
  private async confirmHttp(): Promise<void> {
    const http = await this.command<{ active_config_type: string; pending: { server_port?: number; server_host?: string | string[] } | null }>({ type: 'http/config' })
    if (http.active_config_type === 'pending' && http.pending) {
      const hosts = Array.isArray(http.pending.server_host) ? http.pending.server_host : [http.pending.server_host]
      if (http.pending.server_port !== Number(new URL(this.baseUrl).port) || hosts.some(host => host !== '127.0.0.1')) throw new Error('HA HTTP 设置与插件管理的本机地址不一致，请查看 HA 网络设置')
      await this.command({ type: 'http/config/promote' })
    }
  }
  private async waitRunning(): Promise<void> {
    const deadline = Date.now() + 600_000
    while (Date.now() < deadline) {
      const core = await this.api<{ state: string }>('/api/core/state')
      if (core.state === 'RUNNING') return
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('Home Assistant 核心启动尚未完成，请查看诊断后重试')
  }

  /** Owns only a fresh managed installation; never creates an account in external mode. */
  async initialize(familyName: string): Promise<void> {
    if (this.mode === 'external') { await this.api('/api/'); return }
    let steps: OnboardingStep[]
    try { steps = await this.request<OnboardingStep[]>('/api/onboarding') }
    catch (error) {
      if (String(error).includes('HTTP 404')) steps = []
      else throw error
    }
    const secrets = await this.store.read()
    const userPending = steps.some(step => step.step === 'user' && !step.done)
    if (!secrets.managed) {
      if (!userPending) throw new Error('已有 HA 账户但本插件的托管认证缺失。请恢复备份，或在外部模式手动连接；插件不会覆盖已有账户。')
      secrets.managed = { username: `cqai_${randomBytes(6).toString('hex')}`, password: randomBytes(32).toString('base64url'), clientId: 'http://127.0.0.1/' }
      // Persist before HA creates the account so an interrupted first run is recoverable.
      await this.store.write(secrets)
    }
    const saved = secrets.managed
    if (userPending) {
      try {
      const reply = await this.request<{ auth_code: string }>('/api/onboarding/users', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: familyName, username: saved.username, password: saved.password, client_id: saved.clientId, language: 'zh-Hans' }),
      }, this.options.onboardingTimeoutMs ?? 600_000)
      await this.exchange({ grant_type: 'authorization_code', code: reply.auth_code, client_id: saved.clientId })
      } catch (error) {
        const duplicate = error instanceof HaRequestError && error.status === 400 && error.messageCode === 'username_already_exists'
        const interrupted = !(error instanceof HaRequestError) && error instanceof Error && error.message.startsWith('Home Assistant 请求未完成：/api/onboarding/users')
        if (!duplicate && !interrupted) throw error
        // Prove ownership with the already saved password before requesting a
        // restart. HA itself repairs user-step state on its next startup.
        await this.login(saved)
        const user = await this.command<{ is_owner?: boolean }>({ type: 'auth/current_user' })
        if (user.is_owner !== true) throw error
        await this.confirmHttp()
        await this.waitRunning()
        throw new HaOwnerRecoveryRequired()
      }
    } else {
      try { await this.accessGrant() }
      catch {
        // Recover a first run interrupted between account creation and code exchange.
        await this.login(saved)
      }
    }
    for (const step of steps) {
      if (step.done || step.step === 'user') continue
      const body = step.step === 'integration' ? { client_id: saved.clientId, redirect_uri: saved.clientId } : {}
      if (!['core_config', 'analytics', 'integration'].includes(step.step)) throw new Error(`需要处理新的 Home Assistant 初始化步骤：${step.step}`)
      await this.api(`/api/onboarding/${step.step}`, { method: 'POST', body: JSON.stringify(body) })
    }
    await this.api('/api/')
    // HA 2026.8+ imports YAML HTTP settings as a timed trial; confirm our
    // authenticated, working loopback listener using its public admin API.
    await this.confirmHttp()
    // HTTP binds before the core finishes startup and installs signal handlers.
    // Waiting here also makes immediate backup/stop flush HA's auth and recorder.
    await this.waitRunning()
  }
  async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const grant = await this.accessGrant()
    return this.request<T>(path, { ...init, headers: { 'content-type': 'application/json', ...init.headers, authorization: `Bearer ${grant.access_token}` } })
  }
  async entities(): Promise<HaEntity[]> { return this.api<HaEntity[]>('/api/states') }
  async state(entity: string): Promise<HaEntity> {
    if (!/^[a-z_]+\.[a-z0-9_]+$/.test(entity)) throw new Error('实体 ID 格式不正确')
    return this.api<HaEntity>(`/api/states/${encodeURIComponent(entity)}`)
  }
  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> {
    if (!/^[a-z_]+$/.test(domain) || !/^[a-z_]+$/.test(service)) throw new Error('服务名称格式不正确')
    return this.api(`/api/services/${domain}/${service}`, { method: 'POST', body: JSON.stringify(data) })
  }
  async command<T = unknown>(command: Record<string, unknown>): Promise<T> {
    const grant = await this.accessGrant()
    const url = new URL('/api/websocket', this.baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return new Promise<T>((resolve, reject) => {
      const socket = new WebSocket(url)
      const timer = setTimeout(() => finish(new Error('HA WebSocket 请求超时')), 20_000)
      let done = false
      const finish = (error?: Error, value?: T) => { if (done) return; done = true; clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(value as T) }
      socket.on('error', () => finish(new Error('HA WebSocket 连接失败')))
      socket.on('close', () => { if (!done) finish(new Error('HA WebSocket 提前关闭')) })
      socket.on('message', raw => {
        try {
          const message = JSON.parse(String(raw))
          if (message.type === 'auth_required') socket.send(JSON.stringify({ type: 'auth', access_token: grant.access_token }))
          else if (message.type === 'auth_ok') socket.send(JSON.stringify({ ...command, id: 1 }))
          else if (message.type === 'auth_invalid') finish(new Error('HA WebSocket 授权失败'))
          else if (message.type === 'result' && message.id === 1) message.success ? finish(undefined, message.result as T) : finish(new Error(`HA 命令失败：${message.error?.code ?? 'unknown'}`))
        } catch { finish(new Error('HA WebSocket 返回无效消息')) }
      })
    })
  }
}
