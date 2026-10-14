import { constants } from 'node:fs'
import { mkdir, readdir, lstat, open, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/** Snapshots never follow links, sockets, devices, or paths outside their managed root. */
export async function copyPrivateTree(source: string, target: string): Promise<number> {
  const sourceRoot = await realpath(source)
  const visit = async (from: string, to: string): Promise<number> => {
    const stat = await lstat(from)
    if (stat.isSymbolicLink()) throw new Error('备份包含符号链接；已拒绝读取该路径')
    const canonical = await realpath(from)
    if (canonical !== sourceRoot && !canonical.startsWith(sourceRoot + sep)) throw new Error('备份路径超出管理目录')
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 })
      let size = 0
      for (const item of await readdir(from)) size += await visit(join(from, item), join(to, item))
      return size
    }
    if (!stat.isFile()) throw new Error('备份包含不支持的特殊文件')
    // O_NOFOLLOW closes the lstat/open symlink race on supported platforms.
    const input = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const output = await open(to, 'wx', 0o600)
      try {
        const block = Buffer.alloc(1024 * 1024)
        let size = 0
        for (;;) {
          const { bytesRead } = await input.read(block, 0, block.length, null)
          if (!bytesRead) break
          let offset = 0
          while (offset < bytesRead) {
            const { bytesWritten } = await output.write(block, offset, bytesRead - offset)
            offset += bytesWritten
          }
          size += bytesRead
        }
        return size
      } finally { await output.close() }
    } finally { await input.close() }
  }
  return visit(resolve(source), resolve(target))
}

export function backupPath(root: string, id: string): string {
  if (!/^\d{8}T\d{6}-[a-f0-9]{16}$/.test(id)) throw new Error('无效备份编号')
  return join(root, id)
}

export function safeLogLine(input: string): string {
  if (/(?:bearer|access[_ -]?token|refresh[_ -]?token|password|client[_ -]?secret|authorization|["']token["'])/i.test(input)) return '[redacted] private credentials omitted'
  return input
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/(Bearer\s+)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/((?:access_token|refresh_token|token|password|authorization|client_secret)\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .slice(0, 4096)
}
