import React, { useState, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, LocaleDictOf, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionPurgeController } from './controller.ts'

const NS = 'session-purge'
type LocaleKey = 'delete' | 'title' | 'body' | 'consent' | 'confirm' | 'cancel' | 'working' | 'menuLabel' | 'failedPrefix'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-purge': LocaleKey
  }
}

const en: LocaleDictOf<typeof NS> = {
  delete: 'Delete session',
  title: 'Delete this session permanently?',
  body: 'This permanently removes the session log and attempts to clear derived cache and workspace membership. This action cannot be undone.',
  consent: 'I understand this is permanent and cannot be undone.',
  confirm: 'Delete permanently',
  cancel: 'Cancel',
  working: 'Deleting…',
  menuLabel: 'Delete session',
  failedPrefix: 'Deletion failed',
}
const zh: LocaleDictOf<typeof NS> = {
  delete: '删除会话',
  title: '永久删除此会话？',
  body: '这将永久删除会话日志，并尝试清理派生缓存和工作区归属。此操作无法撤销。',
  consent: '我理解此操作是永久性的，且无法撤销。',
  confirm: '永久删除',
  cancel: '取消',
  working: '正在删除…',
  menuLabel: '删除会话',
  failedPrefix: '删除失败',
}

interface OpenConfirmFace {
  openConfirm: (sessionId: SessionId, title: string) => void
}
type HeaderProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS> & InjectFace<OpenConfirmFace>
type SidebarProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & PropsLocale<typeof NS> & InjectFace<OpenConfirmFace>
type OverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & InjectFace<{ controller: SessionPurgeController }>

function HeaderAction({ sessionId, openConfirm, t }: HeaderProps) {
  return (
    <button
      type="button"
      aria-label={t('delete')}
      title={t('delete')}
      onClick={() => openConfirm(sessionId, '')}
      style={{ border: '1px solid var(--dsh-border, #7776)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}
    >
      🗑 {t('delete')}
    </button>
  )
}

function SidebarMenuItem({ sessionId, displayTitle, useMenuOpenState, openConfirm, t }: SidebarProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton separatorBefore onSelect={() => {
      setMenuOpen(false)
      openConfirm(sessionId, displayTitle)
    }}>
      🗑 {t('menuLabel')}
    </MenuItemButton>
  )
}

function ConfirmOverlay({ controller, t }: OverlayProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [acknowledgedToken, setAcknowledgedToken] = useState<number | null>(null)
  const target = state.target
  const acknowledged = target !== null && acknowledgedToken === target.token

  if (!target) return null
  return (
    <div
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget && !state.busy) controller.close() }}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#0008', display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-purge-title"
        style={{ width: 'min(480px, 100%)', padding: 24, borderRadius: 14, background: 'var(--dsh-panel, Canvas)', color: 'var(--dsh-text, CanvasText)', boxShadow: '0 18px 60px #0005' }}
      >
        <h2 id="session-purge-title" style={{ marginTop: 0 }}>{t('title')}</h2>
        <p style={{ overflowWrap: 'anywhere' }}><strong>{target.title || target.sessionId}</strong></p>
        <p>{t('body')}</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '16px 0' }}>
          <input type="checkbox" checked={acknowledged} disabled={state.busy} onChange={event => setAcknowledgedToken(event.target.checked ? target.token : null)} />
          <span>{t('consent')}</span>
        </label>
        {state.error && <p role="alert" style={{ color: 'var(--dsh-danger, #c33)', whiteSpace: 'pre-wrap' }}>{t('failedPrefix')}: {state.error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button type="button" disabled={state.busy} onClick={() => controller.close()}>{t('cancel')}</button>
          <button
            type="button"
            disabled={!acknowledged || state.busy}
            onClick={() => void controller.confirm()}
            style={{ background: 'var(--dsh-danger, #b42318)', color: '#fff', border: 0, borderRadius: 8, padding: '8px 14px', cursor: !acknowledged || state.busy ? 'not-allowed' : 'pointer' }}
          >
            {state.busy ? t('working') : t('confirm')}
          </button>
        </div>
      </section>
    </div>
  )
}

export const name = 'session-purge-client'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  const loose = ctx as ClientContext & {
    sessions?: { list?: { refreshInPlace?: () => void | Promise<void> } }
  }
  const controller = new SessionPurgeController(async () => {
    await loose.sessions?.list?.refreshInPlace?.()
  })

  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-purge: dictionaries')

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-purge-header',
    order: 900,
    locale: NS,
    inject: (): OpenConfirmFace => ({ openConfirm: (sessionId, title) => controller.open(sessionId, title) }),
  }, HeaderAction))

  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'session-purge-sidebar',
    order: 500,
    locale: NS,
    inject: (): OpenConfirmFace => ({ openConfirm: (sessionId, title) => controller.open(sessionId, title) }),
  }, SidebarMenuItem))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-purge-dialog',
    locale: NS,
    inject: () => ({ controller }),
  }, ConfirmOverlay))
}
