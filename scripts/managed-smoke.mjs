// Runs an empty, isolated HA instance. It never invokes a device service.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { SmartHomeController } from '../lib/controller-api.js'
import { HaAuth } from '../lib/auth-api.js'

const project = resolve(import.meta.dirname, '..')
const dataDir = join(project, '.local', 'smoke')
const checks = []
let controller = new SmartHomeController(dataDir, { autoStart: false })
let parent
try {
  await controller.initialize()
  await controller.start()
  assert.equal(controller.status().phase, 'ready'); checks.push('managed install + automatic owner account + authenticated API')
  const baseUrl = controller.runtime.baseUrl
  const auth = new HaAuth(baseUrl, controller.store, 'managed')
  const httpConfig = await auth.command({ type: 'http/config' })
  assert.equal(httpConfig.active_config_type, 'stable'); assert.equal(httpConfig.pending, null)
  checks.push('official HTTP configuration promoted; no timed rollback')
  await controller.entities(); checks.push('authenticated entity query; no device commands executed')
  const backup = await controller.backup(); await controller.restore(backup.id)
  assert.equal(controller.status().phase, 'ready'); checks.push('consistent backup + restore with managed credentials')
  await controller.close()
  controller = new SmartHomeController(dataDir, { autoStart: false })
  await controller.initialize(); await controller.start()
  assert.equal(controller.runtime.baseUrl, baseUrl)
  assert.equal(controller.status().phase, 'ready'); checks.push('new controller reuses saved listener and logs in after onboarding')
  const restartAuth = new HaAuth(controller.runtime.baseUrl, controller.store, 'managed')
  await restartAuth.api('/api/services/homeassistant/restart', { method: 'POST', body: '{}' })
  let observedRestart = false
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (controller.status().phase !== 'ready') observedRestart = true
    if (observedRestart && controller.status().phase === 'ready') break
    if (controller.status().phase === 'error') throw new Error(controller.status().message)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.ok(observedRestart); assert.equal(controller.status().phase, 'ready')
  checks.push('HA-requested runtime restart returns to an authenticated ready state')
  parent = createServer((req, res) => {
    if (req.url === '/frame') {
      void controller.frame(`http://127.0.0.1:${parent.address().port}`).then(url => { res.writeHead(302, { location: url, 'cache-control': 'no-store' }); res.end() }); return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>家庭智能 · 完整 HA 界面验证</title><style>body{margin:0;font:14px system-ui;background:#f5f7f8}header{height:42px;display:flex;align-items:center;padding:0 18px;color:#264b45;border-bottom:1px solid #dce5e3}iframe{width:100%;height:calc(100vh - 43px);border:0;display:block}</style></head><body><header>家庭智能 · 本地自动授权与完整界面验证</header><iframe title="Home Assistant 家庭智能" src="/frame"></iframe></body></html>')
  })
  await new Promise(resolve => parent.listen(0, '127.0.0.1', resolve))
  const preview = `http://127.0.0.1:${parent.address().port}`
  const report = { ok: true, node: process.version, homeAssistant: controller.status().runtimeVersion, checks, preview, simulatedDevices: false, deviceServicesExecuted: 0, maintenanceRestart: true }
  await mkdir(join(project, '.local'), { recursive: true })
  await writeFile(join(project, '.local', 'managed-smoke-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (process.argv.includes('--serve')) {
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  }
} finally {
  if (parent) { parent.closeAllConnections(); await new Promise(resolve => parent.close(resolve)) }
  await controller.close()
}
