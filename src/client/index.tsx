import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
import { SessionPurgeController, type SessionRow } from './controller.ts'

const NS = 'session-purge'
type LocaleKey =
  | 'delete' | 'title' | 'body' | 'consent' | 'confirm' | 'cancel' | 'working' | 'menuLabel' | 'failedPrefix'
  | 'selectMode' | 'selectAll' | 'clearSelection' | 'deleteSelected' | 'batchTitle' | 'batchMore' | 'confirmBatch'
  | 'running' | 'currentSession' | 'currentSessionNote' | 'toastDeleted' | 'toastFailed'

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
  selectMode: 'Select sessions',
  selectAll: 'Select all',
  clearSelection: 'Clear',
  deleteSelected: 'Delete {count} selected',
  batchTitle: 'Delete {count} sessions permanently?',
  batchMore: '…and {count} more.',
  confirmBatch: 'Delete {count} permanently',
  running: 'running',
  currentSession: 'current session',
  currentSessionNote: 'The session you are viewing cannot be included in a batch delete.',
  toastDeleted: '{count} sessions deleted',
  toastFailed: 'Deletion failed',
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
  selectMode: '选择会话',
  selectAll: '全选',
  clearSelection: '清除',
  deleteSelected: '删除所选 {count} 个',
  batchTitle: '永久删除 {count} 个会话？',
  batchMore: '……以及另外 {count} 个。',
  confirmBatch: '永久删除 {count} 个',
  running: '运行中',
  currentSession: '当前会话',
  currentSessionNote: '当前所在的会话不能包含在批量删除中。',
  toastDeleted: '已删除 {count} 个会话',
  toastFailed: '删除失败',
}

interface OpenConfirmFace {
  openConfirm: (sessionId: SessionId, title: string) => void
  openBatch: (rows: readonly SessionRow[]) => void
  selectedCount: number
}
type HeaderProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS> & InjectFace<OpenConfirmFace>
type SidebarProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & PropsLocale<typeof NS> & InjectFace<OpenConfirmFace>
type FooterProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<typeof NS> & InjectFace<{ controller: SessionPurgeController }>
type OverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & InjectFace<{ controller: SessionPurgeController }>

const ghostButtonStyle: React.CSSProperties = {
  border: '1px solid var(--dsh-border, #7776)',
  borderRadius: 8,
  padding: '6px 10px',
  cursor: 'pointer',
  background: 'transparent',
  color: 'var(--dsh-text, CanvasText)',
}
const dangerButtonStyle: React.CSSProperties = {
  background: 'var(--dsh-danger, #b42318)',
  color: '#fff',
  border: 0,
  borderRadius: 8,
  padding: '8px 14px',
  cursor: 'pointer',
}

function HeaderAction({ sessionId, openConfirm, selectedCount, t }: HeaderProps) {
  return (
    <button
      type="button"
      aria-label={t('delete')}
      title={t('delete')}
      onClick={() => openConfirm(sessionId, '')}
      style={ghostButtonStyle}
    >
      🗑 {selectedCount > 0 ? `${t('delete')} (${selectedCount})` : t('delete')}
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

function FooterBatchButton({ controller, t }: FooterProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const selectedCount = state.selected.length
  const label = selectedCount > 0 ? t('deleteSelected', { count: selectedCount }) : t('selectMode')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => controller.openBatchFromSelection()}
      style={selectedCount > 0 ? dangerButtonStyle : ghostButtonStyle}
    >
      {selectedCount > 0 ? `🗑 ${label}` : `☑ ${label}`}
    </button>
  )
}

function RowCheckboxInjector({ controller, t }: OverlayProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const observerRef = useRef<MutationObserver | null>(null)
  const injectedRef = useRef(new Set<string>())
  const rowsRef = useRef<Map<string, SessionRow>>(new Map())

  useEffect(() => {
    const getSessionRow = (row: HTMLElement): SessionRow | null => {
      const key = row.dataset.rowKey
      if (!key || !key.startsWith('session:')) return null
      const idStr = key.replace('session:', '')
      const existing = rowsRef.current.get(key)
      if (existing) return existing
      // Try to extract title from the row's title element
      const titleEl = row.querySelector('[data-slot="title"]') || row.firstElementChild
      const title = titleEl instanceof HTMLElement ? titleEl.textContent?.trim() || idStr : idStr
      const sessionId = idStr as SessionId
      const sessionRow: SessionRow = { sessionId, title, running: false }
      rowsRef.current.set(key, sessionRow)
      return sessionRow
    }

    const inject = (row: HTMLElement): void => {
      const key = row.dataset.rowKey
      if (!key || !key.startsWith('session:')) return
      if (injectedRef.current.has(key)) return
      injectedRef.current.add(key)

      const sessionRow = getSessionRow(row)
      if (!sessionRow) return

      const slot = row.querySelector('[data-slot]') || row.firstElementChild
      if (!slot) return
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'dsh-srp-checkbox'
      cb.dataset.sessionId = key.replace('session:', '')
      cb.checked = state.selected.includes(cb.dataset.sessionId as SessionId)
      const onCheck = (): void => {
        controller.toggle(cb.dataset.sessionId as SessionId)
        cb.checked = state.selected.includes(cb.dataset.sessionId as SessionId)
      }
      cb.addEventListener('change', onCheck)
      // Prevent checkbox click from opening the session
      cb.addEventListener('pointerdown', (e: Event) => { e.stopPropagation() })
      slot.appendChild(cb)
    }

    const cleanup = (row: HTMLElement): void => {
      const key = row.dataset.rowKey
      if (!key || !key.startsWith('session:')) return
      if (!injectedRef.current.has(key)) return
      injectedRef.current.delete(key)
      rowsRef.current.delete(key)
      row.querySelectorAll<HTMLInputElement>('.dsh-srp-checkbox').forEach(el => el.remove())
    }

    // Collect all current rows
    const allRows: SessionRow[] = []
    document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]').forEach(row => {
      const sessionRow = getSessionRow(row)
      if (sessionRow) allRows.push(sessionRow)
      inject(row)
    })
    controller.setAvailableRows(allRows)

    // Watch for new rows
    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.dataset.rowKey?.startsWith('session:')) {
            const sessionRow = getSessionRow(node)
            if (sessionRow) {
              allRows.push(sessionRow)
              controller.setAvailableRows([...allRows])
            }
            inject(node)
          }
          node.querySelectorAll<HTMLElement>('[data-row-key^="session:"]').forEach(row => {
            const sessionRow = getSessionRow(row)
            if (sessionRow && !allRows.find(r => r.sessionId === sessionRow.sessionId)) {
              allRows.push(sessionRow)
              controller.setAvailableRows([...allRows])
            }
            inject(row)
          })
        }
        for (const node of m.removedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.dataset.rowKey?.startsWith('session:')) cleanup(node)
          node.querySelectorAll<HTMLElement>('[data-row-key^="session:"]').forEach(cleanup)
        }
      }
    })
    obs.observe(document.body, { childList: true, subtree: true })
    observerRef.current = obs

    return () => {
      obs.disconnect()
      observerRef.current = null
      injectedRef.current.clear()
      rowsRef.current.clear()
    }
  }, [state.selected.length, controller])

  // Inject CSS
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = 'input.dsh-srp-checkbox{flex:none;width:14px;height:14px;margin:0 4px 0 0;cursor:pointer;accent-color:var(--dsh-danger,#b42318)}'
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])

  return null
}

function ConfirmOverlay({ controller, t }: OverlayProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [acknowledgedToken, setAcknowledgedToken] = useState<number | null>(null)
  const target = state.target
  const batch = state.batch
  const token = target !== null ? target.token : batch !== null ? batch.token : null
  const acknowledged = token !== null && acknowledgedToken === token
  if (token === null) return null
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
        style={{ width: 'min(480px, 100%)', maxHeight: 'min(80vh, 720px)', overflowY: 'auto', padding: 24, borderRadius: 14, background: 'var(--dsh-panel, Canvas)', color: 'var(--dsh-text, CanvasText)', boxShadow: '0 18px 60px #0005' }}
      >
        {target !== null
          ? (
            <>
              <h2 id="session-purge-title" style={{ marginTop: 0 }}>{t('title')}</h2>
              <p style={{ overflowWrap: 'anywhere' }}><strong>{target.title || target.sessionId}</strong></p>
            </>
          )
          : (
            <>
              <h2 id="session-purge-title" style={{ marginTop: 0 }}>{t('batchTitle', { count: batch?.items.length ?? 0 })}</h2>
              <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
                {(batch?.items ?? []).slice(0, 6).map(item => (
                  <li key={item.sessionId} style={{ overflowWrap: 'anywhere' }}>{item.title || item.sessionId}</li>
                ))}
                {(batch?.items.length ?? 0) > 6 && (
                  <li style={{ opacity: 0.7 }}>{t('batchMore', { count: (batch?.items.length ?? 0) - 6 })}</li>
                )}
              </ul>
            </>
          )}
        <p>{t('body')}</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '16px 0' }}>
          <input type="checkbox" checked={acknowledged} disabled={state.busy} onChange={event => setAcknowledgedToken(event.target.checked ? token : null)} />
          <span>{t('consent')}</span>
        </label>
        {state.error && <p role="alert" style={{ color: 'var(--dsh-danger, #c33)', whiteSpace: 'pre-wrap' }}>{t('failedPrefix')}: {state.error}</p>}
        {state.itemFailures.length > 0 && (
          <ul role="alert" style={{ color: 'var(--dsh-danger, #c33)', margin: '8px 0', paddingLeft: 20, maxHeight: 160, overflowY: 'auto' }}>
            {state.itemFailures.slice(0, 8).map(failure => (
              <li key={failure.sessionId} style={{ overflowWrap: 'anywhere' }}>
                {failure.title || failure.sessionId}: {failure.error}
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button type="button" disabled={state.busy} onClick={() => controller.close()}>{t('cancel')}</button>
          <button
            type="button"
            disabled={!acknowledged || state.busy}
            onClick={() => void controller.confirm()}
            style={{ ...dangerButtonStyle, cursor: !acknowledged || state.busy ? 'not-allowed' : 'pointer' }}
          >
            {state.busy
              ? t('working')
              : target !== null
                ? t('confirm')
                : t('confirmBatch', { count: batch?.items.length ?? 0 })}
          </button>
        </div>
      </section>
    </div>
  )
}

function ToastOverlay({ controller, t }: OverlayProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  if (!state.toast) return null
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'var(--dsh-panel, Canvas)',
        color: 'var(--dsh-text, CanvasText)',
        padding: '12px 20px',
        borderRadius: 8,
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        zIndex: 10001,
        fontSize: 14,
      }}
    >
      {state.toast}
    </div>
  )
}

export const name = 'session-purge-client'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  const loose = ctx as ClientContext & {
    sessions?: { refresh?: () => void | Promise<void> }
  }
  const controller = new SessionPurgeController(async () => {
    const refresh = loose.sessions?.refresh
    if (typeof refresh !== 'function') {
      console.warn('[session-purge] host exposes no sessions.refresh(); the sidebar keeps cached rows until its next refresh')
      return
    }
    await refresh()
  })

  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'session-purge: dictionaries')

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-purge-header',
    order: 900,
    locale: NS,
    inject: (): OpenConfirmFace => ({
      openConfirm: (sessionId, title) => controller.open(sessionId, title),
      openBatch: () => {},
      selectedCount: controller.getSnapshot().selected.length,
    }),
  }, HeaderAction))

  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'session-purge-sidebar',
    order: 500,
    locale: NS,
    inject: (): OpenConfirmFace => ({
      openConfirm: (sessionId, title) => controller.open(sessionId, title),
      openBatch: () => {},
      selectedCount: controller.getSnapshot().selected.length,
    }),
  }, SidebarMenuItem))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'session-purge-footer',
    order: 100,
    locale: NS,
    inject: () => ({ controller }),
  }, FooterBatchButton))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-purge-row-inject',
    order: 998,
    locale: NS,
    inject: () => ({ controller }),
  }, RowCheckboxInjector))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-purge-dialog',
    order: 999,
    locale: NS,
    inject: () => ({ controller }),
  }, ConfirmOverlay))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-purge-toast',
    order: 1000,
    locale: NS,
    inject: () => ({ controller }),
  }, ToastOverlay))
}
