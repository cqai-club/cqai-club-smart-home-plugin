import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { eligibleExpiredHttpTrial } from '../src/runtime/index.js'
import { HA_LAUNCHER } from '../src/runtime/launcher.js'
import { MANAGED_YAML_PREFIX, NATIVE_COMPONENTS, migrateLegacyConfiguration, nativeConfiguration } from '../src/runtime/configuration.js'
import { DEFAULT_SETTINGS } from '../src/protocol.js'

const managed = { server_port: 57901, server_host: ['127.0.0.1'], error: 'not_promoted', created_at: 'old-trial', error_message: null, cors_allowed_origins: [] }

describe('owned expired HTTP trial', () => {
  it('allows only the unchanged persisted loopback trial which expired before promotion', () => {
    expect(eligibleExpiredHttpTrial(managed, 57901, true)).toBe(true)
    expect(eligibleExpiredHttpTrial(managed, 57901, false)).toBe(false)
    expect(eligibleExpiredHttpTrial(managed, 57902, true)).toBe(false)
    expect(eligibleExpiredHttpTrial({ ...managed, server_host: ['0.0.0.0'] }, 57901, true)).toBe(false)
    expect(eligibleExpiredHttpTrial({ ...managed, server_host: ['127.0.0.1', '::1'] }, 57901, true)).toBe(false)
    expect(eligibleExpiredHttpTrial({ ...managed, error: 'apply_failed' }, 57901, true)).toBe(false)
    expect(eligibleExpiredHttpTrial({ ...managed, error: null }, 57901, true)).toBe(false)
  })
})

describe('native HA baseline configuration', () => {
  it('provides dashboard/control/discovery and avoids the optional HA voice/cloud startup chain', () => {
    const config = nativeConfiguration(DEFAULT_SETTINGS, 57901)
    for (const domain of ['frontend', 'person', 'automation', 'script', 'scene', 'history', 'energy', 'zeroconf', 'ssdp', 'dhcp', 'usb', 'mobile_app']) expect(config).toContain(`${domain}:\n`)
    for (const domain of ['default_config', 'assist_pipeline', 'cloud', 'conversation', 'go2rtc']) expect(NATIVE_COMPONENTS).not.toContain(domain)
    expect(config).toContain('server_host: 127.0.0.1\n  server_port: 57901')
  })

  it('migrates only the exact legacy owned template, preserving names/timezone/HTTP byte for byte', () => {
    const simple = `${MANAGED_YAML_PREFIX}default_config:\nhomeassistant:\n  name: ${JSON.stringify('家 "\n')}\n  time_zone: "Asia/Shanghai"\nhttp:\n  server_host: 127.0.0.1\n  server_port: 57901\n`
    const migrated = migrateLegacyConfiguration(simple)
    expect(migrated).toBeDefined()
    expect(migrated).not.toContain('default_config:')
    expect(migrated?.slice(migrated.indexOf('homeassistant:'))).toBe(simple.slice(simple.indexOf('homeassistant:')))
    expect(migrateLegacyConfiguration(simple + 'logger:\n  default: debug\n')).toBeUndefined()
    expect(migrateLegacyConfiguration(simple.replace('127.0.0.1', '0.0.0.0'))).toBeUndefined()
    expect(migrateLegacyConfiguration(simple.replace(MANAGED_YAML_PREFIX, ''))).toBeUndefined()
    expect(migrateLegacyConfiguration(simple.replace(JSON.stringify('家 "\n'), '"unterminated'))).toBeUndefined()
  })
})

// Execute the launcher against a fake HA API, never a real HA process/storage or devices.
// This tests Python control flow and both imported async_load_config bindings.
const pythonCommand = process.platform === 'win32' ? 'python' : 'python3'
const pythonAvailable = spawnSync(pythonCommand, ['--version'], { encoding: 'utf8' }).status === 0
function launcherFixture(pending: unknown, forcedResult?: unknown): { accepted: boolean; calls: Record<string, unknown>[]; originalCalls: number; bothBindings: boolean } {
  const fixture = `import asyncio, json, types, sys
pending_input = json.loads(${JSON.stringify(JSON.stringify(pending))})
forced = json.loads(${JSON.stringify(JSON.stringify(forcedResult ?? null))})
class Store:
    def __init__(self):
        self.pending = pending_input
        self.calls = []
    async def async_set_pending(self, value):
        self.calls.append(dict(value))
        self.pending = dict(value, error=None, error_message=None, created_at="renewed")
store = Store()
original_calls = 0
async def get_store(hass):
    return store
async def original_load(hass, config):
    global original_calls
    original_calls += 1
    if forced is not None:
        return forced
    if store.pending is not None and not store.pending.get("error"):
        return store.pending
    return {"server_port": 8123}
http_config_fixture = types.ModuleType("homeassistant.components.http.config")
http_config_fixture.async_get_and_load_store = get_store
http_config_fixture.async_load_config = original_load
http_fixture = types.ModuleType("homeassistant.components.http")
http_fixture.config = http_config_fixture
http_fixture.async_load_config = original_load
components_fixture = types.ModuleType("homeassistant.components")
components_fixture.http = http_fixture
ha_fixture = types.ModuleType("homeassistant")
ha_fixture.components = components_fixture
main_fixture = types.ModuleType("homeassistant.__main__")
def fixture_main():
    hass = types.SimpleNamespace(config=types.SimpleNamespace(recovery_mode=False))
    accepted = False
    try:
        asyncio.run(http_fixture.async_load_config(hass, {}))
        accepted = True
    except RuntimeError:
        pass
    print(json.dumps({"accepted": accepted, "calls": store.calls, "originalCalls": original_calls,
                      "bothBindings": http_fixture.async_load_config is http_config_fixture.async_load_config}))
    return 0
main_fixture.main = fixture_main
for name, module in [("homeassistant",ha_fixture),("homeassistant.__main__",main_fixture),
                     ("homeassistant.components",components_fixture),("homeassistant.components.http",http_fixture),
                     ("homeassistant.components.http.config",http_config_fixture)]:
    sys.modules[name] = module
exec(${JSON.stringify(HA_LAUNCHER)})
`
  const result = spawnSync(pythonCommand, ['-c', fixture], { encoding: 'utf8', env: { ...process.env, CQAI_HOME_MANAGED_PORT: '57901' } })
  if (result.status !== 0) throw new Error(`Python fixture failed: ${result.stderr}`)
  return JSON.parse(result.stdout.trim()) as ReturnType<typeof launcherFixture>
}

describe.skipIf(!pythonAvailable)('launcher HTTP recovery fixture', () => {
  it('renews the allowed trial through HA store API before the original HTTP loader runs', () => {
    const result = launcherFixture(managed)
    expect(result.accepted).toBe(true)
    expect(result.originalCalls).toBe(1)
    expect(result.bothBindings).toBe(true)
    expect(result.calls).toEqual([{ server_port: 57901, server_host: ['127.0.0.1'], cors_allowed_origins: [] }])
  })

  it.each([
    { ...managed, server_host: ['0.0.0.0'] },
    { ...managed, server_port: 57902 },
    { ...managed, error: 'apply_failed' },
  ])('rejects altered or failed settings before any original HTTP load', pending => {
    const result = launcherFixture(pending)
    expect(result.accepted).toBe(false)
    expect(result.calls).toEqual([])
    expect(result.originalCalls).toBe(0)
  })

  it('blocks unsafe fallback configuration instead of exposing a default listener', () => {
    const result = launcherFixture(managed, { server_port: 8123, server_host: ['0.0.0.0'] })
    expect(result.accepted).toBe(false)
    expect(result.originalCalls).toBe(1)
  })
})
