import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Context } from '@deepseek-ai/cordis'
import { API_PREFIX, DEFAULT_SETTINGS, PANEL_ID, type HomeStatus } from '../src/protocol'
import { HomeApi, frameUrl, settingsPatch, validateSettings } from '../src/client/api'
import { HomePanel } from '../src/client/HomePanel'
import { apply } from '../src/client/index'

const status: HomeStatus = {
  phase: 'idle', message: '等待首次启动', settings: { ...DEFAULT_SETTINGS, externalTokenConfigured: false },
  installed: false, backups: [], logs: [],
}

describe('家庭智能客户端边界', () => {
  it('writes settings through the declared patch envelope and never writes public credential metadata', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    const api = new HomeApi(fetcher)
    const patch = settingsPatch({ ...status.settings, familyName: '  家庭  ' }, '')
    await api.settings(patch)
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${API_PREFIX}/settings`)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(JSON.parse(init.body as string)).toEqual({ patch: { ...DEFAULT_SETTINGS, familyName: '家庭' } })
    expect(patch).not.toHaveProperty('externalTokenConfigured')
    expect(patch).not.toHaveProperty('externalToken')
    expect(settingsPatch({ ...DEFAULT_SETTINGS, mode: 'external' }, ' replacement-token ')).toHaveProperty('externalToken', 'replacement-token')
    expect(settingsPatch(DEFAULT_SETTINGS, 'not-for-managed')).not.toHaveProperty('externalToken')
  })

  it('uses exact operation payloads for constrained repair and backup restoration', async () => {
    const requests: { url: string; body: unknown }[] = []
    const api = new HomeApi(async (url, init) => {
      requests.push({ url, body: JSON.parse(init?.body as string) })
      return new Response('{}')
    })
    await api.repair('restart'); await api.repair('reinstall'); await api.restore('backup-id'); await api.frame()
    expect(requests).toEqual([
      { url: `${API_PREFIX}/repair`, body: { action: 'restart' } },
      { url: `${API_PREFIX}/repair`, body: { action: 'reinstall' } },
      { url: `${API_PREFIX}/restore`, body: { id: 'backup-id' } },
      { url: `${API_PREFIX}/frame`, body: {} },
    ])
  })

  it('explains failed requests and admits only Host or constrained loopback frame handoffs', async () => {
    await expect(new HomeApi(async () => { throw new TypeError('Failed to fetch') }).status()).rejects.toThrow('无法连接家庭服务')
    await expect(new HomeApi(async () => new Response('{"error":"环境未启动"}', { status: 409 })).frame()).rejects.toThrow('环境未启动')
    await expect(new HomeApi(async () => new Response('<html>proxy error</html>', { status: 502 })).status()).rejects.toThrow('无法读取的响应')
    expect(frameUrl('/api/cqai-club-home/gateway/one-use', 'http://localhost:3000')).toBe('http://localhost:3000/api/cqai-club-home/gateway/one-use')
    const ticket = 'a'.repeat(43)
    expect(frameUrl(`http://127.0.0.1:48123/session/${ticket}`, 'http://localhost:3000')).toBe(`http://127.0.0.1:48123/session/${ticket}`)
    for (const url of [`http://localhost:48123/session/${ticket}`, `http://127.0.0.1:48123/session/short`, `http://127.0.0.1:48123/session/${ticket}?token=secret`, `http://127.0.0.1:48123/session/${ticket}#secret`, `https://127.0.0.1:48123/session/${ticket}`, `http://127.0.0.1:48123/other/${ticket}`]) {
      expect(() => frameUrl(url, 'http://localhost:3000')).toThrow('不属于')
    }
    expect(() => frameUrl('https://other.example/secret', 'http://localhost:3000')).toThrow('不属于')
    expect(() => frameUrl('javascript:alert(1)', 'http://localhost:3000')).toThrow('不属于')
  })

  it('validates external addresses without permitting credential URLs and validates timezone', () => {
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual({})
    expect(validateSettings({ ...DEFAULT_SETTINGS, mode: 'external', externalBaseUrl: 'https://user:secret@home.example' }).externalBaseUrl).toBeDefined()
    expect(validateSettings({ ...DEFAULT_SETTINGS, mode: 'external', externalBaseUrl: 'http://home.local:8123/?token=secret' }).externalBaseUrl).toBeDefined()
    expect(validateSettings({ ...DEFAULT_SETTINGS, mode: 'external', externalBaseUrl: 'http://home.local:8123' })).toEqual({})
    expect(validateSettings({ ...DEFAULT_SETTINGS, timezone: 'not-a-timezone' }).timezone).toBeDefined()
  })

  it('renders installation progress and honestly leaves actual device pairing to Home Assistant', () => {
    const html = renderToStaticMarkup(<HomePanel initialStatus={{ ...status, phase: 'installing', progress: { step: '安装 Home Assistant', detail: '准备独立环境' } }} />)
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('准备独立环境')
    expect(html).toContain('设备配对')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('disabled=""')
  })

  it('renders external settings with a labeled empty password field and existing-token presence only', () => {
    const html = renderToStaticMarkup(<HomePanel initialTab="settings" initialStatus={{ ...status, settings: { ...status.settings, mode: 'external', externalTokenConfigured: true } }} />)
    expect(html).toContain('访问令牌已保存')
    expect(html).toContain('for="cqai-home-externalToken"')
    expect(html).toMatch(/id="cqai-home-externalToken"[^>]*type="password"[^>]*value=""/)
    expect(html).toContain('留空保持现有令牌')
  })

  it('registers a sidebar entry that addresses its own main panel without replacing the sidebar', () => {
    const entries: { name: string; key?: string; id?: string; label?: string }[] = []
    const seats: string[] = []
    const ctx = { slots: {
      inject: (name: string, callback: () => unknown) => { seats.push(name); callback() },
      register: (options: typeof entries[number]) => { entries.push(options); return () => {} },
    } } as unknown as Context
    apply(ctx)
    expect(seats).toEqual(['main', 'sidebar.panellist'])
    expect(entries[0]?.key).toBe(PANEL_ID)
    expect(entries[1]?.id).toBe(entries[0]?.key)
    expect(entries[1]?.label).toBe('家庭智能')
  })
})
