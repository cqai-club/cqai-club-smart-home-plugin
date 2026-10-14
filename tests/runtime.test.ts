import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DEFAULT_SETTINGS } from '../src/protocol.js'
import { RuntimeManager, isManagedHaReady } from '../src/runtime/index.js'
import { backupPath, copyPrivateTree, safeLogLine } from '../src/runtime/files.js'
import { managedSpawn, terminateProcess, pidAlive } from '../src/runtime/process.js'

const temporary: string[] = []
const make = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cqai-home-runtime-'))
  temporary.push(dataDir)
  return new RuntimeManager({ dataDir, settings: () => DEFAULT_SETTINGS, onEvent: () => {} })
}
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('managed snapshots', () => {
  it('backs up and restores HA auth plus plugin state as one snapshot', async () => {
    const manager = await make()
    await mkdir(join(manager.configDir, '.storage'), { recursive: true })
    await mkdir(manager.stateDir, { recursive: true })
    // Mark this test environment as belonging to the plugin before populating config.
    await writeFile(join(manager.dataDir, 'managed-runtime.json'), JSON.stringify({ schema: 1, owner: 'cqai-club-smart-home-plugin' }))
    await writeFile(join(manager.configDir, '.storage', 'auth'), 'ha-auth-before')
    await writeFile(join(manager.stateDir, 'backup-auth.json'), 'plugin-auth-before')
    const first = await manager.backup()
    expect(first.size).toBe(Buffer.byteLength('ha-auth-beforeplugin-auth-before'))
    await writeFile(join(manager.configDir, '.storage', 'auth'), 'ha-auth-after')
    await writeFile(join(manager.stateDir, 'backup-auth.json'), 'plugin-auth-after')
    await manager.restore(first.id)
    expect(await readFile(join(manager.configDir, '.storage', 'auth'), 'utf8')).toBe('ha-auth-before')
    expect(await readFile(join(manager.stateDir, 'backup-auth.json'), 'utf8')).toBe('plugin-auth-before')
    expect(await manager.listBackups()).toEqual([first])
    if (process.platform !== 'win32') {
      expect((await stat(manager.configDir)).mode & 0o777).toBe(0o700)
      expect((await stat(join(manager.stateDir, 'backup-auth.json'))).mode & 0o777).toBe(0o600)
    }
  })

  it('serializes overlapping snapshots and excludes pending backup folders', async () => {
    const manager = await make()
    const [one, two] = await Promise.all([manager.backup(), manager.backup()])
    expect(one.id).not.toBe(two.id)
    expect((await manager.listBackups()).length).toBe(2)
    expect((await readdir(manager.backupsDir)).some(id => id.startsWith('.pending'))).toBe(false)
  })

  it('rejects traversal and a malicious link before modifying current config', async () => {
    const manager = await make()
    const backup = await manager.backup()
    await writeFile(join(manager.configDir, 'keep.txt'), 'original')
    const external = join(manager.dataDir, 'private.txt')
    await writeFile(external, 'secret')
    await symlink(external, join(manager.backupsDir, backup.id, 'config', 'linked.txt'))
    await expect(manager.restore('../outside')).rejects.toThrow('无效备份编号')
    await expect(manager.restore(backup.id)).rejects.toThrow('符号链接')
    expect(await readFile(join(manager.configDir, 'keep.txt'), 'utf8')).toBe('original')
    expect((await manager.listBackups()).length).toBe(1)
  })

  it('refuses to adopt an existing unrelated HA configuration', async () => {
    const manager = await make()
    await mkdir(manager.configDir, { recursive: true })
    await writeFile(join(manager.configDir, 'configuration.yaml'), 'untouched')
    await expect(manager.backup()).rejects.toThrow('未由本插件管理')
    expect(await readFile(join(manager.configDir, 'configuration.yaml'), 'utf8')).toBe('untouched')
  })

  it('does not follow links while creating a private copy', async () => {
    const manager = await make()
    const source = join(manager.dataDir, 'source')
    await mkdir(source)
    await writeFile(join(manager.dataDir, 'outside.txt'), 'outside secret')
    await symlink(join(manager.dataDir, 'outside.txt'), join(source, 'outside'))
    await expect(copyPrivateTree(source, join(manager.dataDir, 'copy'))).rejects.toThrow('符号链接')
    expect(backupPath('/private/backups', '20261014T110000-abcdef0123456789')).toBe('/private/backups/20261014T110000-abcdef0123456789')
  })

  it('honors a live cross-process instance lock', async () => {
    const manager = await make()
    await manager.backup()
    await writeFile(join(manager.dataDir, 'runtime.lock'), JSON.stringify({ ownerPid: process.pid }))
    await expect(manager.backup()).rejects.toThrow('其他进程')
  })

  it('a new manager rejects an occupied persisted port without overwriting YAML', async () => {
    const manager = await make()
    await manager.backup()
    await writeFile(join(manager.configDir, 'configuration.yaml'), 'custom_setting: preserved\n')
    const server = createServer((_request, response) => response.end('unrelated service'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    await writeFile(join(manager.stateDir, 'runtime-port.json'), JSON.stringify({ schema: 1, port: address.port }))
    const second = new RuntimeManager({ dataDir: manager.dataDir, settings: () => DEFAULT_SETTINGS, onEvent: () => {} })
    try {
      await expect(second.start()).rejects.toThrow('已被占用')
      expect(await readFile(join(manager.configDir, 'configuration.yaml'), 'utf8')).toBe('custom_setting: preserved\n')
      expect(await second.installed()).toBe(false)
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})

describe('private diagnostics and child shutdown', () => {
  it('cancels an in-flight installer when the owning plugin closes', async () => {
    const root = await make(); const executable = join(root.dataDir, 'fake-uv')
    await writeFile(executable, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync("installer-pid",String(process.pid));setInterval(()=>{},1000)\n')
    await chmod(executable, 0o700)
    const events: string[] = []
    const manager = new RuntimeManager({ dataDir: root.dataDir, settings: () => ({ ...DEFAULT_SETTINGS, uvPath: executable }), onEvent: event => { if (event.message) events.push(event.message) } })
    let earlyFailure: unknown
    const start = manager.start().then(() => undefined, error => { earlyFailure = error; return error })
    let pid: number | undefined
    try {
      for (let i = 0; i < 200; i++) {
        try { const value = Number(await readFile(join(root.dataDir, 'installer-pid'), 'utf8')); if (value > 0) { pid = value; break } } catch {}
        if (earlyFailure) throw earlyFailure
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      if (!pid) throw new Error(`安装器未进入等待阶段：${events.join(' / ')}`)
      expect(pidAlive(pid)).toBe(true)
      await manager.cancelForShutdown()
      expect(await start).toBeInstanceOf(Error)
      expect(pidAlive(pid)).toBe(false)
      expect(await manager.installed()).toBe(false)
    } finally { await manager.cancelForShutdown(); await start; await manager.stop() }
  })
  it('runs its bundled uv without requiring an installed system uv or package postinstall', async () => {
    const manager = await make()
    const result = await manager.diagnose()
    expect(result.checks.find(check => check.name === 'uv 安装器')?.ok).toBe(true)
    const binary = join(manager.dataDir, 'tools', process.platform === 'win32' ? 'uv.exe' : 'uv')
    expect((await stat(binary)).isFile()).toBe(true)
    if (process.platform !== 'win32') expect((await stat(binary)).mode & 0o777).toBe(0o700)
  })
  it('recognizes a completed HA onboarding without a Server header', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      response.setHeader('Server', '')
      if (request.url === '/api/onboarding') { response.writeHead(404); response.end('{"message":"Not found"}') }
      else { response.writeHead(401); response.end('{"message":"Unauthorized"}') }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    try { expect(await isManagedHaReady(`http://127.0.0.1:${address.port}`)).toBe(true) }
    finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })

  it('redacts common credentials before writing process output', () => {
    const redacted = safeLogLine('Bearer abc access_token="def" refresh_token=ghi password:jkl https://user:pass@example.com')
    for (const secret of ['abc', 'def', 'ghi', 'jkl', 'user:pass']) expect(redacted).not.toContain(secret)
    expect(redacted).toContain('[redacted]')
  })

  it('terminates a child that ignores graceful termination', async () => {
    const child = managedSpawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'], { cwd: tmpdir(), env: process.env })
    await new Promise<void>((resolve, reject) => { child.stdout?.once('data', () => resolve()); child.once('error', reject) })
    await terminateProcess(child, 50)
    expect(child.signalCode).toBe('SIGKILL')
  })

  it('returns safely for an executable that could not spawn', async () => {
    const child = managedSpawn('/does-not-exist', [], { cwd: tmpdir(), env: process.env })
    await new Promise<void>(resolve => child.once('error', () => resolve()))
    await expect(terminateProcess(child)).resolves.toBeUndefined()
  })
})
