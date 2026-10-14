import { API_PREFIX, type HomeDiagnostic, type HomeSettings, type HomeStatus, type RepairAction } from '../protocol'

export type SettingsPatch = Partial<HomeSettings> & { externalToken?: string }
export type HomeFetcher = (input: string, init?: RequestInit) => Promise<Response>

export class HomeApi {
  constructor(private readonly fetcher: HomeFetcher = (input, init) => fetch(input, init)) {}

  private async request<T>(path: string, body?: unknown, timeoutMs = body === undefined ? 15_000 : 900_000): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await this.fetcher(`${API_PREFIX}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const text = await response.text()
      let value: unknown
      try { value = text ? JSON.parse(text) : undefined } catch { throw new Error(`家庭服务返回了无法读取的响应（HTTP ${response.status}）`) }
      if (!response.ok) {
        const detail = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
          ? value.error : `家庭服务请求失败（HTTP ${response.status}）`
        throw new Error(detail)
      }
      return value as T
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('家庭服务响应超时，请刷新运行状态后重试。')
      if (error instanceof TypeError) throw new Error('无法连接家庭服务，请检查 e宝工坊是否仍在运行。')
      throw error
    } finally { clearTimeout(timer) }
  }

  status(): Promise<HomeStatus> { return this.request('/status') }
  start(): Promise<unknown> { return this.request('/start', {}) }
  stop(): Promise<unknown> { return this.request('/stop', {}) }
  repair(action: RepairAction): Promise<unknown> { return this.request('/repair', { action }) }
  diagnose(): Promise<HomeDiagnostic> { return this.request('/diagnose') }
  backup(): Promise<unknown> { return this.request('/backup', {}) }
  restore(id: string): Promise<unknown> { return this.request('/restore', { id }) }
  settings(patch: SettingsPatch): Promise<unknown> { return this.request('/settings', { patch }) }
  frame(): Promise<{ url: string }> { return this.request('/frame', {}, 15_000) }
}

/** Admit the Host gateway or its constrained loopback ticket handoff, never a remote credential URL. */
export function frameUrl(input: string, origin: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('家庭服务没有返回可用的界面地址。')
  const url = new URL(input, origin)
  if (url.username || url.password) throw new Error('家庭界面的连接地址不属于当前 e宝工坊。')
  const sameOrigin = url.origin === origin && ['http:', 'https:'].includes(url.protocol)
  const loopbackTicket = url.protocol === 'http:' && url.hostname === '127.0.0.1'
    && /^\d+$/.test(url.port) && Number(url.port) > 0 && Number(url.port) <= 65535
    && /^\/session\/[A-Za-z0-9_-]{43}$/.test(url.pathname) && !url.search && !url.hash
  if (!sameOrigin && !loopbackTicket) throw new Error('家庭界面的连接地址不属于当前 e宝工坊。')
  return url.href
}

export function settingsPatch(settings: HomeSettings, externalToken: string): SettingsPatch {
  return {
    mode: settings.mode, autoStart: settings.autoStart,
    haVersion: settings.haVersion, pythonVersion: settings.pythonVersion,
    familyName: settings.familyName.trim(), timezone: settings.timezone.trim(),
    externalBaseUrl: settings.externalBaseUrl.trim(), uvPath: settings.uvPath.trim(),
    ...(settings.mode === 'external' && externalToken.trim() ? { externalToken: externalToken.trim() } : {}),
  }
}

export function validateSettings(settings: HomeSettings): Partial<Record<keyof HomeSettings, string>> {
  const errors: Partial<Record<keyof HomeSettings, string>> = {}
  if (!settings.familyName.trim()) errors.familyName = '请输入家庭名称。'
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: settings.timezone.trim() }).format() } catch { errors.timezone = '请输入有效时区，例如 Asia/Shanghai。' }
  if (!/^\d{4}\.\d{1,2}\.\d+$/.test(settings.haVersion)) errors.haVersion = '请输入完整版本号，例如 2026.10.1。'
  if (!/^\d+\.\d+\.\d+$/.test(settings.pythonVersion)) errors.pythonVersion = '请输入完整 Python 版本号。'
  if (settings.mode === 'external') {
    try {
      const url = new URL(settings.externalBaseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    } catch { errors.externalBaseUrl = '请输入 HTTP 或 HTTPS 地址，不要包含密码、令牌或查询参数。' }
  }
  return errors
}
