import type { HomeSettings } from '../protocol.js'

export const MANAGED_YAML_PREFIX = '# Managed by CQAI Club Smart Home; use the plugin settings.\n'

/** A full dashboard and device/control baseline, without HA's optional voice/cloud stack. */
export const NATIVE_COMPONENTS = [
  'frontend', 'api', 'config', 'person', 'automation', 'script', 'scene',
  'recorder', 'history', 'logbook', 'energy', 'ssdp', 'zeroconf', 'dhcp',
  'usb', 'mobile_app', 'sun', 'webhook', 'my',
] as const

const componentYaml = NATIVE_COMPONENTS.map(domain => `${domain}:\n`).join('')

export function nativeConfiguration(settings: Pick<HomeSettings, 'familyName' | 'timezone'>, port: number): string {
  // JSON strings are also valid YAML scalars, and cannot inject extra configuration.
  return `${MANAGED_YAML_PREFIX}${componentYaml}homeassistant:\n  name: ${JSON.stringify(settings.familyName)}\n  time_zone: ${JSON.stringify(settings.timezone)}\nhttp:\n  server_host: 127.0.0.1\n  server_port: ${port}\n`
}

/** Only our original complete template is eligible; any user-added YAML stays untouched. */
export function migrateLegacyConfiguration(source: string): string | undefined {
  const jsonScalar = '"(?:[^"\\\\]|\\\\.)*"'
  const template = new RegExp('^# Managed by CQAI Club Smart Home; use the plugin settings\\.\\ndefault_config:\\nhomeassistant:\\n  name: (' + jsonScalar + ')\\n  time_zone: (' + jsonScalar + ')\\nhttp:\\n  server_host: 127\\.0\\.0\\.1\\n  server_port: (\\d+)\\n$')
  const match = template.exec(source)
  if (!match) return undefined
  try {
    if (typeof JSON.parse(match[1]!) !== 'string' || typeof JSON.parse(match[2]!) !== 'string') return undefined
    const port = Number(match[3])
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return undefined
  } catch { return undefined }
  return source.replace('default_config:\n', componentYaml)
}
