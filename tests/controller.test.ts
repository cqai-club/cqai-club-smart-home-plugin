import { afterEach, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SmartHomeController } from '../src/controller.js'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
it('keeps a working external connection after rejected settings or managed repair', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cqai-controller-')); cleanup.push(() => rm(dir, { recursive: true, force: true }))
  const server = createServer((req, res) => { res.writeHead(req.headers.authorization === 'Bearer never-expose-in-status' ? 200 : 401, { 'content-type': 'application/json' }); res.end('[]') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('server')
  cleanup.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const controller = new SmartHomeController(dir, { mode: 'external', autoStart: false, externalBaseUrl: `http://127.0.0.1:${addr.port}` }); cleanup.push(() => controller.close())
  await controller.initialize(); await controller.updateSettings({ externalToken: 'never-expose-in-status' }); await controller.start()
  await expect(controller.updateSettings({ familyName: '' })).rejects.toThrow()
  await expect(controller.repair('restart')).rejects.toThrow('外部')
  await expect(controller.updateSettings({ externalToken: 'invalid-token' })).rejects.toThrow('已恢复原有设置')
  expect(controller.status().phase).toBe('ready')
  expect(await controller.entities()).toEqual([])
  expect(JSON.stringify(controller.status())).not.toContain('never-expose-in-status')
})
