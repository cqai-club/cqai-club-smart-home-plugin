import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HomeSettings } from '../src/protocol.js'
import type { RuntimeBackup, RuntimeManagerOptions } from '../src/runtime/index.js'
import { privateJson, type HomeSecrets, type ManagedCredential } from '../src/storage.js'

const factory = vi.hoisted(() => ({ create: undefined as undefined | ((options: RuntimeManagerOptions) => SnapshotRuntime) }))
vi.mock('../src/runtime/index.js', () => ({
  RuntimeManager: class {
    constructor(options: RuntimeManagerOptions) {
      if (!factory.create) throw new Error('Missing isolated runtime fixture')
      return factory.create(options)
    }
  },
}))
import { SmartHomeController } from '../src/controller.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const SELECTED_BACKUP = '20261014T010000-0000000000000001'
const originalOwner: ManagedCredential = { username: 'current_owner', password: 'current-private-password', clientId: 'http://127.0.0.1/', refreshToken: 'current-private-refresh' }
const backupOwner: ManagedCredential = { username: 'older_owner', password: 'older-private-password', clientId: 'http://127.0.0.1/', refreshToken: 'older-private-refresh' }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Fake process lifecycle only. Snapshots and controller credentials are real files. */
class SnapshotRuntime {
  readonly configDir: string
  readonly stateDir: string
  readonly backupsDir: string
  baseUrl?: string
  running = false
  starts = 0
  stops = 0
  backups = 0
  restores: string[] = []
  failBackupOnce = false
  beforeStart?: () => Promise<void>
  constructor(private readonly options: RuntimeManagerOptions, private readonly serverUrl: string) {
    this.configDir = join(options.dataDir, 'config')
    this.stateDir = join(options.dataDir, 'state')
    this.backupsDir = join(options.dataDir, 'backups')
  }
  async installed(): Promise<boolean> { return true }
  async start(): Promise<{ baseUrl: string; version: string }> {
    this.starts++
    this.options.onEvent({ phase: 'starting', message: 'Test HA process started' })
    if (this.beforeStart) { const barrier = this.beforeStart; this.beforeStart = undefined; await barrier() }
    this.running = true; this.baseUrl = this.serverUrl
    return { baseUrl: this.serverUrl, version: this.options.settings().haVersion }
  }
  async stop(): Promise<void> {
    this.stops++
    this.running = false; this.baseUrl = undefined
    this.options.onEvent({ phase: 'stopped', message: 'Test HA process stopped' })
  }
  async diagnose() { return { checks: [] } }
  async reinstall(): Promise<void> {}
  async listBackups(): Promise<RuntimeBackup[]> {
    const result: RuntimeBackup[] = []
    for (const id of await readdir(this.backupsDir)) result.push(JSON.parse(await readFile(join(this.backupsDir, id, 'backup.json'), 'utf8')) as RuntimeBackup)
    return result
  }
  async backup(): Promise<RuntimeBackup> {
    this.backups++
    const restart = this.running
    this.running = false; this.baseUrl = undefined
    try {
      if (this.failBackupOnce) { this.failBackupOnce = false; throw new Error('Snapshot write failed: simulated disk full') }
      const id = `20261014T020000-${this.backups.toString(16).padStart(16, '0')}`
      const destination = join(this.backupsDir, id)
      await mkdir(destination, { mode: 0o700 })
      await cp(this.configDir, join(destination, 'config'), { recursive: true })
      await cp(this.stateDir, join(destination, 'state'), { recursive: true })
      const snapshot: RuntimeBackup = { id, createdAt: '2026-10-14T02:00:00Z', size: 100 }
      await privateJson(join(destination, 'backup.json'), snapshot)
      return snapshot
    } finally {
      // Production RuntimeManager also restarts the old process after a failed copy.
      if (restart) await this.start()
    }
  }
  async restore(id: string): Promise<void> {
    this.restores.push(id)
    const source = join(this.backupsDir, id)
    await readFile(join(source, 'backup.json'), 'utf8')
    await rm(this.configDir, { recursive: true, force: true })
    await rm(this.stateDir, { recursive: true, force: true })
    await cp(join(source, 'config'), this.configDir, { recursive: true })
    await cp(join(source, 'state'), this.stateDir, { recursive: true })
  }
}

function memoryProvider() {
  let record: CredentialRecord | undefined
  let rejectOlderOwnerOnce = false
  const provider = {
    async readRecord() { return structuredClone(record) },
    async modifyRecord(_key: unknown, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const replacement = await mutate(structuredClone(record))
      if (rejectOlderOwnerOnce && replacement?.kind === 'grant' && (replacement.payload as HomeSecrets).managed?.username === backupOwner.username) {
        rejectOlderOwnerOnce = false
        throw new Error('Credential provider rejected imported grant')
      }
      if (replacement) record = structuredClone(replacement)
      return structuredClone(record)
    },
  } as unknown as CredentialProvider
  return { provider, failNextImportedGrant() { rejectOlderOwnerOnce = true } }
}

async function fixture(options: { badSettings?: 'json' | 'schema'; provider?: CredentialProvider } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cqai-home-transactions-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  for (const name of ['config', 'state', 'backups']) await mkdir(join(directory, name), { mode: 0o700 })
  const settings: HomeSettings = { ...DEFAULT_SETTINGS, autoStart: false, familyName: '正在使用的家' }
  await privateJson(join(directory, 'config', 'ha-owner.json'), originalOwner)
  await writeFile(join(directory, 'config', 'home-assistant_v2.db'), 'LATEST FAMILY HISTORY', { mode: 0o600 })
  await privateJson(join(directory, 'state', 'settings.json'), settings)
  await privateJson(join(directory, 'state', 'preferences.json'), { layout: 'LATEST FAMILY LAYOUT' })
  const selected = join(directory, 'backups', SELECTED_BACKUP)
  await mkdir(join(selected, 'config'), { recursive: true, mode: 0o700 })
  await mkdir(join(selected, 'state'), { mode: 0o700 })
  await privateJson(join(selected, 'backup.json'), { id: SELECTED_BACKUP, createdAt: '2026-10-14T01:00:00Z', size: 50 })
  await privateJson(join(selected, 'config', 'ha-owner.json'), backupOwner)
  await writeFile(join(selected, 'config', 'home-assistant_v2.db'), 'OLDER FAMILY HISTORY', { mode: 0o600 })
  await privateJson(join(selected, 'state', 'preferences.json'), { layout: 'OLDER FAMILY LAYOUT' })
  await privateJson(join(selected, 'state', 'backup-auth.json'), { managed: backupOwner })
  if (options.badSettings === 'json') await writeFile(join(selected, 'state', 'settings.json'), '{ damaged JSON', { mode: 0o600 })
  else await privateJson(join(selected, 'state', 'settings.json'), options.badSettings === 'schema' ? { ...settings, familyName: '' } : { ...settings, familyName: '旧备份里的家' })

  // Real HaAuth uses this HTTP endpoint. Its expected grant follows the actual
  // owner file swapped by the snapshot, so stale/mismatched credentials fail.
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += String(chunk)
    const owner = JSON.parse(await readFile(join(directory, 'config', 'ha-owner.json'), 'utf8')) as ManagedCredential
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.url === '/api/onboarding') return send(404, {})
    if (req.url === '/auth/token') {
      const form = new URLSearchParams(body)
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') !== owner.refreshToken) return send(400, { error: 'invalid_grant' })
      return send(200, { access_token: `access-${owner.username}`, expires_in: 1800, ...(form.get('grant_type') === 'authorization_code' ? { refresh_token: owner.refreshToken } : {}) })
    }
    if (req.url === '/auth/login_flow') return send(200, { flow_id: 'owner-recovery' })
    if (req.url === '/auth/login_flow/owner-recovery') {
      const input = JSON.parse(body) as { username: string; password: string }
      return send(200, input.username === owner.username && input.password === owner.password ? { type: 'create_entry', result: 'test-code' } : { type: 'form', errors: { base: 'invalid_auth' } })
    }
    if (req.headers.authorization !== `Bearer access-${owner.username}`) return send(401, {})
    if (req.url === '/api/') return send(200, { message: 'API running.' })
    if (req.url === '/api/core/state') return send(200, { state: 'RUNNING' })
    if (req.url === '/api/states') return send(200, [{ entity_id: 'light.current_home', state: 'on', attributes: {} }])
    return send(404, {})
  })
  const websocket = new WebSocketServer({ server, path: '/api/websocket' })
  websocket.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'auth_required' }))
    socket.on('message', async raw => {
      const input = JSON.parse(String(raw)) as { type: string; access_token?: string; id?: number }
      if (input.type === 'auth') {
        const owner = JSON.parse(await readFile(join(directory, 'config', 'ha-owner.json'), 'utf8')) as ManagedCredential
        socket.send(JSON.stringify({ type: input.access_token === `access-${owner.username}` ? 'auth_ok' : 'auth_invalid' }))
      } else socket.send(JSON.stringify({ id: input.id, type: 'result', success: true, result: { active_config_type: 'stable', pending: null } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind')
  cleanups.push(async () => { for (const socket of websocket.clients) socket.terminate(); websocket.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const serverUrl = `http://127.0.0.1:${address.port}`
  let runtime!: SnapshotRuntime
  factory.create = input => runtime = new SnapshotRuntime(input, serverUrl)
  const controller = new SmartHomeController(directory, settings, options.provider)
  cleanups.push(() => controller.close())
  await controller.store.write({ managed: originalOwner })
  await controller.initialize()
  return { directory, controller, runtime, settings }
}

async function assertCurrentFamily(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await readFile(join(f.directory, 'config', 'home-assistant_v2.db'), 'utf8')).toBe('LATEST FAMILY HISTORY')
  expect(JSON.parse(await readFile(join(f.directory, 'config', 'ha-owner.json'), 'utf8'))).toEqual(originalOwner)
  expect(JSON.parse(await readFile(join(f.directory, 'state', 'preferences.json'), 'utf8'))).toEqual({ layout: 'LATEST FAMILY LAYOUT' })
  expect(JSON.parse(await readFile(join(f.directory, 'state', 'settings.json'), 'utf8'))).toEqual(f.settings)
  expect(await f.controller.store.read()).toEqual({ managed: originalOwner })
  expect(f.controller.status().phase).toBe('ready')
  expect(f.runtime.running).toBe(true)
  expect(await f.controller.entities()).toEqual([{ entity_id: 'light.current_home', state: 'on', attributes: {} }])
}

describe('controller transaction failures preserve the active family', () => {
  it('reconnects to the old HA after backup copy fails and the process restarts', async () => {
    const f = await fixture()
    await f.controller.start()
    f.runtime.failBackupOnce = true
    await expect(f.controller.backup()).rejects.toThrow('simulated disk full')
    expect(f.runtime.starts).toBe(2)
    await assertCurrentFamily(f)
    await expect(readFile(f.controller.store.backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the old family usable when the pre-upgrade safety snapshot fails', async () => {
    const f = await fixture()
    await f.controller.start()
    f.runtime.failBackupOnce = true
    await expect(f.controller.updateSettings({ haVersion: '2026.10.2' })).rejects.toThrow('simulated disk full')
    await assertCurrentFamily(f)
    expect(f.controller.status().settings.haVersion).toBe(f.settings.haVersion)
  })

  it.each(['json', 'schema'] as const)('undoes a restore with invalid %s settings before discarding the current history', async badSettings => {
    const f = await fixture({ badSettings })
    await f.controller.start()
    await expect(f.controller.restore(SELECTED_BACKUP)).rejects.toThrow('已自动恢复操作前')
    await assertCurrentFamily(f)
    // Verify the rescue snapshot itself keeps the latest database, even though
    // the attempted selected backup was a valid listed older snapshot.
    const undo = (await f.runtime.listBackups()).find(snapshot => snapshot.id !== SELECTED_BACKUP)
    expect(undo).toBeDefined()
    expect(await readFile(join(f.directory, 'backups', undo!.id, 'config', 'home-assistant_v2.db'), 'utf8')).toBe('LATEST FAMILY HISTORY')
  })

  it('rolls config, state, credentials and the live connection back when the credential provider rejects the imported grant', async () => {
    const memory = memoryProvider()
    const f = await fixture({ provider: memory.provider })
    await f.controller.start()
    memory.failNextImportedGrant()
    await expect(f.controller.restore(SELECTED_BACKUP)).rejects.toThrow('Credential provider rejected imported grant')
    await assertCurrentFamily(f)
    expect(f.runtime.restores).toHaveLength(2)
    await expect(readFile(f.controller.store.backupPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an invalid/unlisted restore id without stopping or taking a snapshot of the healthy instance', async () => {
    const f = await fixture()
    await f.controller.start()
    const starts = f.runtime.starts; const stops = f.runtime.stops
    await expect(f.controller.restore('../../some-other-directory')).rejects.toThrow('备份不存在')
    expect(f.runtime.starts).toBe(starts)
    expect(f.runtime.stops).toBe(stops)
    expect(f.runtime.backups).toBe(0)
    await assertCurrentFamily(f)
  })

  it('blocks queued and new startup work while close drains the active start, then leaves no managed process', async () => {
    const f = await fixture()
    const entered = deferred(); const release = deferred()
    f.runtime.beforeStart = async () => { entered.resolve(); await release.promise }
    const active = f.controller.start()
    await entered.promise
    const queuedRepair = f.controller.repair('restart')
    const closed = f.controller.close()
    const laterStart = f.controller.start()
    // Attach rejection handlers before opening the barrier.
    const outcomes = Promise.allSettled([active, queuedRepair, laterStart])
    release.resolve()
    await closed
    const [first, queued, later] = await outcomes
    expect(first?.status).toBe('fulfilled')
    expect(queued?.status).toBe('rejected')
    expect(later?.status).toBe('rejected')
    expect(f.runtime.starts).toBe(1)
    expect(f.runtime.running).toBe(false)
    expect(f.runtime.baseUrl).toBeUndefined()
    expect(f.controller.status().phase).toBe('stopped')
    await expect(f.controller.start()).rejects.toThrow('插件已关闭')
    expect(f.runtime.starts).toBe(1)
  })
})
