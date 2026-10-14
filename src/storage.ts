import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'

export interface ManagedCredential { username: string; password: string; clientId: string; refreshToken?: string }
export interface HomeSecrets { managed?: ManagedCredential; externalToken?: string }
export async function privateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error('私有状态目录不能为符号链接')
  await chmod(dirname(path), 0o700)
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}
export async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('本地状态文件损坏，请从备份恢复') }
}

/** Uses the Host credential seam when available; otherwise a private local file. */
export class SecretStore {
  private readonly key
  private pending: Promise<unknown> = Promise.resolve()
  readonly backupPath: string
  constructor(readonly stateDir: string, private readonly provider?: CredentialProvider) {
    this.key = `cqai-club-smart-home-plugin/home-${createHash('sha256').update(stateDir).digest('hex').slice(0, 16)}` as CredentialKey
    this.backupPath = join(stateDir, 'backup-auth.json')
  }
  async read(): Promise<HomeSecrets> {
    if (this.provider) {
      const record = await this.provider.readRecord(this.key)
      if (!record) return {}
      if (record.kind !== 'grant' || !record.payload || typeof record.payload !== 'object') throw new Error('家庭智能认证记录格式不正确')
      return record.payload as HomeSecrets
    }
    return await readJson<HomeSecrets>(join(this.stateDir, 'secrets.json')) ?? {}
  }
  async write(value: HomeSecrets): Promise<void> {
    if (this.provider) await this.provider.modifyRecord(this.key, async () => ({ kind: 'grant', payload: value }))
    else await privateJson(join(this.stateDir, 'secrets.json'), value)
  }
  async update(mutate: (current: HomeSecrets) => HomeSecrets): Promise<void> {
    if (this.provider) {
      await this.provider.modifyRecord(this.key, async current => {
        if (current && (current.kind !== 'grant' || !current.payload || typeof current.payload !== 'object')) throw new Error('家庭智能认证记录格式不正确')
        return { kind: 'grant', payload: mutate(structuredClone(current?.kind === 'grant' ? current.payload as HomeSecrets : {})) }
      })
      return
    }
    const next = this.pending.catch(() => {}).then(async () => this.write(mutate(await this.read())))
    this.pending = next; await next
  }
  async prepareBackup(): Promise<void> { await privateJson(this.backupPath, await this.read()) }
  async restoreBackup(): Promise<void> {
    const snapshot = await readJson<HomeSecrets>(this.backupPath)
    if (snapshot) await this.write(snapshot)
  }
}
