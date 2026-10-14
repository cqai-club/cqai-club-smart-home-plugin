import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { appendFile, chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { freemem, totalmem } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { HomeLog, HomePhase, HomeSettings } from '../protocol.js'
import { backupPath, copyPrivateTree, safeLogLine } from './files.js'
import { managedSpawn, pidAlive, sleep, terminateProcess } from './process.js'
import { HA_LAUNCHER } from './launcher.js'
import { migrateLegacyConfiguration, nativeConfiguration } from './configuration.js'

export interface RuntimeEvent { phase?: HomePhase; message?: string; log?: HomeLog; progress?: { step: string; detail?: string }; error?: string; restartRequested?: boolean }
export interface RuntimeBackup { id: string; createdAt: string; size: number }
export interface RuntimeManagerOptions { dataDir: string; settings: () => HomeSettings; onEvent: (event: RuntimeEvent) => void }
interface InstallManifest { schema: 1; haVersion: string; pythonVersion: string; installedAt: string }

export function eligibleExpiredHttpTrial(pending: unknown, managedPort: unknown, owned: boolean): boolean {
  if (!owned || !Number.isInteger(managedPort) || Number(managedPort) < 1024 || Number(managedPort) > 65535 || !pending || typeof pending !== 'object') return false
  const config = pending as { server_port?: number; server_host?: string[]; error?: string }
  return config.error === 'not_promoted' && config.server_port === managedPort && Array.isArray(config.server_host) && config.server_host.length === 1 && config.server_host[0] === '127.0.0.1'
}

const require = createRequire(import.meta.url)
const exists = async (path: string): Promise<boolean> => { try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

/** Call only for the loopback port owned by the live managed subprocess. HA hides Server. */
export async function isManagedHaReady(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/onboarding`, { signal: AbortSignal.timeout(2000) })
    if (response.ok) return Array.isArray(await response.json())
    if (response.status !== 404) return false
    const api = await fetch(`${baseUrl}/api/`, { signal: AbortSignal.timeout(2000) })
    if (api.status !== 401) return false
    const body = (await api.text()).trim()
    if (/^401:\s*Unauthorized$/i.test(body)) return true
    try { return /^Unauthorized$/i.test((JSON.parse(body) as { message?: string }).message ?? '') } catch { return false }
  } catch { return false }
}

/** Owns exactly one private HA environment. It never uses system Python or user HA config. */
export class RuntimeManager {
  readonly dataDir: string
  readonly configDir: string
  readonly stateDir: string
  readonly environmentDir: string
  readonly backupsDir: string
  readonly logsDir: string
  private readonly settings: () => HomeSettings
  private readonly onEvent: RuntimeManagerOptions['onEvent']
  private serial: Promise<unknown> = Promise.resolve()
  private child?: ChildProcess
  private runningUrl?: string
  private preferredPort?: number
  private ownedLock = false
  private intentionalStop = false
  private diagnostics: string[] = []
  private logWrite: Promise<unknown> = Promise.resolve()
  private lastError?: string
  private readonly commands = new Set<ChildProcess>()
  private cancelling = false

  constructor(options: RuntimeManagerOptions) {
    if (!isAbsolute(options.dataDir)) throw new Error('Runtime dataDir 必须为绝对路径')
    this.dataDir = resolve(options.dataDir)
    this.configDir = join(this.dataDir, 'config')
    this.stateDir = join(this.dataDir, 'state')
    this.environmentDir = join(this.dataDir, 'environment')
    this.backupsDir = join(this.dataDir, 'backups')
    this.logsDir = join(this.dataDir, 'logs')
    this.settings = options.settings
    this.onEvent = options.onEvent
  }

  get baseUrl(): string | undefined { return this.runningUrl }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work, work)
    this.serial = next.catch(() => undefined)
    return next
  }

  private event(event: RuntimeEvent): void {
    try { this.onEvent(event) } catch { /* observers do not own the runtime lifecycle */ }
  }

  private progress(step: string, detail: string, phase?: HomePhase): void {
    this.event({ phase, message: detail, progress: { step, detail }, log: { time: new Date().toISOString(), level: 'info', message: detail } })
  }

  private record(line: string, kind: 'install' | 'homeassistant'): void {
    const cleaned = safeLogLine(line.trim())
    if (!cleaned) return
    this.diagnostics.push(cleaned)
    if (this.diagnostics.length > 100) this.diagnostics.shift()
    // Raw device/integration output stays private; only curated progress reaches UI/models.
    this.logWrite = this.logWrite.then(() => appendFile(join(this.logsDir, `${kind}.log`), `${new Date().toISOString()} ${cleaned}\n`, { mode: 0o600 })).catch(() => undefined)
  }

  private capture(stream: Readable | null, kind: 'install' | 'homeassistant', output?: (text: string) => void): void {
    let pending = ''
    stream?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      output?.(text)
      pending += text
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) this.record(line, kind)
      if (pending.length > 64 * 1024) pending = '[oversize runtime output omitted]'
    })
    stream?.once('end', () => { if (pending) this.record(pending, kind) })
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (process.env[key]) env[key] = process.env[key]
    return {
      ...env, HOME: join(this.dataDir, 'home'), USERPROFILE: join(this.dataDir, 'home'),
      TMPDIR: join(this.dataDir, 'tmp'), TEMP: join(this.dataDir, 'tmp'), TMP: join(this.dataDir, 'tmp'),
      XDG_CACHE_HOME: join(this.dataDir, 'cache'), XDG_CONFIG_HOME: join(this.dataDir, 'home'),
      UV_CACHE_DIR: join(this.dataDir, 'cache', 'uv'), UV_PYTHON_INSTALL_DIR: join(this.dataDir, 'python'),
      UV_PYTHON_BIN_DIR: join(this.dataDir, 'python-bin'), UV_NO_CONFIG: '1', UV_NO_PROGRESS: '1',
      UV_LINK_MODE: 'copy', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
      TZ: this.settings().timezone, HA_DISABLE_LOG_FILE: '1',
    }
  }

  private async initialize(): Promise<void> {
    const marker = join(this.dataDir, 'managed-runtime.json')
    if (await exists(this.dataDir) && (await lstat(this.dataDir)).isSymbolicLink()) throw new Error('管理数据目录不能为符号链接')
    if (!await exists(marker) && await exists(this.configDir) && (await readdir(this.configDir)).length) throw new Error('目标目录已有未由本插件管理的 HA 配置；已拒绝修改')
    for (const dir of [this.dataDir, this.configDir, this.stateDir, this.backupsDir, this.logsDir, join(this.dataDir, 'tmp'), join(this.dataDir, 'home'), join(this.dataDir, 'cache')]) {
      if (await exists(dir) && (await lstat(dir)).isSymbolicLink()) throw new Error('管理子目录不能为符号链接')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await chmod(dir, 0o700)
    }
    if (!await exists(marker)) await writeFile(marker, JSON.stringify({ schema: 1, owner: 'cqai-club-smart-home-plugin' }), { flag: 'wx', mode: 0o600 })
    const owner = await json<{ owner?: string }>(marker)
    if (owner.owner !== 'cqai-club-smart-home-plugin') throw new Error('管理目录标记无效')
  }

  private async acquireLock(): Promise<void> {
    if (this.ownedLock) return
    const path = join(this.dataDir, 'runtime.lock')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const file = await open(path, 'wx', 0o600)
        await file.writeFile(JSON.stringify({ ownerPid: process.pid, createdAt: new Date().toISOString() }))
        await file.close()
        this.ownedLock = true
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const lock = await json<{ ownerPid?: number; runtimePid?: number }>(path).catch(() => { throw new Error('管理实例锁尚未完成或已损坏；请稍后重试并检查诊断') })
        if (pidAlive(lock.ownerPid) || pidAlive(lock.runtimePid)) throw new Error('此管理实例正在被其他进程使用；请先停止原实例')
        await rm(path, { force: true })
      }
    }
    throw new Error('无法取得管理实例锁')
  }

  private async releaseLock(): Promise<void> {
    if (!this.ownedLock) return
    this.ownedLock = false
    await rm(join(this.dataDir, 'runtime.lock'), { force: true })
  }

  private versions(): { haVersion: string; pythonVersion: string } {
    const { haVersion, pythonVersion } = this.settings()
    if (!/^\d{4}\.\d{1,2}\.\d+(?:b\d+)?$/.test(haVersion)) throw new Error('无效 Home Assistant 版本')
    if (!/^3\.\d{1,2}\.\d+$/.test(pythonVersion)) throw new Error('无效 Python 版本')
    return { haVersion, pythonVersion }
  }

  private pythonPath(environmentDir = this.environmentDir): string { return join(environmentDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') }

  private async uvPath(): Promise<string> {
    const custom = this.settings().uvPath.trim()
    if (custom) {
      if (!isAbsolute(custom)) throw new Error('自定义 uv 路径必须是绝对可执行文件路径')
      if (!(await stat(custom)).isFile()) throw new Error('自定义 uv 可执行文件不存在')
      return custom
    }
    try {
      // pnpm keeps optional platform packages next to the wrapper, not at the
      // plugin's top level. Resolve from that package's own dependency graph.
      const uvRequire = createRequire(require.resolve('@dataiku/uv/package.json'))
      const pkg = uvRequire.resolve(`@dataiku/uv-${process.platform}-${process.arch}/package.json`)
      const executable = join(dirname(pkg), 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv')
      if (await exists(executable)) {
        const tools = join(this.dataDir, 'tools')
        await mkdir(tools, { recursive: true, mode: 0o700 })
        if ((await lstat(tools)).isSymbolicLink()) throw new Error('管理工具目录不能为符号链接')
        const destination = join(tools, process.platform === 'win32' ? 'uv.exe' : 'uv')
        if (await exists(destination) && (await lstat(destination)).isSymbolicLink()) throw new Error('管理工具不能为符号链接')
        if (!await exists(destination)) {
          const temporary = `${destination}.${randomBytes(6).toString('hex')}.tmp`
          await copyFile(executable, temporary); await chmod(temporary, 0o700); await rename(temporary, destination)
        }
        await chmod(destination, 0o700)
        return destination
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error
      // A platform package may have been excluded by the installer.
    }
    try {
      const pkg = require.resolve('@dataiku/uv/package.json')
      const executable = join(dirname(pkg), process.platform === 'win32' ? 'uv.exe' : 'uv')
      if (await exists(executable)) return executable
    } catch { /* support a preinstalled system uv as the final fallback */ }
    return 'uv'
  }

  private async run(command: string, args: string[], timeoutMs = 20 * 60_000): Promise<string> {
    if (this.cancelling) throw new Error('插件关闭，已取消运行环境操作')
    const child = managedSpawn(command, args, { cwd: this.dataDir, env: this.env() })
    this.commands.add(child)
    let output = ''
    const consume = (text: string) => {
      output = (output + text).slice(-64 * 1024)
    }
    this.capture(child.stdout, 'install', consume)
    this.capture(child.stderr, 'install', consume)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<string>((resolvePromise, reject) => {
        timeout = setTimeout(() => { void terminateProcess(child, 5000); reject(new Error('安装步骤超时；可在诊断后重试')) }, timeoutMs)
        child.once('error', error => reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'uv/Python 可执行文件不可用；请在设置中指定 uv 路径' : '无法启动管理运行命令')))
        child.once('exit', (code, signal) => code === 0 ? resolvePromise(output) : reject(new Error(`管理命令执行失败（${signal ?? code ?? 'unknown'}）；详情保存在插件私有诊断日志`)))
      })
    } finally { this.commands.delete(child); if (timeout) clearTimeout(timeout) }
  }

  /** Shutdown-only cancellation, including an in-flight installer. */
  async cancelForShutdown(): Promise<void> {
    this.cancelling = true; this.intentionalStop = true
    await Promise.all([...this.commands, ...(this.child ? [this.child] : [])].map(child => terminateProcess(child)))
  }

  async installed(): Promise<boolean> {
    try {
      const manifest = await json<InstallManifest>(join(this.environmentDir, 'managed-install.json'))
      const versions = this.versions()
      return manifest.schema === 1 && manifest.haVersion === versions.haVersion && manifest.pythonVersion === versions.pythonVersion && await exists(this.pythonPath())
    } catch { return false }
  }

  private async install(force = false): Promise<void> {
    if (!force && await this.installed()) return
    const versions = this.versions()
    const uv = await this.uvPath()
    const stage = join(this.dataDir, `environment.install-${randomBytes(8).toString('hex')}`)
    const previous = join(this.dataDir, `environment.previous-${randomBytes(8).toString('hex')}`)
    this.progress('python', `准备 Python ${versions.pythonVersion}`, 'installing')
    await this.run(uv, ['python', 'install', versions.pythonVersion])
    try {
      await this.run(uv, ['venv', '--no-project', '--managed-python', '--relocatable', '--python', versions.pythonVersion, stage])
      this.progress('dependencies', `安装 Home Assistant ${versions.haVersion} 及匹配前端`, 'installing')
      await this.run(uv, ['pip', 'install', '--python', this.pythonPath(stage), `homeassistant==${versions.haVersion}`])
      this.progress('verify', '检查 Home Assistant 与 Python 运行环境', 'installing')
      const output = await this.run(this.pythonPath(stage), ['-c', 'import importlib.metadata,json,sys; print(json.dumps({"ha":importlib.metadata.version("homeassistant"),"python":".".join(map(str,sys.version_info[:3]))}))'])
      const verified = JSON.parse(output.trim().split('\n').at(-1) ?? '') as { ha: string; python: string }
      if (verified.ha !== versions.haVersion || verified.python !== versions.pythonVersion) throw new Error('运行环境版本校验失败')
      await writeFile(join(stage, 'managed-install.json'), JSON.stringify({ schema: 1, ...versions, installedAt: new Date().toISOString() }), { mode: 0o600 })
      if (await exists(this.environmentDir)) await rename(this.environmentDir, previous)
      try { await rename(stage, this.environmentDir) }
      catch (error) { if (await exists(previous)) await rename(previous, this.environmentDir); throw error }
      await rm(previous, { recursive: true, force: true })
    } catch (error) {
      await rm(stage, { recursive: true, force: true })
      throw error
    }
  }

  private async freePort(preferred?: number): Promise<number> {
    const server = createServer()
    try {
      await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(preferred ?? 0, '127.0.0.1', () => resolvePromise()) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('无法分配本机端口')
      return address.port
    } catch (error) {
      if (preferred && (error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`家庭服务端口 ${preferred} 已被占用；请停止冲突进程后重试`)
      throw error
    } finally { await new Promise<void>(resolvePromise => server.close(() => resolvePromise())) }
  }

  private async writeConfiguration(port: number): Promise<void> {
    const path = join(this.configDir, 'configuration.yaml')
    if (await exists(path)) {
      const original = await readFile(path, 'utf8')
      const migrated = migrateLegacyConfiguration(original)
      if (!migrated) return
      await writeFile(join(this.backupsDir, `configuration-before-native-${randomBytes(8).toString('hex')}.yaml`), original, { flag: 'wx', mode: 0o600 })
      const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(temporary, migrated, { mode: 0o600 }); await rename(temporary, path)
      this.progress('configuration', '已准备本机基础组件，原配置已单独备份')
      return
    }
    const settings = this.settings()
    try { new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone }) } catch { throw new Error('无效时区') }
    await writeFile(path, nativeConfiguration(settings, port), { mode: 0o600 })
  }

  private async configuredHttp(): Promise<{ port: number; loopback: boolean } | undefined> {
    const path = join(this.configDir, '.storage', 'http')
    if (!await exists(path)) return undefined
    const stored = await json<{ data?: { stable?: { server_port?: number; server_host?: string[] }; pending?: { server_port?: number; server_host?: string[]; error?: string | null } } }>(path)
    const pending = stored.data?.pending
    let retryExpired = false
    if (pending?.error) {
      const owned = (await json<{ owner?: string }>(join(this.dataDir, 'managed-runtime.json')).catch(() => ({} as { owner?: string }))).owner === 'cqai-club-smart-home-plugin'
      const persistent = await json<{ schema?: number; port?: number }>(join(this.stateDir, 'runtime-port.json')).catch(() => ({} as { schema?: number; port?: number }))
      retryExpired = persistent.schema === 1 && eligibleExpiredHttpTrial(pending, persistent.port, owned)
      if (!retryExpired) throw new Error('HA HTTP 试用配置失败且不匹配管理实例；请恢复原网络配置或备份后重试')
    }
    const http = pending && (!pending.error || retryExpired) ? pending : stored.data?.stable
    if (!http || !Number.isInteger(http.server_port)) return undefined
    return { port: Number(http.server_port), loopback: Array.isArray(http.server_host) && http.server_host.length === 1 && http.server_host[0] === '127.0.0.1' }
  }

  private async managedPort(): Promise<number> {
    const path = join(this.stateDir, 'runtime-port.json')
    const storedHttp = await this.configuredHttp()
    if (storedHttp && !storedHttp.loopback) throw new Error('HA HTTP 设置已改为非本机监听；请在 HA 网络设置恢复 127.0.0.1 后重试')
    if (await exists(path)) {
      const stored = await json<{ schema?: number; port?: number }>(path)
      if (stored.schema !== 1 || !Number.isInteger(stored.port) || Number(stored.port) < 1024 || Number(stored.port) > 65535) throw new Error('家庭服务端口记录无效；请运行诊断')
      if (storedHttp && storedHttp.port !== stored.port) throw new Error(`HA HTTP 端口已在界面中变更；请恢复管理端口 ${stored.port} 后重试`)
      return this.freePort(stored.port)
    }
    // Read HA's public HTTP configuration only to adopt pre-persistence plugin environments.
    // Never modify .storage; after authorization the controller confirms pending config via WS.
    let port = storedHttp?.port
    if (!port && await exists(join(this.configDir, 'configuration.yaml'))) {
      const contents = await readFile(join(this.configDir, 'configuration.yaml'), 'utf8')
      const configured = /\n\s+server_port:\s*(\d+)\s*(?:\n|$)/.exec(contents)
      if (contents.startsWith('# Managed by CQAI Club Smart Home;') && configured?.[1]) port = Number(configured[1])
    }
    port = await this.freePort(port)
    await writeFile(path, JSON.stringify({ schema: 1, port }), { flag: 'wx', mode: 0o600 })
    return port
  }

  async start(): Promise<{ baseUrl: string; version: string }> { return this.exclusive(() => this.startInternal()) }

  private async startInternal(): Promise<{ baseUrl: string; version: string }> {
    if (this.child && this.runningUrl && this.child.exitCode === null && this.child.signalCode === null) return { baseUrl: this.runningUrl, version: this.versions().haVersion }
    try {
      await this.initialize()
      await this.acquireLock()
      if (process.platform === 'win32') throw new Error('本机原生 HA 模式暂不支持 Windows；请使用外部 HA OS 实例')
      const port = await this.managedPort()
      this.preferredPort = port
      await this.install()
      if (this.cancelling) throw new Error('插件关闭，已取消 Home Assistant 启动')
      this.progress('start', '启动本机 Home Assistant', 'starting')
      const baseUrl = `http://127.0.0.1:${port}`
      await this.writeConfiguration(port)
      const launcher = join(this.dataDir, 'managed-ha-launcher.py')
      const temporaryLauncher = `${launcher}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(temporaryLauncher, HA_LAUNCHER, { mode: 0o600 }); await rename(temporaryLauncher, launcher)
      const child = managedSpawn(this.pythonPath(), [launcher, '--config', this.configDir, '--log-no-color'], { cwd: this.dataDir, env: { ...this.env(), CQAI_HOME_MANAGED_PORT: String(port) } })
      this.child = child
      this.intentionalStop = false
      await writeFile(join(this.dataDir, 'runtime.lock'), JSON.stringify({ ownerPid: process.pid, runtimePid: child.pid, createdAt: new Date().toISOString() }), { mode: 0o600 })
      let failed = false
      this.capture(child.stdout, 'homeassistant')
      this.capture(child.stderr, 'homeassistant')
      child.once('error', () => { failed = true })
      child.once('exit', (code, signal) => {
        failed = true
        if (this.child === child) {
          this.child = undefined
          this.runningUrl = undefined
          if (!this.intentionalStop) {
            if (code === 100) {
              void this.releaseLock().then(() => this.event({ phase: 'starting', message: 'Home Assistant 请求重新启动', restartRequested: true }))
              return
            }
            this.lastError = `Home Assistant 已退出（${signal ?? code ?? 'unknown'}）；请运行环境诊断`
            this.event({ phase: 'error', message: this.lastError, error: this.lastError })
            void this.releaseLock()
          }
        }
      })
      const deadline = Date.now() + 5 * 60_000
      let heartbeat = Date.now()
      while (Date.now() < deadline) {
        if (this.cancelling) throw new Error('插件关闭，已取消 Home Assistant 启动')
        if (failed) throw new Error('Home Assistant 启动失败；请查看插件私有诊断日志')
        if (await isManagedHaReady(baseUrl)) {
          this.runningUrl = baseUrl
          this.lastError = undefined
          this.progress('available', 'Home Assistant 已启动，正在准备家庭界面')
          return { baseUrl, version: this.versions().haVersion }
        }
        if (Date.now() - heartbeat > 15_000) { this.progress('start', '首次启动正在准备内置集成，请稍候', 'starting'); heartbeat = Date.now() }
        await sleep(500)
      }
      throw new Error('Home Assistant 启动超时；可能缺少集成依赖，请先查看诊断')
    } catch (error) {
      this.lastError = safeLogLine(error instanceof Error ? error.message : '启动失败')
      await this.stopInternal(false)
      this.event({ phase: 'error', message: this.lastError, error: this.lastError })
      throw error
    }
  }

  async stop(): Promise<void> { return this.exclusive(() => this.stopInternal()) }

  private async stopInternal(notify = true, release = true): Promise<void> {
    this.intentionalStop = true
    const child = this.child
    if (child && notify) this.progress('stop', '正在安全停止 Home Assistant', 'stopping')
    if (child) await terminateProcess(child)
    this.child = undefined
    this.runningUrl = undefined
    if (release) await this.releaseLock()
    await this.logWrite
    if (notify) this.event({ phase: 'stopped', message: 'Home Assistant 已停止' })
  }

  async diagnose(): Promise<{ checks: { name: string; ok: boolean; detail: string }[] }> {
    return this.exclusive(async () => {
      await this.initialize()
      const installed = await this.installed()
      const disk = await statfs(this.dataDir)
      const checks = [
        { name: '操作系统', ok: process.platform !== 'win32', detail: `${process.platform}/${process.arch}；原生 Python 安装由本插件维护，不属于 HA 官方支持安装方式` },
        { name: '架构', ok: ['arm64', 'x64'].includes(process.arch), detail: process.arch },
        { name: '内存', ok: totalmem() >= 2 * 1024 ** 3, detail: `总内存 ${(totalmem() / 1024 ** 3).toFixed(1)} GB，可用 ${(freemem() / 1024 ** 3).toFixed(1)} GB` },
        { name: '磁盘空间', ok: disk.bavail * disk.bsize >= 2 * 1024 ** 3, detail: `可用 ${(disk.bavail * disk.bsize / 1024 ** 3).toFixed(1)} GB` },
        { name: '独立环境', ok: installed, detail: installed ? `Home Assistant ${this.versions().haVersion} / Python ${this.versions().pythonVersion}` : '尚未安装或版本不匹配' },
        { name: '进程', ok: Boolean(this.child && this.runningUrl), detail: this.child && this.runningUrl ? '本插件管理的进程正在运行' : '当前未运行' },
      ]
      try {
        const persisted = await json<{ port: number }>(join(this.stateDir, 'runtime-port.json'))
        const http = await this.configuredHttp()
        checks.push({ name: 'HTTP 监听设置', ok: !http || (http.loopback && http.port === persisted.port), detail: http && (http.port !== persisted.port || !http.loopback) ? 'HA 网络设置与本插件管理端口不匹配；请恢复本机监听和管理端口' : `仅本机，管理端口 ${persisted.port}` })
      } catch { checks.push({ name: 'HTTP 监听设置', ok: false, detail: '端口尚未分配或记录异常' }) }
      try { await this.run(await this.uvPath(), ['--version'], 10_000); checks.push({ name: 'uv 安装器', ok: true, detail: '可执行' }) }
      catch { checks.push({ name: 'uv 安装器', ok: false, detail: '不可用，请指定 uv 路径或重新安装插件' }) }
      if (this.lastError) checks.push({ name: '最近运行结果', ok: false, detail: this.lastError })
      return { checks }
    })
  }

  async backup(): Promise<RuntimeBackup> {
    return this.exclusive(async () => {
      await this.initialize()
      const restart = Boolean(this.child && this.runningUrl)
      await this.stopInternal(false, false)
      await this.acquireLock()
      const id = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + randomBytes(8).toString('hex')
      const destination = backupPath(this.backupsDir, id)
      const stage = join(this.backupsDir, `.pending-${id}`)
      try {
        this.progress('backup', '正在备份家庭配置与授权信息')
        await mkdir(stage, { mode: 0o700 })
        let size = await copyPrivateTree(this.configDir, join(stage, 'config'))
        if (await exists(this.stateDir)) size += await copyPrivateTree(this.stateDir, join(stage, 'state'))
        const backup: RuntimeBackup = { id, createdAt: new Date().toISOString(), size }
        await writeFile(join(stage, 'backup.json'), JSON.stringify({ ...backup, schema: 1, haVersion: this.versions().haVersion, pythonVersion: this.versions().pythonVersion }), { mode: 0o600 })
        await rename(stage, destination)
        return backup
      } finally {
        await rm(stage, { recursive: true, force: true })
        await this.releaseLock()
        if (restart) await this.startInternal()
      }
    })
  }

  async listBackups(): Promise<RuntimeBackup[]> {
    if (!await exists(this.backupsDir)) return []
    const backups: RuntimeBackup[] = []
    for (const id of await readdir(this.backupsDir)) {
      if (!/^\d{8}T\d{6}-[a-f0-9]{16}$/.test(id)) continue
      const path = backupPath(this.backupsDir, id)
      if ((await lstat(path)).isSymbolicLink()) continue
      try {
        const backup = await json<RuntimeBackup & { schema: number }>(join(path, 'backup.json'))
        if (backup.schema === 1 && backup.id === id && Number.isFinite(backup.size) && backup.size >= 0 && Number.isFinite(Date.parse(backup.createdAt))) backups.push({ id, createdAt: backup.createdAt, size: backup.size })
      } catch { /* incomplete/corrupt backups are not offered for restore */ }
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async restore(id: string): Promise<void> {
    return this.exclusive(async () => {
      await this.initialize()
      const source = backupPath(this.backupsDir, id)
      if ((await lstat(source)).isSymbolicLink()) throw new Error('不能恢复符号链接备份')
      const metadata = await json<RuntimeBackup & { schema: number; haVersion?: string; pythonVersion?: string }>(join(source, 'backup.json'))
      if (metadata.schema !== 1 || metadata.id !== id) throw new Error('备份信息无效')
      const restart = Boolean(this.child && this.runningUrl)
      await this.stopInternal(false, false)
      await this.acquireLock()
      const transaction = join(this.dataDir, `.restore-${randomBytes(8).toString('hex')}`)
      let configMoved = false
      let stateMoved = false
      let applied = false
      try {
        this.progress('restore', '正在恢复家庭配置与授权信息')
        await mkdir(transaction, { mode: 0o700 })
        await copyPrivateTree(join(source, 'config'), join(transaction, 'config.new'))
        if (await exists(join(source, 'state'))) await copyPrivateTree(join(source, 'state'), join(transaction, 'state.new'))
        else await mkdir(join(transaction, 'state.new'), { mode: 0o700 })
        await rename(this.configDir, join(transaction, 'config.previous')); configMoved = true
        await rename(this.stateDir, join(transaction, 'state.previous')); stateMoved = true
        await rename(join(transaction, 'config.new'), this.configDir)
        await rename(join(transaction, 'state.new'), this.stateDir)
        applied = true
        if (restart) await this.startInternal()
      } catch (error) {
        await this.stopInternal(false, false)
        if (configMoved) { await rm(this.configDir, { recursive: true, force: true }); await rename(join(transaction, 'config.previous'), this.configDir) }
        if (stateMoved) { await rm(this.stateDir, { recursive: true, force: true }); await rename(join(transaction, 'state.previous'), this.stateDir) }
        if (restart) await this.startInternal().catch(() => undefined)
        throw error
      } finally {
        if (!this.child) await this.releaseLock()
        // Original snapshots survive failed copy/move until rollback has completed.
        if (applied || !await exists(join(transaction, 'config.previous'))) await rm(transaction, { recursive: true, force: true })
      }
    })
  }

  async reinstall(): Promise<void> {
    return this.exclusive(async () => {
      await this.initialize()
      const restart = Boolean(this.child && this.runningUrl)
      await this.stopInternal(false, false)
      await this.acquireLock()
      try {
        this.progress('reinstall', '正在修复独立运行环境，家庭数据会保留', 'repairing')
        await this.install(true)
      } finally {
        await this.releaseLock()
        if (restart) await this.startInternal()
      }
    })
  }
}
