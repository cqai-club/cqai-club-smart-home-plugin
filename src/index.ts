import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { SmartHomeController } from './controller.js'
import { API_PREFIX, DEFAULT_SETTINGS, PACKAGE_NAME, type HomeSettings, type RepairAction } from './protocol.js'
import { registerHomeTools } from './tools.js'

export const name = PACKAGE_NAME
export const inject = ['webServer']
export interface Config { dataDir: string; mode: 'managed' | 'external'; autoStart: boolean }
export const Config = z.object({ dataDir: z.string().default('').description('可选独立数据目录；留空保存在当前 DSH 数据目录'), mode: z.union(['managed', 'external']).default('managed'), autoStart: z.boolean().default(true) })
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(data))
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求需要 JSON 格式')
  let text = ''; for await (const chunk of req) { text += String(chunk); if (text.length > 32_768) throw new Error('请求过大') }
  const parsed = JSON.parse(text || '{}')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求格式不正确')
  return parsed
}
export async function apply(ctx: Context, config: Config): Promise<void> {
  const dataDir = config.dataDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'cqai-club-smart-home')
  if (!isAbsolute(dataDir)) throw new Error('家庭智能数据目录必须为绝对路径')
  const controller = new SmartHomeController(dataDir, { ...DEFAULT_SETTINGS, mode: config.mode, autoStart: config.autoStart }, ctx.get('credentials'))
  await controller.initialize()
  ctx.effect(() => () => controller.close(), 'cqai-home.lifecycle')
  const host = `127.0.0.1:${ctx.webServer.port}`
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: async (req, res) => {
    // Exact local Host authority plus JSON POST prevents drive-by localhost writes.
    if (req.headers.host !== host) return json(res, 403, { error: '家庭智能管理仅支持本机 127.0.0.1 入口' })
    const origin = `http://${req.headers.host}`
    if (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '请求来源不正确' })
    const path = new URL(req.url ?? '/', origin).pathname.slice(API_PREFIX.length)
    try {
      if (req.method === 'GET' && path === '/status') return json(res, 200, controller.status())
      if (req.method === 'GET' && path === '/diagnose') return json(res, 200, await controller.diagnose())
      if (req.method !== 'POST') return json(res, 405, { error: '该操作需要 POST 请求' })
      const input = await body(req)
      if (path === '/frame') return json(res, 200, { url: await controller.frame(origin) })
      if (path === '/start' || path === '/stop' || path === '/repair') {
        if (path === '/repair' && !['restart', 'reinstall'].includes(String(input.action))) throw new Error('修复动作不正确')
        const operation = path === '/start' ? controller.start() : path === '/stop' ? controller.stop() : controller.repair(input.action as RepairAction)
        void operation.catch(error => ctx.logger.warn(`家庭智能：${error instanceof Error ? error.message : '运行操作失败'}`))
        return json(res, 202, { accepted: true })
      }
      if (path === '/backup') return json(res, 200, await controller.backup())
      if (path === '/restore') { if (typeof input.id !== 'string') throw new Error('请选择备份'); await controller.restore(input.id); return json(res, 200, { ok: true }) }
      if (path === '/settings') {
        if (!input.patch || typeof input.patch !== 'object' || Array.isArray(input.patch)) throw new Error('设置内容格式不正确')
        await controller.updateSettings(input.patch as Partial<HomeSettings> & { externalToken?: string }); return json(res, 200, controller.status())
      }
      return json(res, 404, { error: '操作不存在' })
    } catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : '操作未完成' }) }
  } }), 'cqai-home.http')
  ctx.inject(['tools'], toolsContext => { registerHomeTools(toolsContext, controller) })
  if (controller.status().settings.autoStart) void controller.start().catch(error => ctx.logger.warn(`家庭智能自动启动未完成：${error instanceof Error ? error.message : '未知错误'}`))
}
