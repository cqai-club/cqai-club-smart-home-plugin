import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { HaEntity, HomeController, HomeStatus, RepairAction } from './protocol.js'

const MAX_ENTITY_LIMIT = 200
const output: ToolDefinition['output'] = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const noArgs = { type: 'object', properties: {}, additionalProperties: false } as const
const tokenKey = /(?:token|password|passwd|secret|credential|authorization|api[_-]?key|cookie)/i
const identifier = /^[a-z][a-z0-9_]{0,63}$/
const entityIdentifier = /^[a-z][a-z0-9_]{0,63}\.[a-z0-9_]{1,128}$/
const discoveryNote = '仅返回 Home Assistant 已集成的实体；设备发现取决于网络、协议和厂商授权，不能自动发现所有家庭设备。'
const actionNote = '仅在用户明确要求操作真实设备，并已确认准确设备和动作后调用；不要猜测设备编号或模拟成功。'

function argsOf(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工具参数必须是对象')
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('工具参数包含不支持的字段')
  return value as Record<string, unknown>
}

function idOf(value: unknown, kind: 'domain' | 'service' | 'entity_id'): string {
  if (typeof value !== 'string' || !(kind === 'entity_id' ? entityIdentifier : identifier).test(value)) {
    throw new Error(`${kind} 格式无效`)
  }
  return value
}

function redactText(value: string): string {
  return value.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key|authorization)\s*[=:]\s*)[^\s&,;]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .slice(0, 2000)
}

/** Bounded public projection; authentication material never belongs in model output. */
function publicValue(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (depth >= 6) return '[TRUNCATED]'
  if (Array.isArray(value)) return value.slice(0, 100).map(item => publicValue(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 64)
    .filter(([key]) => !tokenKey.test(key))
    .map(([key, item]) => [key, publicValue(item, depth + 1)]))
  return null
}

function entityView(entity: HaEntity): JsonValue {
  return {
    entity_id: entity.entity_id,
    state: redactText(entity.state),
    attributes: publicValue(entity.attributes),
    ...(entity.last_changed ? { last_changed: entity.last_changed } : {}),
    ...(entity.last_updated ? { last_updated: entity.last_updated } : {}),
  }
}

function statusView(status: HomeStatus): JsonValue {
  return {
    phase: status.phase, installed: status.installed, mode: status.settings.mode,
    familyName: redactText(status.settings.familyName), timezone: status.settings.timezone,
    autoStart: status.settings.autoStart, expectedHaVersion: status.settings.haVersion,
    ...(status.runtimeVersion ? { runtimeVersion: status.runtimeVersion } : {}),
    ...(status.startedAt ? { startedAt: status.startedAt } : {}),
    needsAuthorization: status.phase === 'authorizing',
    hasError: Boolean(status.error), backupCount: status.backups.length,
  }
}

function needsApproval(domain: string, service: string): boolean {
  // Scripts/scenes/buttons can execute indirect security actions. Unknown
  // services also require approval rather than assuming harmless semantics.
  const ordinary: Record<string, readonly string[]> = {
    light: ['turn_on', 'turn_off', 'toggle'],
    switch: ['turn_on', 'turn_off', 'toggle'],
    fan: ['turn_on', 'turn_off', 'toggle', 'set_percentage', 'set_preset_mode'],
    climate: ['turn_on', 'turn_off', 'set_temperature', 'set_hvac_mode', 'set_fan_mode', 'set_preset_mode'],
    media_player: ['turn_on', 'turn_off', 'media_play', 'media_pause', 'media_stop', 'volume_set', 'volume_mute'],
    lock: ['lock'],
  }
  return !ordinary[domain]?.includes(service)
}

function exactTarget(data: Record<string, unknown>, domain: string): string | undefined {
  const values = typeof data.entity_id === 'string' ? [data.entity_id] : Array.isArray(data.entity_id) ? data.entity_id : []
  if (!values.length || values.length > 20 || values.some(value => typeof value !== 'string' || !entityIdentifier.test(value) || !value.startsWith(domain + '.'))) return undefined
  return values.join(', ')
}

function serviceArgs(value: unknown): { domain: string; service: string; data: Record<string, unknown>; confirmed: boolean; requiresApproval: boolean; target: string } {
  const args = argsOf(value, ['domain', 'service', 'data', 'confirmed'])
  const domain = idOf(args.domain, 'domain')
  const service = idOf(args.service, 'service')
  // Environment lifecycle belongs to the managed controller, never a device API bypass.
  if (['homeassistant', 'hassio', 'recorder', 'system_log', 'shell_command', 'python_script', 'rest_command'].includes(domain)) {
    throw new Error('此服务不属于设备控制；运行环境操作请使用诊断和修复工具')
  }
  if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed 必须为布尔值')
  const data = args.data ?? {}
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('data 必须为对象')
  let encoded: string
  try { encoded = JSON.stringify(data) } catch { throw new Error('data 必须为 JSON 对象') }
  if (Buffer.byteLength(encoded, 'utf8') > 16_384) throw new Error('data 超过 16 KiB 限制')
  const target = exactTarget(data as Record<string, unknown>, domain)
  if (!target) throw new Error('设备动作必须指定 1 到 20 个属于该 domain 的准确 data.entity_id；禁止默认操作全部设备')
  const requiresApproval = needsApproval(domain, service)
  if (requiresApproval && args.confirmed !== true) throw new Error('此设备动作需要用户明确确认，请核对目标后设置 confirmed:true')
  return { domain, service, data: data as Record<string, unknown>, confirmed: args.confirmed === true, requiresApproval, target }
}

function repairArgs(value: unknown): RepairAction {
  const args = argsOf(value, ['action', 'confirmed'])
  if (args.action !== 'restart' && args.action !== 'reinstall') throw new Error('action 只能为 restart 或 reinstall')
  if (args.confirmed !== true) throw new Error('重启或重装环境前需要用户明确确认')
  return args.action
}

/** Use the Host's existing public registry/context; no private scope symbols. */
export function registerHomeTools(ctx: Context, controller: HomeController): () => void {
  const tools = ctx.get('tools') as Pick<Context['tools'], 'register'> | undefined
  if (!tools || typeof tools.register !== 'function') return () => {}
  let disposed = false
  const disposers: (() => void)[] = []
  const names = new Set<string>()
  const safe = (name: string, parameters: ToolDefinition['parameters'], description: string,
    run: (args: unknown, exec: ToolRunContext) => Promise<unknown>): ToolDefinition => ({
    name, parameters, description, output,
    async execute(args, exec) {
      if (disposed) throw new Error('家庭智能工具已停用')
      exec.signal.throwIfAborted()
      try {
        const value = await run(args, exec)
        exec.signal.throwIfAborted()
        return value
      } catch (error) {
        if (exec.signal.aborted) throw error
        // Controller error strings can contain upstream credential material.
        // Parameter errors are already checked below; never forward raw causes.
        throw new Error(error instanceof ToolInputError ? error.message : '家庭智能操作失败，请使用诊断工具检查运行和授权状态')
      }
    },
  })
  const validate = <T>(fn: () => T): T => {
    try { return fn() } catch (error) { throw new ToolInputError(error instanceof Error ? error.message : '工具参数无效') }
  }
  const definitions: ToolDefinition[] = [
    safe('cqai_home_status', noArgs, '读取家庭智能运行状态、版本和是否需要授权的精简摘要。不返回日志、访问令牌或密码。', async args => {
      validate(() => argsOf(args, []))
      return statusView(controller.status())
    }),
    safe('cqai_home_entities', {
      type: 'object', additionalProperties: false,
      properties: { domain: { type: 'string' }, filter: { type: 'string', maxLength: 160 }, limit: { type: 'integer', minimum: 1, maximum: MAX_ENTITY_LIMIT } },
    }, `列出已集成设备实体；可按 domain 和名称/编号的 filter 文本筛选。limit 默认 50，最大 ${MAX_ENTITY_LIMIT}。${discoveryNote}`, async args => {
      const value = validate(() => {
        const input = argsOf(args, ['domain', 'filter', 'limit'])
        const domain = input.domain === undefined ? undefined : idOf(input.domain, 'domain')
        if (input.filter !== undefined && (typeof input.filter !== 'string' || input.filter.length > 160)) throw new Error('filter 必须为不超过 160 字符的文本')
        const limit = input.limit ?? 50
        if (!Number.isInteger(limit) || typeof limit !== 'number' || limit < 1 || limit > MAX_ENTITY_LIMIT) throw new Error(`limit 必须为 1 到 ${MAX_ENTITY_LIMIT} 的整数`)
        return { domain, filter: typeof input.filter === 'string' ? input.filter.trim().toLocaleLowerCase() : '', limit }
      })
      const entities = (await controller.entities()).filter(entity => (!value.domain || entity.entity_id.startsWith(value.domain + '.')) &&
        (!value.filter || `${entity.entity_id} ${typeof entity.attributes.friendly_name === 'string' ? entity.attributes.friendly_name : ''}`.toLocaleLowerCase().includes(value.filter)))
      return { entities: entities.slice(0, value.limit).map(entityView), total: entities.length, returned: Math.min(entities.length, value.limit), truncated: entities.length > value.limit, discoveryNote }
    }),
    safe('cqai_home_state', { type: 'object', additionalProperties: false, properties: { entity_id: { type: 'string' } }, required: ['entity_id'] },
      `读取一个准确 entity_id 的实时状态。${discoveryNote}`, async args => {
        const id = validate(() => idOf(argsOf(args, ['entity_id']).entity_id, 'entity_id'))
        return { entity: entityView(await controller.state(id)) }
      }),
    safe('cqai_home_call_service', {
      type: 'object', additionalProperties: false,
      properties: { domain: { type: 'string' }, service: { type: 'string' }, data: { type: 'object', properties: {}, additionalProperties: true }, confirmed: { type: 'boolean' } },
      required: ['domain', 'service'],
    }, `${actionNote} 调用 Home Assistant 设备服务，data.entity_id 必须指定 1 到 20 个属于该 domain 的准确实体；禁止默认全部设备。不会返回鉴权令牌。门锁解锁、报警解除、门窗/阀门、场景/脚本和未列入普通设备动作的服务要求 confirmed:true，且由 DSH 再请求用户批准。无批准通道时拒绝危险动作。响应 accepted 仅表示服务调用已获接受，物理状态请再用 state 核实。`, async args => {
      const value = validate(() => serviceArgs(args))
      ctx.logger.info(`家庭智能设备服务 ${value.domain}.${value.service}; target=${value.target}; confirmed=${value.confirmed}`)
      await controller.callService(value.domain, value.service, value.data)
      return { accepted: true, domain: value.domain, service: value.service, confirmed: value.confirmed, verifyState: true }
    }),
    safe('cqai_home_diagnose', noArgs, '诊断家庭智能连接、授权、版本和运行环境，返回检查项与建议。不输出日志和凭据；不修改环境。', async args => {
      validate(() => argsOf(args, []))
      const value = await controller.diagnose()
      return { phase: value.phase, mode: value.mode, platform: value.platform, architecture: value.architecture,
        expectedHaVersion: value.expectedHaVersion, pythonVersion: value.pythonVersion, installed: value.installed,
        hasError: Boolean(value.error), checks: publicValue(value.checks), suggestedActions: publicValue(value.suggestedActions) }
    }),
    safe('cqai_home_repair', { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['restart', 'reinstall'] }, confirmed: { type: 'boolean', const: true } }, required: ['action', 'confirmed'] },
      '用户明确批准后修复插件管理的运行环境。action 为 restart 或 reinstall，必须 confirmed:true，并经 DSH 用户批准；外部 Home Assistant 和系统 Python 禁止修改，最终范围由 controller 判断。重启和重装可能中断家庭自动化。', async args => {
        const action = validate(() => repairArgs(args))
        ctx.logger.info(`家庭智能环境修复 ${action}; confirmed=true`)
        await controller.repair(action)
        return { repaired: true, action, status: statusView(controller.status()) }
      }),
    safe('cqai_home_backup', noArgs, '为插件管理的家庭智能创建备份，只返回备份编号、时间和大小。仅在用户要求备份时调用；外部实例是否可备份由 controller 裁决。', async args => {
      validate(() => argsOf(args, []))
      const backup = await controller.backup()
      return { id: backup.id, createdAt: backup.createdAt, size: backup.size }
    }),
  ]
  for (const definition of definitions) names.add(definition.name)
  try {
    disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
      if (!names.has(exec.name)) return next()
      exec.signal.throwIfAborted()
      let reason: string | undefined
      try {
        if (exec.name === 'cqai_home_call_service') {
          const value = serviceArgs(exec.arguments)
          if (value.requiresApproval) reason = `确认操作真实家庭设备 ${value.target}：${value.domain}.${value.service}`
        } else if (exec.name === 'cqai_home_repair') reason = `确认${repairArgs(exec.arguments) === 'restart' ? '重启' : '重装'}插件管理的家庭智能环境`
      } catch (error) {
        return { kind: 'deny', reason: error instanceof Error ? error.message : '工具参数无效' }
      }
      const decision = await next()
      if (decision.kind === 'deny' || decision.kind === 'cancel' || !reason) return decision
      if (decision.kind === 'ask' && decision.reason) reason = `${reason}；${redactText(decision.reason)}`
      return { kind: 'ask', reason, displayReason: { en: reason, 'zh-CN': reason } }
    }))
    for (const definition of definitions) disposers.push(tools.register(definition))
  } catch (error) {
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
  }
}

class ToolInputError extends Error {}
