import { spawn, type ChildProcess } from 'node:child_process'

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export function managedSpawn(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(command, args, { ...options, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}

export async function terminateProcess(child: ChildProcess, graceMs = 30_000): Promise<void> {
  if (!child.pid) return
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  const send = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  send('SIGTERM')
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = await Promise.race([
    ended.then(() => false),
    new Promise<true>(resolve => { timeout = setTimeout(() => resolve(true), graceMs) }),
  ])
  if (timeout) clearTimeout(timeout)
  if (timedOut) {
    send('SIGKILL')
    await ended
  }
}

export function pidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false
  try { process.kill(Number(pid), 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}
