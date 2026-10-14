import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PANEL_ID } from '../protocol'
import { HomePanel } from './HomePanel'
import { HomeIcon } from './icons'

export const inject = ['slots']

function SidebarIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <HomeIcon size={size} />
}

/** Contribute an independent panel through DSH's public UI seats. */
export function apply(ctx: Context): void {
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, HomePanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID as MainPanelId, label: '家庭智能', order: 45,
  }, SidebarIcon))
}
