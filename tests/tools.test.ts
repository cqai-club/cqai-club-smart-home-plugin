import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HomeController, type HomeDiagnostic, type HomeStatus } from '../src/protocol.js'
import { registerHomeTools } from '../src/tools.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const privateToken = 'eyJhbGciOiJIUzI1NiJ9.eyJzZWNyZXQiOiJ0ZXN0In0.fake_signature'
function controllerFixture(): HomeController {
  const status: HomeStatus = {
    phase: 'ready', installed: true, message: `Bearer ${privateToken}`,
    settings: { ...DEFAULT_SETTINGS, externalBaseUrl: 'https://user:password@ha.example', externalTokenConfigured: true },
    logs: [{ time: 'now', level: 'info', message: `password=${privateToken}` }],
    backups: [], runtimeVersion: '2026.10.1',
  }
  return {
    status: vi.fn(() => status), start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    repair: vi.fn(async () => {}), backup: vi.fn(async () => ({ id: 'backup-1', createdAt: '2026-10-14T00:00:00Z', size: 123 })),
    restore: vi.fn(async () => {}), updateSettings: vi.fn(async () => {}),
    diagnose: vi.fn(async (): Promise<HomeDiagnostic> => ({ phase: 'ready', mode: 'managed', platform: 'darwin', architecture: 'arm64', installed: true,
      expectedHaVersion: '2026.10.1', pythonVersion: '3.14.2', checks: [{ name: 'authorization', ok: true, detail: `Bearer ${privateToken}` }],
      logs: [{ time: 'now', level: 'info', message: privateToken }], suggestedActions: [] })),
    entities: vi.fn(async () => [
      { entity_id: 'light.study', state: 'on', attributes: { friendly_name: '书房灯', access_token: privateToken, nested: { password: 'private', useful: 'shown' } } },
      { entity_id: 'light.bedroom', state: 'off', attributes: { friendly_name: '卧室灯' } },
      { entity_id: 'lock.front', state: 'locked', attributes: { friendly_name: '大门' } },
    ]),
    state: vi.fn(async entityId => ({ entity_id: entityId, state: 'on', attributes: { friendly_name: '书房灯', refresh_token: privateToken } })),
    callService: vi.fn(async () => ({ access_token: privateToken, rawReply: privateToken })),
  }
}

async function fixture() {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
  await ctx.plugin(ToolRuntime)
  const controller = controllerFixture()
  const dispose = registerHomeTools(ctx, controller)
  const execute = (name: string, args: unknown = {}, options: Partial<ToolExecutionInput> = {}) => ctx.tools.execute({
    callId: ToolCallId('home-test'), name, arguments: args, signal: new AbortController().signal, ...options,
  })
  return { ctx, controller, dispose, execute }
}

describe('home tools through the official DSH 0.2.0-rc.2 ToolRuntime', () => {
  it('publishes seven valid schemas and removes their actual registry entries on cleanup', async () => {
    const { ctx, dispose, execute } = await fixture()
    expect(ctx.tools.schemas().map(item => item.name).sort()).toEqual([
      'cqai_home_backup', 'cqai_home_call_service', 'cqai_home_diagnose', 'cqai_home_entities', 'cqai_home_repair', 'cqai_home_state', 'cqai_home_status',
    ])
    expect((await execute('cqai_home_status')).isError).toBe(false)
    dispose(); dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect((await execute('cqai_home_status')).isError).toBe(true)
  })

  it('is optional when the Host has no tools service', () => {
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    expect(() => registerHomeTools(ctx, controllerFixture())()).not.toThrow()
  })

  it('projects compact status, state and diagnostics without logs or authentication material', async () => {
    const { execute } = await fixture()
    for (const [tool, args] of [['cqai_home_status', {}], ['cqai_home_state', { entity_id: 'light.study' }], ['cqai_home_diagnose', {}]] as const) {
      const result = await execute(tool, args)
      expect(result.isError).toBe(false)
      const encoded = JSON.stringify(result)
      expect(encoded).not.toContain(privateToken)
      expect(encoded).not.toContain('refresh_token')
      expect(encoded).not.toContain('logs')
      expect(encoded).not.toContain('https://user:password')
    }
  })

  it('filters entities and bounds results while stripping nested credentials', async () => {
    const { execute, controller } = await fixture()
    const result = await execute('cqai_home_entities', { domain: 'light', filter: '灯', limit: 1 })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ total: 2, returned: 1, truncated: true, entities: [{ entity_id: 'light.study', attributes: { nested: { useful: 'shown' } } }] })
    expect(JSON.stringify(result)).not.toMatch(/access_token|private|password/)
    const malformed = await execute('cqai_home_entities', { limit: 201 })
    expect(malformed.isError).toBe(true)
    expect(controller.entities).toHaveBeenCalledTimes(1)
    expect((await execute('cqai_home_state', { entity_id: '../secrets' })).isError).toBe(true)
    expect(controller.state).not.toHaveBeenCalled()
  })

  it('dispatches an ordinary real service call and does not expose arbitrary upstream results', async () => {
    const { execute, controller } = await fixture()
    const result = await execute('cqai_home_call_service', { domain: 'light', service: 'turn_on', data: { entity_id: 'light.study', brightness: 128 } })
    expect(result.isError).toBe(false)
    expect(controller.callService).toHaveBeenCalledWith('light', 'turn_on', { entity_id: 'light.study', brightness: 128 })
    expect(result.value).toEqual({ accepted: true, domain: 'light', service: 'turn_on', confirmed: false, verifyState: true })
    expect(JSON.stringify(result)).not.toContain(privateToken)
  })

  it('never defaults to a whole domain or accepts environment commands via device services', async () => {
    const { execute, controller } = await fixture()
    for (const args of [
      { domain: 'light', service: 'turn_off' },
      { domain: 'light', service: 'turn_off', data: { entity_id: 'all' }, confirmed: true },
      { domain: 'light', service: 'turn_off', data: { entity_id: 'lock.front' }, confirmed: true },
      { domain: 'homeassistant', service: 'restart', confirmed: true },
    ]) expect((await execute('cqai_home_call_service', args)).isError).toBe(true)
    expect(controller.callService).not.toHaveBeenCalled()
  })

  it('denies dangerous actions without explicit confirmation or a real approval channel', async () => {
    const { execute, controller } = await fixture()
    const action = { domain: 'lock', service: 'unlock', data: { entity_id: 'lock.front' } }
    expect((await execute('cqai_home_call_service', action)).isError).toBe(true)
    expect((await execute('cqai_home_call_service', { ...action, confirmed: true })).isError).toBe(true)
    expect((await execute('cqai_home_repair', { action: 'restart', confirmed: true })).isError).toBe(true)
    expect(controller.callService).not.toHaveBeenCalled()
    expect(controller.repair).not.toHaveBeenCalled()
  })

  it('uses the native approval seam and presents the exact device and action', async () => {
    const { ctx, execute, controller } = await fixture()
    const request = vi.fn(async (_input: { reason?: string; displayReason?: unknown; toolName: string }) => 'rejected')
    ctx.provide('approval', { request })
    const agent = { ctx, id: 'test-session' } as NonNullable<ToolExecutionInput['agent']>
    const action = { domain: 'alarm_control_panel', service: 'alarm_disarm', data: { entity_id: 'alarm_control_panel.home', code: 'private-pin' }, confirmed: true }
    expect((await execute('cqai_home_call_service', action, { agent })).isError).toBe(true)
    expect(controller.callService).not.toHaveBeenCalled()
    expect(request.mock.calls[0]).toEqual([expect.objectContaining({ toolName: 'cqai_home_call_service', reason: expect.stringContaining('alarm_control_panel.home') })])
    expect(JSON.stringify(request.mock.calls.map(([input]) => ({ reason: input.reason, displayReason: input.displayReason })))).not.toContain('private-pin')
    request.mockResolvedValue('allowed-once')
    const result = await execute('cqai_home_call_service', action, { agent })
    expect(result.isError).toBe(false)
    expect(controller.callService).toHaveBeenCalledTimes(1)
  })

  it('preserves other Host denial policies and lets controller reject external repairs', async () => {
    const { ctx, execute, controller } = await fixture()
    const removeDenial = ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'Host policy denied' }))
    const result = await execute('cqai_home_call_service', { domain: 'lock', service: 'unlock', data: { entity_id: 'lock.front' }, confirmed: true })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('Host policy denied')
    removeDenial()
    ctx.provide('approval', { request: async () => 'allowed-once' })
    const agent = { ctx, id: 'test-session' } as NonNullable<ToolExecutionInput['agent']>
    vi.mocked(controller.repair).mockRejectedValue(new Error(`external instance rejected; Bearer ${privateToken}`))
    const repair = await execute('cqai_home_repair', { action: 'reinstall', confirmed: true }, { agent })
    expect(repair.isError).toBe(true)
    expect(controller.repair).toHaveBeenCalledWith('reinstall')
    expect(JSON.stringify(repair)).not.toContain(privateToken)
  })

  it('returns a real backup acknowledgement and respects cancellation before dispatch', async () => {
    const { execute, controller } = await fixture()
    expect((await execute('cqai_home_backup')).value).toEqual({ id: 'backup-1', createdAt: '2026-10-14T00:00:00Z', size: 123 })
    const signal = AbortSignal.abort()
    expect((await execute('cqai_home_backup', {}, { signal })).isError).toBe(true)
    expect(controller.backup).toHaveBeenCalledTimes(1)
  })

  it('rolls back earlier tools and the approval listener if registration fails', async () => {
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false })
    await ctx.plugin(ToolRuntime)
    ctx.tools.register({ name: 'cqai_home_state', description: 'pre-existing tool', parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: () => [] }, execute: async () => ({}) })
    expect(() => registerHomeTools(ctx, controllerFixture())).toThrow()
    expect(ctx.tools.schemas().map(item => item.name)).toEqual(['cqai_home_state'])
  })
})
