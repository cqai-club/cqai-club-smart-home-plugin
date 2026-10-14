import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import vm from 'node:vm'

const project = resolve(import.meta.dirname, '..')
const hostRoot = resolve(process.argv[2] || project)
const packageName = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).name
const anchor = pathToFileURL(join(hostRoot, 'package.json')).href
const hostRequire = createRequire(anchor)
registerHooks({ resolve(specifier, context, next) {
  const fromPlugin = context.parentURL === import.meta.url || context.parentURL?.startsWith(pathToFileURL(join(project, 'lib') + '/').href)
  return next(specifier, fromPlugin && specifier.startsWith('@deepseek-ai/') ? { ...context, parentURL: anchor } : context)
} })
const { Context } = await import('@deepseek-ai/cordis')
const { default: WebServer } = await import('@deepseek-ai/dsh-host-webserver')
const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
const artifact = await import(pathToFileURL(join(project, 'lib/index.js')).href)
const dataDir = await mkdtemp(join(tmpdir(), 'cqai-home-host-'))
const mock = createServer((req, res) => {
  res.writeHead(req.headers.authorization === 'Bearer host-smoke-private' ? 200 : 401, { 'content-type': 'application/json' })
  res.end(req.url === '/api/states' ? '[{"entity_id":"light.mock","state":"off","attributes":{"friendly_name":"测试灯"}}]' : '{"message":"API running."}')
})
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
const ctx = new Context(); const fibers = []; const checks = []
try {
  fibers.push(await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }))
  fibers.push(await ctx.plugin(SystemPrompt))
  fibers.push(await ctx.plugin(ToolRuntime))
  fibers.push(await ctx.plugin(artifact, { dataDir, mode: 'external', autoStart: false }))
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const post = async (path, body = {}) => {
    const response = await fetch(`${origin}/api/cqai-club-home${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.ok(response.ok, `${path}: HTTP ${response.status}`); return response.json()
  }
  await post('/settings', { patch: { externalBaseUrl: `http://127.0.0.1:${mock.address().port}`, externalToken: 'host-smoke-private' } })
  await post('/start')
  let status
  for (let i = 0; i < 30; i++) {
    status = await (await fetch(`${origin}/api/cqai-club-home/status`)).json()
    if (status.phase === 'ready') break
    if (status.phase === 'error') throw new Error(status.message)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.equal(status.phase, 'ready'); assert.ok(!JSON.stringify(status).includes('host-smoke-private'))
  checks.push('built Host artifact starts through actual Beta Cordis + WebServer with secret-free status')
  const crossOrigin = await fetch(`${origin}/api/cqai-club-home/stop`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(crossOrigin.status, 403); checks.push('management mutations reject a cross-origin caller')
  assert.equal(ctx.tools.schemas().filter(tool => tool.name.startsWith('cqai_home_')).length, 7)
  const entities = await ctx.tools.execute({ name: 'cqai_home_entities', arguments: { domain: 'light' }, signal: new AbortController().signal, callId: ToolCallId('cqai-artifact-smoke') })
  assert.equal(entities.isError, false); assert.ok(JSON.stringify(entities).includes('light.mock'))
  checks.push('7 tools register and query simulated entities through the actual Beta ToolRuntime')
  const frame = await post('/frame'); assert.match(frame.url, /^http:\/\/127\.0\.0\.1:\d+\/session\/[\w-]{43}$/)
  checks.push('authenticated Host issues a bounded gateway ticket')

  const target = { mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration) } }
  const sandbox = { window: { __ModuleLoader__: target }, console }
  vm.runInNewContext(await readFile(hostRequire.resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8'), sandbox)
  const bootstrap = target.pendingQueue.shift()
  const exports = bootstrap.factory(() => { throw new Error('unexpected bootstrap import') })
  const modules = new exports.ClientModuleSystem({ manifest: { rev: 'cqai-home-smoke', modules: [], plugins: [] }, staticModules: { react: hostRequire('react'), 'react/jsx-runtime': hostRequire('react/jsx-runtime') }, registrationTarget: target, bootstrapModule: { id: bootstrap.id, exports }, loadBundle: async () => { throw new Error('unexpected remote bundle') } })
  vm.runInNewContext(await readFile(join(project, 'lib/client.js'), 'utf8'), sandbox)
  const client = await modules.import(`${packageName}/client`)
  const seats = []
  client.apply({ slots: { inject(_, callback) { callback() }, register(options, component) { seats.push({ options, component }); return () => {} } } })
  assert.deepEqual(Array.from(client.inject), ['slots'])
  assert.equal(seats.length, 2); assert.equal(seats[0].options.key, seats[1].options.id); assert.equal(seats[1].options.label, '家庭智能')
  checks.push('built client loads through actual Beta ClientModuleSystem and registers main/sidebar seats')
  console.log(JSON.stringify({ ok: true, checks, realDeviceCalls: 0 }, null, 2))
  await mkdir(join(project, '.local'), { recursive: true }); await writeFile(join(project, '.local', 'host-smoke-report.json'), JSON.stringify({ ok: true, checks }, null, 2))
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose()
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); await rm(dataDir, { recursive: true, force: true })
}
