/** Native bundle configuration and app-wide save feedback, independent of transport reloads. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol/types'
import { controlRemote } from './remote.ts'
import { en, zh, type LocaleKey } from './locales.ts'
import { OneBotPage, NoticeHost, PageProblem, type Notice, type NoticeFace, type PageFace } from './page.tsx'
import styles from './style.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OneBot owner configuration, status and field labels. */
    qqOnebot: LocaleKey
  }
}

/** Runtime services are supplied by the native Web profile. */
export const inject = ['remote', 'locale', 'slots']

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  if (result.error.code === 'qq-onebot/control') throw new PageProblem(result.error.details.reason, result.error.details.field)
  throw new PageProblem('unavailable')
}

/**
 * Register the native bundle page and its independent feedback host.
 * @param ctx - browser Cordis context with the native gateway, locale and slots.
 * @returns completion of explicit Remote namespace installation.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(controlRemote)
  ctx.effect(() => ctx.locale.register('qqOnebot', { en, zh }))
  ctx.effect(() => {
    const element = document.createElement('style')
    element.dataset['qqOnebot'] = 'true'; element.textContent = styles; document.head.append(element)
    return () => element.remove()
  })
  const notice = createSnapshotStore<Notice | null>(null)
  let serial = 0
  ctx.inject(['remote.qqOnebotControl'], child => {
    const face: PageFace = {
      read: async () => unwrap(await child.remote.qqOnebotControl.describe()),
      save: async request => unwrap(await child.remote.qqOnebotControl.save(request)),
      restart: async request => unwrap(await child.remote.qqOnebotControl.restart(request)),
      notify: (text, success) => notice.set({ id: ++serial, text, success }),
    }
    child.slots.inject('plugins.bundle.config', () => child.slots.register({
      name: 'plugins.bundle.config', key: 'dsh-qq-onebot', locale: 'qqOnebot', inject: () => face,
    }, OneBotPage))
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'qq-onebot.notice',
    inject: (): NoticeFace => ({ hooks: { notice }, dismiss: id => { if (notice.getSnapshot()?.id === id) notice.set(null) } }),
  }, NoticeHost))
}
