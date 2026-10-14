export const PACKAGE_NAME = '@cqaiclub/cqai-club-smart-home-plugin'
export const PANEL_ID = 'cqai-club-smart-home'
export const API_PREFIX = '/api/cqai-club-home'
export const HA_VERSION = '2026.10.1'
export const PYTHON_VERSION = '3.14.2'

export type HomePhase = 'idle' | 'installing' | 'starting' | 'authorizing' | 'ready' | 'stopping' | 'stopped' | 'error' | 'repairing'
export interface HomeSettings {
  mode: 'managed' | 'external'
  autoStart: boolean
  familyName: string
  timezone: string
  haVersion: string
  pythonVersion: string
  uvPath: string
  externalBaseUrl: string
}
export interface PublicHomeSettings extends HomeSettings { externalTokenConfigured: boolean }
export interface HomeLog { time: string; level: 'info' | 'warn' | 'error'; message: string }
export interface HomeStatus {
  phase: HomePhase
  message: string
  settings: PublicHomeSettings
  runtimeVersion?: string
  startedAt?: string
  error?: string
  progress?: { step: string; detail?: string }
  logs: HomeLog[]
  backups: { id: string; createdAt: string; size: number }[]
  installed: boolean
}
export interface HomeDiagnostic {
  phase: HomePhase
  mode: 'managed' | 'external'
  platform: string
  architecture: string
  expectedHaVersion: string
  pythonVersion: string
  installed: boolean
  error?: string
  checks: { name: string; ok: boolean; detail: string }[]
  logs: HomeLog[]
  suggestedActions: string[]
}
export interface HaEntity { entity_id: string; state: string; attributes: Record<string, unknown>; last_changed?: string; last_updated?: string }
export type RepairAction = 'restart' | 'reinstall'
export interface HomeController {
  status(): HomeStatus
  start(): Promise<void>
  stop(): Promise<void>
  repair(action: RepairAction): Promise<void>
  diagnose(): Promise<HomeDiagnostic>
  backup(): Promise<{ id: string; createdAt: string; size: number }>
  restore(id: string): Promise<void>
  updateSettings(patch: Partial<HomeSettings> & { externalToken?: string }): Promise<void>
  entities(): Promise<HaEntity[]>
  state(entityId: string): Promise<HaEntity>
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown>
}
export const DEFAULT_SETTINGS: HomeSettings = {
  mode: 'managed', autoStart: true, familyName: '我的家', timezone: 'Asia/Shanghai',
  haVersion: HA_VERSION, pythonVersion: PYTHON_VERSION, uvPath: '', externalBaseUrl: '',
}
