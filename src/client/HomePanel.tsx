import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { type HomeDiagnostic, type HomePhase, type HomeSettings, type HomeStatus, type RepairAction } from '../protocol'
import { HomeApi, frameUrl, settingsPatch, validateSettings } from './api'
import { HomeIcon } from './icons'
import { HOME_STYLES } from './styles'

const DEFAULT_API = new HomeApi()
const PHASE_LABEL: Record<HomePhase, string> = {
  idle: '尚未启动', installing: '正在安装', starting: '正在启动', authorizing: '正在准备连接',
  ready: '已就绪', stopping: '正在停止', stopped: '已停止', error: '需要处理', repairing: '正在修复',
}
const TRANSIENT = new Set<HomePhase>(['installing', 'starting', 'authorizing', 'stopping', 'repairing'])
const failure = (error: unknown) => error instanceof Error ? error.message : '操作没有完成，请刷新状态后重试。'

function sizeLabel(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 ** 2).toFixed(1)} MB`
}
function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function Field({ name, label, help, error, children }: { name: string; label: string; help?: string; error?: string; children: ReactNode }) {
  return <div className="cqaiHome-field"><label htmlFor={`cqai-home-${name}`}>{label}</label>{children}
    {help && <small id={`cqai-home-${name}-help`}>{help}</small>}
    {error && <small className="field-error" id={`cqai-home-${name}-error`}>{error}</small>}
  </div>
}

export function HomePanel({ api = DEFAULT_API, initialStatus, initialTab = 'home' }: { api?: HomeApi; initialStatus?: HomeStatus; initialTab?: 'home' | 'environment' | 'settings' }) {
  const [status, setStatus] = useState<HomeStatus | undefined>(initialStatus)
  const [tab, setTab] = useState<'home' | 'environment' | 'settings'>(initialTab)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [notice, setNotice] = useState('')
  const [lastUpdated, setLastUpdated] = useState<string>()
  const [draft, setDraft] = useState<HomeSettings | undefined>(initialStatus?.settings)
  const [externalToken, setExternalToken] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof HomeSettings | 'externalToken', string>>>({})
  const [diagnostic, setDiagnostic] = useState<HomeDiagnostic>()
  const [confirm, setConfirm] = useState<{ action: 'restore'; id: string } | { action: 'reinstall' }>()
  const [frame, setFrame] = useState<string>()
  const [frameError, setFrameError] = useState('')
  const [frameLoading, setFrameLoading] = useState(false)
  const mounted = useRef(true)
  const requestInFlight = useRef(false)
  const mutationInFlight = useRef(false)
  const currentStatus = useRef(status)
  const frameGeneration = useRef(0)

  const load = useCallback(async (): Promise<HomeStatus | undefined> => {
    if (requestInFlight.current) return undefined
    requestInFlight.current = true
    try {
      const next = await api.status()
      if (mounted.current) {
        setStatus(next); currentStatus.current = next; setLastUpdated(new Date().toLocaleTimeString('zh-CN', { hour12: false }))
        setDraft(previous => previous ?? { ...next.settings }); setConnectionError('')
      }
      return next
    } catch (err) { if (mounted.current) setConnectionError(failure(err)); return undefined }
    finally { requestInFlight.current = false }
  }, [api])

  useEffect(() => {
    mounted.current = true
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      if (disposed) return
      if (document.visibilityState !== 'hidden') await load()
      if (!disposed) timer = setTimeout(poll, currentStatus.current && TRANSIENT.has(currentStatus.current.phase) ? 2000 : 5000)
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') void load() }
    void poll()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { disposed = true; mounted.current = false; clearTimeout(timer); document.removeEventListener('visibilitychange', onVisibility); frameGeneration.current++ }
  }, [load])

  const refreshFrame = useCallback(async () => {
    const generation = ++frameGeneration.current
    setFrame(undefined); setFrameError(''); setFrameLoading(true)
    try {
      const result = await api.frame()
      const next = frameUrl(result.url, window.location.origin)
      if (mounted.current && generation === frameGeneration.current) setFrame(next)
    } catch (err) {
      if (mounted.current && generation === frameGeneration.current) { setFrameError(failure(err)); setFrameLoading(false) }
    }
  }, [api])

  useEffect(() => {
    // The iframe entry ticket is single-use: re-entering this tab needs a fresh handoff.
    if (status?.phase === 'ready' && tab === 'home') void refreshFrame()
    else { frameGeneration.current++; setFrame(undefined); setFrameError(''); setFrameLoading(false) }
  }, [tab, status?.phase, status?.startedAt, status?.runtimeVersion, status?.settings.mode, status?.settings.externalBaseUrl, refreshFrame])

  async function run(label: string, operation: () => Promise<unknown>, success?: string) {
    if (mutationInFlight.current) return
    mutationInFlight.current = true; setBusy(label); setNotice(''); setError('')
    try {
      await operation()
      await load()
      if (mounted.current && success) setNotice(success)
    } catch (err) { if (mounted.current) setError(failure(err)) }
    finally { mutationInFlight.current = false; if (mounted.current) setBusy(undefined) }
  }

  const changing = !!status && TRANSIENT.has(status.phase)
  const disabled = !!busy || changing
  const managed = status?.settings.mode === 'managed'
  const running = status?.phase === 'ready'
  const mayStart = !!status && ['idle', 'stopped', 'error'].includes(status.phase)
  const mayStop = !!status && ['ready', 'starting', 'authorizing'].includes(status.phase)
  const action = (label: string, operation: () => Promise<unknown>, success?: string) => () => { void run(label, operation, success) }
  const repair = (repairAction: RepairAction) => run(repairAction === 'restart' ? '正在重新启动' : '正在重新安装', () => api.repair(repairAction))

  async function saveSettings(event: FormEvent) {
    event.preventDefault()
    if (!draft) return
    const errors = validateSettings(draft)
    if (draft.mode === 'external' && !status?.settings.externalTokenConfigured && !externalToken.trim()) {
      Object.assign(errors, { externalToken: '首次连接请填写 Home Assistant 长期访问令牌。' })
    }
    setFieldErrors(errors)
    if (Object.keys(errors).length) {
      setError('设置尚未保存，请检查下方标记的项目。')
      const name = Object.keys(errors)[0]
      requestAnimationFrame(() => {
        const field = document.getElementById(`cqai-home-${name}`)
        field?.closest('details')?.setAttribute('open', '')
        field?.focus()
      })
      return
    }
    const patch = settingsPatch(draft, externalToken)
    await run('正在保存设置', async () => {
      await api.settings(patch)
      setExternalToken('')
      const next = await api.status()
      if (mounted.current) { setStatus(next); currentStatus.current = next; setDraft({ ...next.settings }) }
    }, '设置已保存。')
  }

  const input = (key: keyof HomeSettings, options: { type?: string; help?: string; placeholder?: string } = {}) => {
    const fieldError = fieldErrors[key]
    return <input id={`cqai-home-${key}`} type={options.type ?? 'text'} value={String(draft?.[key] ?? '')}
      placeholder={options.placeholder} aria-invalid={!!fieldError}
      aria-describedby={[options.help && `cqai-home-${key}-help`, fieldError && `cqai-home-${key}-error`].filter(Boolean).join(' ') || undefined}
      onChange={event => { setDraft(previous => previous && { ...previous, [key]: event.target.value }); setFieldErrors(previous => ({ ...previous, [key]: undefined })) }} />
  }

  return <section className="cqaiHome" aria-label="家庭智能管理">
    <style>{HOME_STYLES}</style>
    <div className="cqaiHome-shell">
      <header className="cqaiHome-header">
        <div className="cqaiHome-brand"><div className="cqaiHome-mark"><HomeIcon size={25} /></div><div>
          <h1>{status?.settings.familyName || '家庭智能'}</h1><div className="cqaiHome-subtitle">连接你的家，管理每一份舒适</div>
        </div></div>
        <div className="cqaiHome-actions"><button onClick={() => { void load() }} disabled={!!busy} aria-label="刷新家庭运行状态"><HomeIcon name="refresh" />刷新状态</button></div>
      </header>
      <nav className="cqaiHome-tabs" aria-label="家庭管理页面">
        <button aria-current={tab === 'home' ? 'page' : undefined} onClick={() => setTab('home')}><HomeIcon />家庭面板</button>
        <button aria-current={tab === 'environment' ? 'page' : undefined} onClick={() => setTab('environment')}><HomeIcon name="shield" />环境与备份</button>
        <button aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => setTab('settings')}><HomeIcon name="settings" />连接设置</button>
      </nav>
      {(error || connectionError) && <div className="cqaiHome-banner error" role="alert"><HomeIcon name="info" /><span>{error || connectionError}</span></div>}
      {notice && <div className="cqaiHome-banner success" role="status"><HomeIcon name="check" /><span>{notice}</span></div>}
      {busy && <div className="cqaiHome-banner" role="status"><span className="cqaiHome-spinner" /><span>{busy}，运行状态会持续更新。</span></div>}
      <div className="cqaiHome-status">
        <div className="cqaiHome-status-copy"><span className="cqaiHome-badge" data-error={status?.phase === 'error' || !!connectionError}><span />{connectionError ? '状态待刷新' : status ? PHASE_LABEL[status.phase] : '正在读取状态'}</span>
          {lastUpdated && <span className="cqaiHome-updated">更新于 {lastUpdated}</span>}
          <p aria-live="polite">{status?.message || '正在连接家庭服务…'}{status && ` · ${managed ? '本机托管 Home Assistant' : '连接已有 Home Assistant'}`}</p>
        </div>
        <div className="cqaiHome-actions">
          <button className="primary" disabled={!mayStart || !!busy} onClick={action('正在启动家庭环境', () => api.start())}><HomeIcon name="play" />{managed && !status?.installed ? '安装并启动' : '启动连接'}</button>
          <button disabled={!mayStop || !!busy} onClick={action(managed ? '正在停止家庭环境' : '正在断开连接', () => api.stop())}><HomeIcon name="stop" />{managed ? '停止' : '断开连接'}</button>
        </div>
      </div>
      {tab === 'home' && <>
        <div className="cqaiHome-frame">
          {running && frame ? <>
            {frameLoading && <div className="cqaiHome-frame-loading" role="status"><span className="cqaiHome-spinner" style={{ marginRight: 10 }} />正在载入家庭界面…</div>}
            <iframe key={frame} src={frame} title="Home Assistant 家庭管理" allow="clipboard-write; fullscreen" referrerPolicy="no-referrer" onLoad={() => setFrameLoading(false)} />
          </> : <div className="cqaiHome-empty">
            <div className="cqaiHome-mark">{changing || frameLoading ? <span className="cqaiHome-spinner" /> : <HomeIcon size={34} />}</div>
            <h2>{frameError ? '家庭界面暂时无法打开' : running ? '正在打开家庭界面' : changing ? PHASE_LABEL[status!.phase] : status?.phase === 'error' ? '家庭环境需要处理' : '在一个地方，连接家里的设备'}</h2>
            <p>{frameError || status?.error || (changing ? '首次启动会准备独立的 Home Assistant 环境。请保持 e宝工坊运行，完成后会自动打开完整家庭面板。' : '使用 Home Assistant 统一接入设备、安排自动化，并按房间管理你的家。')}</p>
            {status?.progress && <div className="cqaiHome-progress" role="progressbar" aria-label="家庭环境准备进度" aria-valuetext={status.progress.step}><strong>{status.progress.step}</strong>{status.progress.detail && <div className="cqaiHome-help">{status.progress.detail}</div>}<div className="cqaiHome-progress-track" /></div>}
            <div className="cqaiHome-actions">
              {running && <button onClick={() => { void refreshFrame() }} disabled={frameLoading}><HomeIcon name="refresh" />重新载入界面</button>}
              {mayStart && <button className="primary" disabled={disabled} onClick={action('正在启动家庭环境', () => api.start())}><HomeIcon name="play" />{managed && !status?.installed ? '安装并启动 Home Assistant' : '启动家庭环境'}</button>}
              {status?.phase === 'error' && <button onClick={() => { setTab('environment'); void run('正在诊断', async () => setDiagnostic(await api.diagnose())) }} disabled={disabled}>查看故障诊断</button>}
              <button onClick={() => setTab('settings')}>连接设置</button>
            </div>
          </div>}
        </div>
        <div className="cqaiHome-actions" style={{ justifyContent: 'space-between', marginTop: 12 }}>
          <p className="cqaiHome-help" style={{ margin: 0 }}>涂鸦、Aqara 等品牌的账号登录与设备配对，请在 Home Assistant 的「设置 → 设备与服务」完成。</p>
          {running && <button disabled={!!busy || frameLoading} onClick={() => { void refreshFrame() }}><HomeIcon name="refresh" />刷新家庭界面</button>}
        </div>
      </>}
      {tab === 'environment' && <div className="cqaiHome-grid">
        <section className="cqaiHome-card"><h2>运行环境</h2><p className="cqaiHome-help">{managed ? '插件只管理自己的独立运行环境。' : '当前连接已有实例，安装、数据和备份由该实例维护。'}</p>
          <dl className="cqaiHome-facts"><dt>运行方式</dt><dd>{managed ? '本机托管' : '外部实例'}</dd><dt>环境状态</dt><dd>{status ? PHASE_LABEL[status.phase] : '读取中'}</dd><dt>Home Assistant</dt><dd>{status?.runtimeVersion || '尚未读取运行版本'}</dd>{managed && <><dt>本机环境已安装</dt><dd>{status?.installed ? '是' : '否'}</dd><dt>HA 目标版本</dt><dd>{status?.settings.haVersion ?? '—'}</dd><dt>Python 目标版本</dt><dd>{status?.settings.pythonVersion ?? '—'}</dd></>}<dt>{managed ? '启动时间' : '连接时间'}</dt><dd>{status?.startedAt ? dateLabel(status.startedAt) : '尚未启动'}</dd></dl>
          <div className="cqaiHome-actions"><button disabled={!status || disabled} onClick={() => { void repair('restart') }}><HomeIcon name="refresh" />{managed ? '重新启动' : '重新连接'}</button><button disabled={!managed || disabled} onClick={() => setConfirm({ action: 'reinstall' })}><HomeIcon name="wrench" />重新安装环境</button></div>
          {confirm?.action === 'reinstall' && <div className="cqaiHome-confirm" role="group" aria-labelledby="cqai-home-reinstall-title"><h3 id="cqai-home-reinstall-title">重新安装本机环境</h3><p>仅重建插件管理的 Python 与 Home Assistant 环境，家庭配置保留。建议先创建备份。</p><div className="cqaiHome-actions"><button className="danger" disabled={disabled} onClick={() => { setConfirm(undefined); void repair('reinstall') }}>确认重新安装</button><button onClick={() => setConfirm(undefined)}>取消</button></div></div>}
        </section>
        <section className="cqaiHome-card"><h2>家庭备份</h2><p className="cqaiHome-help">{managed ? '备份家庭配置与数据，便于恢复本机托管实例。' : '当前为外部实例，请在该实例的 Home Assistant 内维护备份。'}</p><button disabled={!managed || !status?.installed || disabled} onClick={action('正在创建备份', () => api.backup(), '家庭备份已创建。')}><HomeIcon name="archive" />创建备份</button>
          <ul className="cqaiHome-list" aria-label="家庭备份列表">{status?.backups.map(backup => <li key={backup.id}><div><strong>{dateLabel(backup.createdAt)}</strong><div className="cqaiHome-help">{sizeLabel(backup.size)}</div></div><button disabled={!managed || disabled} onClick={() => setConfirm({ action: 'restore', id: backup.id })}>恢复此备份</button></li>)}</ul>
          {!status?.backups.length && <p className="cqaiHome-help" style={{ marginTop: 16 }}>还没有备份。</p>}
          {confirm?.action === 'restore' && <div className="cqaiHome-confirm" role="group" aria-labelledby="cqai-home-restore-title"><h3 id="cqai-home-restore-title">恢复选中的家庭备份</h3><p>当前家庭配置与数据将被备份替换，托管实例会重新启动。请先保存当前备份。</p><div className="cqaiHome-actions"><button className="danger" disabled={disabled} onClick={action('正在恢复备份', () => { const id = confirm.id; setConfirm(undefined); return api.restore(id) }, '家庭备份已恢复。')}>确认恢复</button><button onClick={() => setConfirm(undefined)}>取消</button></div></div>}
        </section>
        <section className="cqaiHome-card full"><div className="cqaiHome-header" style={{ marginBottom: 0 }}><div><h2>故障诊断</h2><p className="cqaiHome-help">检查连接、运行环境和启动日志，再选择适合的修复操作。</p></div><button disabled={!!busy} onClick={() => { void run('正在诊断家庭环境', async () => setDiagnostic(await api.diagnose())) }}><HomeIcon name="shield" />运行诊断</button></div>
          {diagnostic && <><p className="cqaiHome-help">{diagnostic.platform} / {diagnostic.architecture} · 目标 HA {diagnostic.expectedHaVersion}</p><div className="cqaiHome-checks">{diagnostic.checks.map((check, index) => <div className="cqaiHome-check" key={`${check.name}-${index}`}><HomeIcon name={check.ok ? 'check' : 'info'} style={{ color: check.ok ? 'var(--home-accent)' : 'var(--home-error)' }} /><div><strong>{check.ok ? '通过' : '需处理'} · {check.name}</strong><small>{check.detail}</small></div></div>)}</div>{diagnostic.error && <p role="alert">{diagnostic.error}</p>}{diagnostic.suggestedActions.length > 0 && <div><h3>建议处理</h3><ul>{diagnostic.suggestedActions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}</ul></div>}</>}
          <details><summary>最近运行日志</summary><div className="cqaiHome-logs" tabIndex={0} aria-label="家庭环境运行日志">{(diagnostic?.logs ?? status?.logs ?? []).slice(-60).map((entry, index) => <div className={entry.level === 'error' ? 'cqaiHome-log-error' : undefined} key={`${entry.time}-${index}`}>{dateLabel(entry.time)} [{entry.level}] {entry.message}</div>)}{!(diagnostic?.logs ?? status?.logs ?? []).length && '暂无运行日志。'}</div></details>
        </section>
      </div>}
      {tab === 'settings' && <section className="cqaiHome-card cqaiHome-form"><h2>连接设置</h2><p className="cqaiHome-help">选择插件托管的本机环境，或连接家中已经运行的 Home Assistant。</p>
        {!draft ? <p role="status">正在读取设置…</p> : <form onSubmit={event => { void saveSettings(event) }} noValidate><fieldset disabled={!!busy}>
          <div className="cqaiHome-field-grid"><Field name="familyName" label="家庭名称" error={fieldErrors.familyName}>{input('familyName')}</Field><Field name="timezone" label="家庭时区" help="例如 Asia/Shanghai。" error={fieldErrors.timezone}>{input('timezone', { help: '时区', placeholder: 'Asia/Shanghai' })}</Field></div>
          <Field name="mode" label="连接方式"><select id="cqai-home-mode" value={draft.mode} onChange={event => { setDraft({ ...draft, mode: event.target.value as HomeSettings['mode'] }); setExternalToken('') }}><option value="managed">本机托管 · 自动管理 Home Assistant</option><option value="external">已有实例 · 连接现有 Home Assistant</option></select></Field>
          <label className="cqaiHome-checkbox"><input type="checkbox" checked={draft.autoStart} onChange={event => setDraft({ ...draft, autoStart: event.target.checked })} />随 e宝工坊自动启动家庭连接</label>
          {draft.mode === 'external' && <><Field name="externalBaseUrl" label="Home Assistant 地址" help="填写现有实例的根地址，例如 http://192.168.1.10:8123。" error={fieldErrors.externalBaseUrl}>{input('externalBaseUrl', { help: '地址', type: 'url', placeholder: 'http://192.168.1.10:8123' })}</Field>
            <Field name="externalToken" label="长期访问令牌" help={status?.settings.externalTokenConfigured ? '访问令牌已保存。输入新令牌可替换，留空保持现有令牌。' : '在 Home Assistant 个人资料 → 安全中创建长期访问令牌。'} error={fieldErrors.externalToken}>
              <input id="cqai-home-externalToken" type="password" value={externalToken} autoComplete="new-password" spellCheck={false} aria-invalid={!!fieldErrors.externalToken} aria-describedby={`cqai-home-externalToken-help${fieldErrors.externalToken ? ' cqai-home-externalToken-error' : ''}`} onChange={event => { setExternalToken(event.target.value); setFieldErrors(previous => ({ ...previous, externalToken: undefined })) }} />
            </Field></>}
          <details><summary>版本与高级设置</summary><p className="cqaiHome-help">修改版本后，先创建备份，再通过「重新安装环境」应用于本机托管实例。</p><div className="cqaiHome-field-grid"><Field name="haVersion" label="Home Assistant 版本" error={fieldErrors.haVersion}>{input('haVersion')}</Field><Field name="pythonVersion" label="Python 版本" error={fieldErrors.pythonVersion}>{input('pythonVersion')}</Field></div><Field name="uvPath" label="uv 可执行文件（可选）" help="留空使用插件提供的 uv，不会修改系统 Python。">{input('uvPath', { help: '运行工具' })}</Field></details>
          <div className="cqaiHome-form-footer"><button className="primary" type="submit"><HomeIcon name="check" />保存设置</button><button type="button" onClick={() => { if (status) setDraft({ ...status.settings }); setExternalToken(''); setFieldErrors({}) }}>放弃更改</button></div>
        </fieldset></form>}
      </section>}
    </div>
  </section>
}
