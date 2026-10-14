import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { HaAuth, HaOwnerRecoveryRequired } from './auth.js'
import { HomeGateway } from './gateway.js'
import { RuntimeManager } from './runtime/index.js'
import { SecretStore, privateJson, readJson } from './storage.js'
import { DEFAULT_SETTINGS, type HomeController, type HomeDiagnostic, type HomeSettings, type HomeStatus, type RepairAction } from './protocol.js'

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : '家庭智能操作未完成').replace(/Bearer\s+[^\s]+/gi, 'Bearer [隐藏]').replace(/(password|refresh_token|access_token|token)["'\s:=]+[^\s,}]+/gi, '$1=[隐藏]').slice(0, 1500)
}
export function validateSettings(patch: Partial<HomeSettings>): Partial<HomeSettings> {
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS))
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`未知设置字段：${key}`)
  if (patch.mode !== undefined && !['managed', 'external'].includes(patch.mode)) throw new Error('连接模式不正确')
  if (patch.autoStart !== undefined && typeof patch.autoStart !== 'boolean') throw new Error('自动启动设置不正确')
  for (const key of ['familyName', 'timezone', 'haVersion', 'pythonVersion', 'uvPath', 'externalBaseUrl'] as const) if (patch[key] !== undefined && (typeof patch[key] !== 'string' || patch[key]!.length > 2048)) throw new Error(`设置字段格式不正确：${key}`)
  if (patch.familyName !== undefined && (!patch.familyName.trim() || patch.familyName.length > 80)) throw new Error('家庭名称请输入 1–80 个字符')
  if (patch.timezone !== undefined) { try { new Intl.DateTimeFormat('zh-CN', { timeZone: patch.timezone }) } catch { throw new Error('时区格式不正确，例如 Asia/Shanghai') } }
  if (patch.haVersion !== undefined && !/^20\d{2}\.\d{1,2}\.\d{1,2}$/.test(patch.haVersion)) throw new Error('HA 版本格式应为 2026.10.1')
  if (patch.pythonVersion !== undefined && !/^3\.(?:1[4-9]|[2-9]\d)\.\d+$/.test(patch.pythonVersion)) throw new Error('当前托管运行环境要求 Python 3.14 或更高版本')
  if (patch.externalBaseUrl) {
    const parsed = new URL(patch.externalBaseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('HA 地址应为 http(s)://主机:端口，不能包含密码、路径或查询参数')
    patch = { ...patch, externalBaseUrl: parsed.origin }
  }
  return patch
}

export class SmartHomeController implements HomeController {
  readonly store: SecretStore
  readonly runtime: RuntimeManager
  readonly gateway: HomeGateway
  private settings: HomeSettings
  private current: HomeStatus
  private auth?: HaAuth
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private closing?: Promise<void>
  private readonly stateDir: string
  constructor(readonly dataDir: string, initial: Partial<HomeSettings> = {}, provider?: CredentialProvider) {
    this.settings = { ...DEFAULT_SETTINGS, ...validateSettings(initial) }
    this.stateDir = join(dataDir, 'state')
    this.store = new SecretStore(this.stateDir, provider)
    this.current = { phase: 'idle', message: '准备家庭智能运行环境', settings: { ...this.settings, externalTokenConfigured: false }, logs: [], backups: [], installed: false }
    this.runtime = new RuntimeManager({ dataDir, settings: () => this.settings, onEvent: event => {
      if (event.phase) this.current.phase = event.phase
      if (event.message) this.current.message = event.message
      if (event.progress) this.current.progress = event.progress
      if (event.error) this.current.error = safeError(event.error)
      if (event.log) this.current.logs = [...this.current.logs.slice(-99), { ...event.log, message: safeError(event.log.message) }]
      if (event.restartRequested && !this.closed) void this.start().catch(() => {})
    } })
    this.gateway = new HomeGateway(() => this.requireAuth())
  }
  async initialize(): Promise<void> {
    const stored = await readJson<HomeSettings>(join(this.stateDir, 'settings.json'))
    if (stored) this.settings = { ...DEFAULT_SETTINGS, ...validateSettings(stored) }
    await this.refreshFacts()
    this.current.phase = 'stopped'; this.current.message = this.current.installed ? '家庭智能已安装，等待启动' : '首次启动将自动安装 Python 与 Home Assistant'
  }
  status(): HomeStatus { return structuredClone(this.current) }
  private async refreshFacts(): Promise<void> {
    this.current.installed = await this.runtime.installed()
    this.current.backups = await this.runtime.listBackups()
    this.current.settings = { ...this.settings, externalTokenConfigured: Boolean((await this.store.read()).externalToken) }
  }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(async () => {
      if (this.closed) throw new Error('插件已关闭')
      try { return await operation() }
      catch (error) {
        const message = safeError(error)
        if (this.current.phase === 'ready' && this.auth) this.current.logs = [...this.current.logs.slice(-99), { time: new Date().toISOString(), level: 'warn', message }]
        else { this.current.phase = 'error'; this.current.error = message; this.current.message = message }
        throw new Error(message)
      }
    })
    this.queue = next
    return next
  }
  private requireAuth(): HaAuth { if (!this.auth || this.current.phase !== 'ready') throw new Error('家庭智能尚未就绪，请先启动或查看诊断'); return this.auth }
  private async startInternal(): Promise<void> {
    if (this.auth && this.current.phase === 'ready') return
    this.current.error = undefined
    this.current.phase = 'starting'; this.current.message = '正在启动家庭智能'
    let baseUrl: string
    if (this.settings.mode === 'managed') {
      const runtime = await this.runtime.start(); baseUrl = runtime.baseUrl; this.current.runtimeVersion = runtime.version
    } else {
      if (!this.settings.externalBaseUrl) throw new Error('请在设置中填写外部 Home Assistant 地址')
      baseUrl = this.settings.externalBaseUrl
    }
    this.current.phase = 'authorizing'; this.current.message = '正在完成本地账户与自动授权'
    let auth = new HaAuth(baseUrl, this.store, this.settings.mode)
    try { await auth.initialize(this.settings.familyName) }
    catch (error) {
      if (!(error instanceof HaOwnerRecoveryRequired) || this.settings.mode !== 'managed') throw error
      this.current.message = '正在恢复首次初始化中断的本地账户'
      await this.runtime.stop()
      const recovered = await this.runtime.start()
      this.current.phase = 'authorizing'; this.current.message = '正在继续完成本地账户授权'
      auth = new HaAuth(recovered.baseUrl, this.store, 'managed')
      await auth.initialize(this.settings.familyName)
    }
    if (this.settings.mode === 'managed') {
      const pending = await readJson<Partial<HomeSettings>>(join(this.stateDir, 'pending-core.json'))
      if (pending) {
        validateSettings(pending)
        await auth.command({ type: 'config/core/update', ...(pending.familyName ? { location_name: pending.familyName } : {}), ...(pending.timezone ? { time_zone: pending.timezone } : {}) })
        await rm(join(this.stateDir, 'pending-core.json'), { force: true })
      }
    }
    this.auth = auth
    await this.gateway.start()
    await this.refreshFacts()
    this.current.phase = 'ready'; this.current.message = '家庭智能已就绪'; this.current.startedAt = new Date().toISOString(); this.current.progress = undefined
  }
  start(): Promise<void> { return this.run(() => this.startInternal()) }
  private async stopInternal(): Promise<void> {
    this.current.phase = 'stopping'; this.current.message = '正在停止家庭智能'
    await this.gateway.stop(); this.auth = undefined; await this.runtime.stop()
    this.current.phase = 'stopped'; this.current.message = '家庭智能已停止'; this.current.startedAt = undefined; this.current.progress = undefined
  }
  stop(): Promise<void> { return this.run(() => this.stopInternal()) }
  close(): Promise<void> {
    return this.closing ??= (async () => { this.closed = true; await this.runtime.cancelForShutdown?.(); await this.queue.catch(() => {}); await this.stopInternal() })()
  }
  frame(parent: string): Promise<string> { this.requireAuth(); return this.gateway.frame(parent) }
  repair(action: RepairAction): Promise<void> {
    return this.run(async () => {
      if (this.settings.mode !== 'managed') throw new Error('外部 HA 由其原环境管理，本插件只能诊断连接')
      if (!['restart', 'reinstall'].includes(action)) throw new Error('不支持的修复操作')
      await this.stopInternal()
      this.current.phase = 'repairing'; this.current.message = action === 'restart' ? '正在重启本地 HA' : '正在重建插件的 Python 环境，家庭配置会保留'
      if (action === 'reinstall') await this.runtime.reinstall()
      await this.startInternal()
    })
  }
  async diagnose(): Promise<HomeDiagnostic> {
    const runtime = this.settings.mode === 'managed' ? await this.runtime.diagnose() : { checks: [] }
    const checks = [...runtime.checks]
    checks.push({ name: '自动授权', ok: Boolean(this.auth && this.current.phase === 'ready'), detail: this.current.phase === 'ready' ? '账户授权已完成，凭证由插件托管' : '运行环境就绪后由插件完成授权' })
    if (this.auth) { try { await this.auth.api('/api/'); checks.push({ name: 'HA API', ok: true, detail: '已通过认证访问 HA API' }) } catch { checks.push({ name: 'HA API', ok: false, detail: '认证连接失败，请重启或检查外部凭证' }) } }
    return { phase: this.current.phase, mode: this.settings.mode, platform: process.platform, architecture: process.arch, expectedHaVersion: this.settings.haVersion, pythonVersion: this.settings.pythonVersion, installed: this.current.installed, error: this.current.error, checks, logs: this.status().logs, suggestedActions: this.current.phase === 'ready' ? ['在 Home Assistant 中添加品牌集成并完成配对'] : this.settings.mode === 'managed' ? ['重启本地 Home Assistant', '重建插件管理的 Python 环境', '从备份恢复家庭配置'] : ['检查 HA 地址和网络', '在设置中更新外部访问令牌'] }
  }
  backup(): ReturnType<HomeController['backup']> {
    return this.run(async () => {
      if (this.settings.mode !== 'managed') throw new Error('外部 HA 请在原安装环境进行备份')
      await privateJson(join(this.stateDir, 'settings.json'), this.settings)
      await this.store.prepareBackup()
      let result: Awaited<ReturnType<HomeController['backup']>> | undefined
      let failure: unknown
      try { result = await this.runtime.backup() } catch (error) { failure = error }
      try { await this.reconnect(); await this.refreshFacts() } catch (error) { failure ??= error }
      finally { await rm(this.store.backupPath, { force: true }) }
      if (failure) throw failure
      return result!
    })
  }
  restore(id: string): Promise<void> {
    return this.run(async () => {
      if (this.settings.mode !== 'managed') throw new Error('外部 HA 请在原安装环境进行恢复')
      if (!this.current.backups.some(backup => backup.id === id)) throw new Error('备份不存在或不可读取')
      const wasReady = this.current.phase === 'ready'
      const previous = { ...this.settings }; const previousSecrets = structuredClone(await this.store.read())
      await privateJson(join(this.stateDir, 'settings.json'), previous)
      await this.store.prepareBackup()
      let undo: string
      try { undo = (await this.runtime.backup()).id }
      catch (error) { await this.reconnect(); throw error }
      finally { await rm(this.store.backupPath, { force: true }) }
      try {
        await this.stopInternal()
        await this.runtime.restore(id)
        const restored = await readJson<HomeSettings>(join(this.stateDir, 'settings.json'))
        if (restored) this.settings = { ...DEFAULT_SETTINGS, ...validateSettings(restored) }
        await this.store.restoreBackup()
        await rm(this.store.backupPath, { force: true })
        await this.refreshFacts()
        if (wasReady) await this.startInternal()
        else { this.current.phase = 'stopped'; this.current.message = '配置已恢复，启动后即可使用' }
      } catch (error) {
        this.settings = previous
        try {
          await this.stopInternal(); await this.runtime.restore(undo)
          await this.store.write(previousSecrets); await privateJson(join(this.stateDir, 'settings.json'), previous)
          await rm(this.store.backupPath, { force: true }); await this.refreshFacts()
          if (wasReady) await this.startInternal()
        } catch { throw new Error(`${safeError(error)}；自动恢复未完成，原配置仍保存在备份 ${undo}`) }
        throw new Error(`${safeError(error)}；已自动恢复操作前的家庭配置`)
      }
    })
  }
  private async reconnect(): Promise<void> {
    if (!this.auth) return
    const baseUrl = this.runtime.baseUrl
    if (baseUrl) { this.auth = new HaAuth(baseUrl, this.store, 'managed'); await this.auth.initialize(this.settings.familyName); this.current.phase = 'ready'; this.current.message = '家庭智能已就绪' }
  }
  updateSettings(input: Partial<HomeSettings> & { externalToken?: string }): Promise<void> {
    return this.run(async () => {
      const { externalToken, ...plain } = input
      const patch = validateSettings(plain)
      if (externalToken !== undefined && (typeof externalToken !== 'string' || externalToken.length > 10_000)) throw new Error('访问令牌格式不正确')
      const previous = { ...this.settings }; const wasReady = this.current.phase === 'ready'
      const previousSecrets = structuredClone(await this.store.read())
      const previousPending = await readJson<Partial<HomeSettings>>(join(this.stateDir, 'pending-core.json'))
      const restart = patch.mode !== undefined && patch.mode !== previous.mode || patch.haVersion !== undefined && patch.haVersion !== previous.haVersion || patch.pythonVersion !== undefined && patch.pythonVersion !== previous.pythonVersion || patch.externalBaseUrl !== undefined && patch.externalBaseUrl !== previous.externalBaseUrl || patch.uvPath !== undefined && patch.uvPath !== previous.uvPath || externalToken !== undefined
      const rebuild = patch.haVersion !== undefined && patch.haVersion !== previous.haVersion || patch.pythonVersion !== undefined && patch.pythonVersion !== previous.pythonVersion
      let rollback: string | undefined
      if (rebuild && previous.mode === 'managed' && this.current.installed) {
        await privateJson(join(this.stateDir, 'settings.json'), previous)
        await this.store.prepareBackup()
        try { rollback = (await this.runtime.backup()).id }
        catch (error) { await this.reconnect(); throw error }
        finally { await rm(this.store.backupPath, { force: true }) }
      }
      try {
        if (restart) await this.stopInternal()
        this.settings = { ...previous, ...patch }
        if (this.settings.mode === 'managed' && (patch.familyName || patch.timezone)) await privateJson(join(this.stateDir, 'pending-core.json'), { ...previousPending, ...(patch.familyName ? { familyName: patch.familyName } : {}), ...(patch.timezone ? { timezone: patch.timezone } : {}) })
        if (externalToken !== undefined) { const secrets = structuredClone(previousSecrets); secrets.externalToken = externalToken || undefined; await this.store.write(secrets) }
        await privateJson(join(this.stateDir, 'settings.json'), this.settings)
        if (rebuild && this.settings.mode === 'managed') await this.runtime.reinstall()
        if (wasReady && restart) await this.startInternal()
        else if (wasReady && this.auth && this.settings.mode === 'managed' && (patch.familyName || patch.timezone)) {
          await this.auth.command({ type: 'config/core/update', ...(patch.familyName ? { location_name: patch.familyName } : {}), ...(patch.timezone ? { time_zone: patch.timezone } : {}) })
          await rm(join(this.stateDir, 'pending-core.json'), { force: true })
        }
      } catch (error) {
        this.settings = previous
        try {
          if (restart || rollback) await this.stopInternal()
          if (rollback) await this.runtime.restore(rollback)
          await this.store.write(previousSecrets)
          await privateJson(join(this.stateDir, 'settings.json'), previous)
          if (previousPending) await privateJson(join(this.stateDir, 'pending-core.json'), previousPending)
          else await rm(join(this.stateDir, 'pending-core.json'), { force: true })
          await rm(this.store.backupPath, { force: true })
          if (wasReady && restart) await this.startInternal()
          await this.refreshFacts()
        } catch { throw new Error(`${safeError(error)}；恢复原设置未完成，请查看诊断或恢复备份`) }
        throw new Error(`${safeError(error)}；已恢复原有设置`)
      }
      await this.refreshFacts()
    })
  }
  entities(): ReturnType<HomeController['entities']> { return this.requireAuth().entities() }
  state(id: string): ReturnType<HomeController['state']> { return this.requireAuth().state(id) }
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> { return this.requireAuth().callService(domain, service, data) }
}
