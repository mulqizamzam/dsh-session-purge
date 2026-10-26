import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
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
type HeaderProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS> & InjectFace<{ controller: SessionPurgeController }>
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

function HeaderAction({ sessionId, controller, t }: HeaderProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const selectedCount = state.selected.length
  const label = selectedCount > 0 ? t('deleteSelected', { count: selectedCount }) : t('delete')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => selectedCount > 0 ? controller.openBatchFromSelection() : controller.open(sessionId, '')}
      style={selectedCount > 0 ? dangerButtonStyle : ghostButtonStyle}
    >
      {selectedCount > 0 ? `🗑 ${label}` : `🗑 ${t('delete')}`}
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

function RowCheckboxInjector({ controller }: OverlayProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const rowsRef = useRef<Map<string, SessionRow>>(new Map())
  const boxesRef = useRef<Map<string, HTMLElement>>(new Map())   // session rowKey -> box
  const wsBoxesRef = useRef<Map<string, HTMLElement>>(new Map()) // workspace key -> box
  const syncRef = useRef<() => void>(() => {})

  /** Sync aria-checked/data-state on all injected checkboxes from current selection. */
  const syncBoxes = (): void => {
    const selected = new Set<string>(controller.getSnapshot().selected.map(id => String(id)))
    boxesRef.current.forEach((box, key) => {
      const id = key.slice('session:'.length)
      const on = selected.has(id)
      box.dataset.state = on ? 'on' : 'off'
      box.setAttribute('aria-checked', on ? 'true' : 'false')
    })
    wsBoxesRef.current.forEach((box, key) => {
      const group = document.querySelector<HTMLElement>(`[data-row-key="${key}"]`)
        ?.closest('div[class*="groupSection"]')
      if (!group) return
      const ids: string[] = []
      group.querySelectorAll<HTMLElement>('[data-row-key^="session:"]').forEach(el => {
        const k = el.dataset.rowKey
        if (k) ids.push(k.slice('session:'.length))
      })
      const count = ids.filter(id => selected.has(id)).length
      const next = ids.length > 0 && count === ids.length ? 'on'
        : count > 0 ? 'mixed' : 'off'
      box.dataset.state = next
      box.setAttribute('aria-checked', next === 'mixed' ? 'mixed' : next === 'on' ? 'true' : 'false')
    })
  }
  syncRef.current = syncBoxes

  // Repaint when selection changes; injection stays stable.
  useEffect(() => { syncRef.current() }, [state.selected])

  useEffect(() => {
    const getSessionRow = (row: HTMLElement): SessionRow | null => {
      const key = row.dataset.rowKey
      if (!key || !key.startsWith('session:')) return null
      const idStr = key.replace('session:', '')
      const existing = rowsRef.current.get(key)
      if (existing) return existing
      // Prefer a dedicated title element; fall back to first text-bearing child.
      const titleEl = row.querySelector('[class*="title"]')
        || row.querySelector('[data-slot="title"]')
        || row.firstElementChild
      const title = titleEl instanceof HTMLElement
        ? titleEl.textContent?.trim() || idStr : idStr
      const sessionId = idStr as SessionId
      const sessionRow: SessionRow = { sessionId, title, running: false }
      rowsRef.current.set(key, sessionRow)
      return sessionRow
    }

    const makeBox = (label: string): HTMLElement => {
      const box = document.createElement('span')
      box.className = 'dsh-srp-box'
      box.dataset.state = 'off'
      box.setAttribute('role', 'checkbox')
      box.setAttribute('aria-checked', 'false')
      box.setAttribute('aria-label', label)
      box.tabIndex = 0
      return box
    }

    const stop = (event: Event): void => { event.stopPropagation() }

    // Return session ids that belong to the given workspace row (in its groupSection).
    const sessionsOf = (wsRow: HTMLElement): SessionId[] => {
      const group = wsRow.closest('div[class*="groupSection"]')
      if (!group) return []
      const ids: SessionId[] = []
      group.querySelectorAll<HTMLElement>('[data-row-key^="session:"]').forEach(el => {
        const k = el.dataset.rowKey
        if (k) ids.push(k.slice('session:'.length) as SessionId)
      })
      return ids
    }

    const injectSession = (row: HTMLElement): void => {
      const key = row.dataset.rowKey
      if (!key || !key.startsWith('session:')) return
      if (row.querySelector(':scope > .dsh-srp-box')) return
      const sessionRow = getSessionRow(row)
      if (!sessionRow) return
      const id = key.slice('session:'.length) as SessionId
      const box = makeBox(sessionRow.title || 'session')
      box.addEventListener('pointerdown', stop)
      box.addEventListener('mousedown', stop)
      box.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        controller.toggle(id)
      })
      box.addEventListener('keydown', event => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        event.stopPropagation()
        controller.toggle(id)
      })
      row.insertBefore(box, row.firstChild)
      boxesRef.current.set(key, box)
      syncRef.current()
    }

    const injectWorkspace = (row: HTMLElement): void => {
      const key = row.dataset.rowKey
      if (!key || !key.startsWith('workspace:')) return
      if (row.querySelector(':scope > .dsh-srp-box')) return
      const ids = sessionsOf(row)
      if (ids.length === 0) return // no rendered sessions — skip
      const box = makeBox('Select every session in this workspace')
      box.addEventListener('pointerdown', stop)
      box.addEventListener('mousedown', stop)
      box.addEventListener('click', event => {
        event.preventDefault()
        event.stopPropagation()
        controller.toggleMany(ids)
      })
      box.addEventListener('keydown', event => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        event.stopPropagation()
        controller.toggleMany(ids)
      })
      row.insertBefore(box, row.firstChild)
      wsBoxesRef.current.set(key, box)
      syncRef.current()
    }

    // Initial scan.
    document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]').forEach(injectSession)
    document.querySelectorAll<HTMLElement>('[data-row-key^="workspace:"]').forEach(injectWorkspace)

    // Collect all session rows for the batch dialog's availableRows.
    const allRows: SessionRow[] = []
    document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]').forEach(row => {
      const sr = getSessionRow(row)
      if (sr) allRows.push(sr)
    })
    controller.setAvailableRows(allRows)
    syncRef.current()

    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.dataset.rowKey?.startsWith('session:')) injectSession(node)
          if (node.dataset.rowKey?.startsWith('workspace:')) injectWorkspace(node)
          node.querySelectorAll<HTMLElement>('[data-row-key^="session:"]').forEach(injectSession)
          node.querySelectorAll<HTMLElement>('[data-row-key^="workspace:"]').forEach(injectWorkspace)
        }
        for (const node of m.removedNodes) {
          if (!(node instanceof HTMLElement)) continue
          const key = node.dataset.rowKey
          if (key?.startsWith('session:')) { rowsRef.current.delete(key); boxesRef.current.delete(key) }
          if (key?.startsWith('workspace:')) wsBoxesRef.current.delete(key)
        }
      }
      // Rebuild availableRows so the batch dialog stays accurate.
      const updated: SessionRow[] = []
      document.querySelectorAll<HTMLElement>('[data-row-key^="session:"]').forEach(row => {
        const sr = getSessionRow(row)
        if (sr) updated.push(sr)
      })
      controller.setAvailableRows(updated)
      syncRef.current()
    })
    obs.observe(document.body, { childList: true, subtree: true })

    return () => {
      obs.disconnect()
      document.querySelectorAll('.dsh-srp-box').forEach(el => el.remove())
      rowsRef.current.clear()
      boxesRef.current.clear()
      wsBoxesRef.current.clear()
    }
  }, [controller])

  // One stylesheet: a painted box with a guaranteed-visible tick, immune to DSH resets.
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = [
      '.dsh-srp-box{flex:none;display:inline-flex;align-items:center;justify-content:center;',
      'width:15px;height:15px;margin:0 6px 0 0;padding:0;border-radius:4px;cursor:pointer;',
      'border:1.5px solid var(--dsw-alias-border-secondary,#8a8a8a);background:transparent;',
      'transition:background .12s ease,border-color .12s ease;color:transparent;font-size:12px}',
      '.dsh-srp-box:hover{border-color:var(--dsh-danger,#b42318)}',
      '.dsh-srp-box:focus-visible{outline:2px solid var(--dsh-accent,#4c8dff);outline-offset:2px}',
      '.dsh-srp-box[data-state="on"],.dsh-srp-box[data-state="mixed"]{',
      'background:var(--dsh-danger,#b42318);border-color:var(--dsh-danger,#b42318);color:#fff}',
      '.dsh-srp-box::after{content:"";width:8px;height:4px;border-left:2px solid #fff;',
      'border-bottom:2px solid #fff;transform:rotate(-45deg) translate(0,-1px);opacity:0}',
      '.dsh-srp-box[data-state="on"]::after{opacity:1}',
      '.dsh-srp-box[data-state="mixed"]::after{width:8px;height:2px;border:0;background:#fff;transform:none;opacity:1}',
    ].join('')
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
  const open = token !== null
  const title = target !== null ? t('title') : t('batchTitle', { count: batch?.items.length ?? 0 })
  const description = target !== null
    ? (target.title || target.sessionId)
    : undefined
  return (
    <Modal
      open={open}
      onClose={() => controller.close()}
      title={title}
      closeLabel={t('cancel')}
      footer={(
        <>
          <button type="button" disabled={state.busy} onClick={() => controller.close()} style={ghostButtonStyle}>{t('cancel')}</button>
          <button
            type="button"
            disabled={!acknowledged || state.busy}
            onClick={() => void controller.confirm()}
            style={{ ...dangerButtonStyle, cursor: !acknowledged || state.busy ? 'not-allowed' : 'pointer' }}
          >
            {state.busy
              ? t('working')
              : target !== null ? t('confirm') : t('confirmBatch', { count: batch?.items.length ?? 0 })}
          </button>
        </>
      )}
    >
      {target === null && batch !== null && (
        <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
          {(batch.items ?? []).slice(0, 6).map(item => (
            <li key={item.sessionId} style={{ overflowWrap: 'anywhere' }}>{item.title || item.sessionId}</li>
          ))}
          {(batch.items.length ?? 0) > 6 && (
            <li style={{ opacity: 0.7 }}>{t('batchMore', { count: (batch.items.length ?? 0) - 6 })}</li>
          )}
        </ul>
      )}
      <p>{t('body')}</p>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '16px 0' }}>
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={state.busy}
          onChange={event => { event.stopPropagation(); setAcknowledgedToken(event.target.checked ? token : null) }}
          onClick={event => event.stopPropagation()}
        />
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
    </Modal>
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
    inject: () => ({ controller }),
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
