import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, LocaleDictOf, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionPurgeController, type SessionRow } from './controller.ts'
import type { PreviewReport } from '../preview-core.ts'

const NS = 'session-purge'
type LocaleKey =
  | 'delete' | 'title' | 'body' | 'consent' | 'confirm' | 'cancel' | 'working' | 'menuLabel' | 'failedPrefix'
  | 'selectMode' | 'managerTitle' | 'managerEmpty' | 'managerHint' | 'selectAll' | 'clearSelection'
  | 'deleteSelected' | 'confirmBatch' | 'batchTitle' | 'batchMore'
  | 'running' | 'currentSession' | 'currentSessionNote' | 'retryHint'
  | 'impactTitle' | 'impactAge' | 'impactOldest' | 'impactTotal' | 'impactBlocked' | 'impactNothing'
  | 'impactReasonLive' | 'impactReasonInvalid' | 'impactReasonRegistry' | 'impactReasonStat'

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
  managerTitle: 'Select sessions to delete',
  managerEmpty: 'No deletable sessions are available.',
  managerHint: 'Tick the sessions to delete, then confirm. Rows without a persisted log (blank New Session rows) and the session you are viewing are excluded.',
  selectAll: 'Select all',
  clearSelection: 'Clear',
  deleteSelected: 'Delete {count} selected',
  confirmBatch: 'Delete {count} permanently',
  batchTitle: 'Delete {count} sessions permanently?',
  batchMore: '…and {count} more.',
  running: 'running',
  currentSession: 'current session',
  currentSessionNote: 'The session you are viewing cannot be included in a batch delete; delete it from its own Delete button instead.',
  retryHint: 'Retry sends only the sessions that failed.',
  impactTitle: 'What will be removed',
  impactAge: '{count} days old',
  impactOldest: 'oldest {count} days old',
  impactTotal: '{count} sessions · {size} in total',
  impactBlocked: 'Cannot be removed now: {reason}',
  impactNothing: 'No stored log — deleting it removes nothing.',
  impactReasonLive: 'a live agent still holds it',
  impactReasonInvalid: 'not a valid session id',
  impactReasonRegistry: 'the host exposes no agent registry',
  impactReasonStat: 'the host could not read its metadata',
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
  managerTitle: '选择要删除的会话',
  managerEmpty: '没有可删除的会话。',
  managerHint: '勾选要删除的会话，然后确认。没有持久日志的行（空白的新建会话行）和您当前所在的会话不可选。',
  selectAll: '全选',
  clearSelection: '清除',
  deleteSelected: '删除所选 {count} 个',
  confirmBatch: '永久删除 {count} 个',
  batchTitle: '永久删除 {count} 个会话？',
  batchMore: '……以及另外 {count} 个。',
  running: '运行中',
  currentSession: '当前会话',
  currentSessionNote: '当前所在的会话不能包含在批量删除中；请使用其自身的删除按钮。',
  retryHint: '重试只会重新提交失败的会话。',
  impactTitle: '将被删除的内容',
  impactAge: '已创建 {count} 天',
  impactOldest: '最旧 {count} 天',
  impactTotal: '{count} 个会话 · 共 {size}',
  impactBlocked: '当前无法删除：{reason}',
  impactNothing: '没有持久日志 —— 删除它不会移除任何内容。',
  impactReasonLive: '仍有活动的 agent 占用它',
  impactReasonInvalid: '不是有效的会话 id',
  impactReasonRegistry: '宿主没有暴露 agent 注册表',
  impactReasonStat: '宿主无法读取其元数据',
}

/**
 * Structural view of the host session-list snapshot (the real type is the
 * session controller's `SessionListState`, which this plugin deliberately does
 * not depend on). The hook arrives as a framework prop, so the shape is read
 * defensively at runtime rather than trusted.
 */
interface SessionsSnapshot {
  readonly ids?: readonly string[]
  readonly byId?: Readonly<Record<string, {
    readonly id?: string
    readonly title?: string
    readonly displayTitle?: string
    readonly running?: boolean
    readonly blank?: boolean
  }>>
}

interface HeaderFace {
  openConfirm: (sessionId: SessionId, title: string) => void
  /** Track the session the operator is viewing so the batch selection can exclude it. */
  setCurrentSession: (sessionId: SessionId | null) => void
}
interface SidebarFace {
  openConfirm: (sessionId: SessionId, title: string) => void
}
interface FooterFace {
  controller: SessionPurgeController
}
type HeaderProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<typeof NS> & InjectFace<HeaderFace>
type SidebarProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> & PropsLocale<typeof NS> & InjectFace<SidebarFace>
type FooterProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<typeof NS> & InjectFace<FooterFace>
type OverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS> & InjectFace<{ controller: SessionPurgeController }>

const dangerButtonStyle: React.CSSProperties = {
  background: 'var(--dsh-danger, #b42318)',
  color: '#fff',
  border: 0,
  borderRadius: 8,
  padding: '8px 14px',
  cursor: 'pointer',
}
const ghostButtonStyle: React.CSSProperties = {
  border: '1px solid var(--dsh-border, #7776)',
  borderRadius: 8,
  padding: '6px 10px',
  cursor: 'pointer',
}

function HeaderAction({ sessionId, openConfirm, setCurrentSession, t }: HeaderProps) {
  // The conversation header is mounted exactly while one session is open and
  // unmounted when none is, which makes it the honest source for the
  // "current session" marker the batch selection excludes. The cleanup runs on
  // unmount so no stale id survives into a blank state.
  useEffect(() => {
    setCurrentSession(sessionId)
    return () => { setCurrentSession(null) }
  }, [sessionId, setCurrentSession])
  return (
    <button
      type="button"
      aria-label={t('delete')}
      title={t('delete')}
      onClick={() => openConfirm(sessionId, '')}
      style={ghostButtonStyle}
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

function FooterSelectButton({ wide, useSessions, controller, t }: FooterProps) {
  // The host's selector hook requires a selector argument at runtime: the
  // no-argument overload exists in the published type but throws in this host's
  // implementation (measured live — the shipped CordisPanel footer occupant
  // always passes one, and a no-arg call made this entry fail to render). The
  // identity selector projects the whole snapshot.
  const sessions = useSessions((state: unknown) => state) as SessionsSnapshot | undefined
  // Snapshot at click time: the manager then works from one stable list instead
  // of a moving one, and any id that disappears before confirm is reported as
  // a per-item failure rather than silently skipped.
  const rows = useMemo<readonly SessionRow[]>(() => {
    const byId = sessions?.byId ?? {}
    return (sessions?.ids ?? []).flatMap(id => {
      const row = byId[id]
      if (!row || row.blank === true) return []
      const sessionId = typeof row.id === 'string' && row.id.length > 0 ? row.id : id
      return [{
        sessionId: sessionId as SessionId,
        title: row.displayTitle || row.title || sessionId,
        running: row.running === true,
      }]
    })
  }, [sessions])
  const label = t('selectMode')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => { controller.openManager(rows) }}
      style={ghostButtonStyle}
    >
      {wide ? `☑ ${label}` : '☑'}
    </button>
  )
}

/**
 * The multi-select surface. It lives in `shell.overlay` rather than inside the
 * host's session rows for two measured reasons: the row's leading cell renders
 * only for idle sessions (a status dot displaces it, hiding the checkbox from
 * exactly the live sessions an operator most wants to remove), and the row's
 * action strip is `display: none` until hover (selections would be invisible
 * until the pointer found the row). An overlay owns its own rendering instead
 * of fighting those two seats.
 */
function SelectionManager({ controller, t }: OverlayProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => {
    if (!state.managerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !state.busy) controller.closeManager()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [state.managerOpen, state.busy, controller])
  if (!state.managerOpen) return null
  const selectable = controller.selectableRows()
  const selected = controller.selectedRows()
  const allSelected = selectable.length > 0 && selected.length === selectable.length
  return (
    <div
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget && !state.busy) controller.closeManager() }}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: '#0008', display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-purge-manager-title"
        style={{ width: 'min(560px, 100%)', maxHeight: 'min(80vh, 720px)', display: 'flex', flexDirection: 'column', padding: 24, borderRadius: 14, background: 'var(--dsh-panel, Canvas)', color: 'var(--dsh-text, CanvasText)', boxShadow: '0 18px 60px #0005' }}
      >
        <h2 id="session-purge-manager-title" style={{ marginTop: 0 }}>{t('managerTitle')}</h2>
        <p style={{ opacity: 0.8, marginTop: 0 }}>{t('managerHint')}</p>
        {selectable.length === 0 && state.rows.length === 0
          ? <p>{t('managerEmpty')}</p>
          : (
            <ul style={{ listStyle: 'none', margin: '8px 0', padding: 0, overflowY: 'auto', flex: 1 }}>
              {state.rows.map(row => {
                const isCurrent = row.sessionId === state.currentSessionId
                const checked = state.selected.includes(row.sessionId)
                return (
                  <li key={row.sessionId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 2px' }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isCurrent || state.busy}
                      onChange={() => { controller.toggle(row.sessionId) }}
                      aria-label={row.title}
                    />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.sessionId}>
                      {row.title}
                    </span>
                    {row.running && <span style={{ fontSize: 11, opacity: 0.7 }}>{t('running')}</span>}
                    {isCurrent && <span style={{ fontSize: 11, opacity: 0.7 }}>{t('currentSession')}</span>}
                  </li>
                )
              })}
            </ul>
          )}
        <p style={{ fontSize: 12, opacity: 0.7 }}>{t('currentSessionNote')}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <button type="button" disabled={state.busy || allSelected} onClick={() => { controller.selectAll() }} style={ghostButtonStyle}>
            {t('selectAll')}
          </button>
          <button type="button" disabled={state.busy || selected.length === 0} onClick={() => { controller.clearSelection() }} style={ghostButtonStyle}>
            {t('clearSelection')}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" disabled={state.busy} onClick={() => { controller.closeManager() }} style={ghostButtonStyle}>
            {t('cancel')}
          </button>
          <button
            type="button"
            disabled={selected.length === 0 || state.busy}
            onClick={() => { controller.openBatchFromManager() }}
            style={{ ...dangerButtonStyle, cursor: selected.length === 0 || state.busy ? 'not-allowed' : 'pointer' }}
          >
            {t('deleteSelected', { count: selected.length })}
          </button>
        </div>
      </section>
    </div>
  )
}

/** Stored size in a form an operator can read at a glance. */
function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The host's reason codes, rendered in the operator's language, never as codes. */
const REASON_KEYS: Record<string, LocaleKey> = {
  'session-live': 'impactReasonLive',
  'invalid-session-id': 'impactReasonInvalid',
  'agent-registry-unavailable': 'impactReasonRegistry',
  'stat-failed': 'impactReasonStat',
}

/**
 * What the pending deletion would remove: the stored size, how old it is, and
 * any session the host would refuse to delete right now. Purely informative —
 * the destructive button never depends on it.
 */
function ImpactPanel({ impact, t }: { impact: PreviewReport; t: OverlayProps['t'] }) {
  const results = impact.results
  if (results.length === 0) return null
  const ages = results.map(item => item.ageDays).filter((age): age is number => age !== null)
  const oldest = ages.length > 0 ? Math.max(...ages) : null
  const blocked = results.filter(item => item.blockedReason !== '')
  const empty = results.filter(item => item.blockedReason === '' && !item.exists)
  const headline = results.length === 1
    ? formatBytes(results[0].sizeBytes)
    : t('impactTotal', {
      count: results.length,
      size: impact.totalBytes === null ? '—' : formatBytes(impact.totalBytes),
    })
  return (
    <div style={{ margin: '0 0 14px', padding: '10px 12px', borderRadius: 10, background: 'var(--dsh-surface, rgba(0,0,0,0.05))' }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{t('impactTitle')}</div>
      <div style={{ fontSize: 13, marginTop: 2 }}>
        {headline}
        {oldest !== null && ` · ${results.length === 1
          ? t('impactAge', { count: oldest })
          : t('impactOldest', { count: oldest })}`}
      </div>
      {empty.map((item, index) => (
        <div key={`empty-${String(index)}`} style={{ fontSize: 12, opacity: 0.7 }}>{t('impactNothing')}</div>
      ))}
      {blocked.map((item, index) => {
        const reasonKey = REASON_KEYS[item.blockedReason]
        const reason = reasonKey === undefined ? item.blockedReason : t(reasonKey)
        return (
          <div key={`blocked-${String(index)}`} style={{ fontSize: 12, color: 'var(--dsh-danger, #c33)' }}>
            {t('impactBlocked', { reason })}
          </div>
        )
      })}
    </div>
  )
}

function ConfirmOverlay({ controller, t }: OverlayProps) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [acknowledgedToken, setAcknowledgedToken] = useState<number | null>(null)
  const target = state.target
  const batch = state.batch
  // One consent acknowledgement per dialog open, single or batch: the token
  // changes on every open, so a stale checkbox cannot confirm a new target.
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
        {state.impact !== null && <ImpactPanel impact={state.impact} t={t} />}
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
            {state.itemFailures.length > 8 && <li>{t('batchMore', { count: state.itemFailures.length - 8 })}</li>}
          </ul>
        )}
        {batch !== null && state.itemFailures.length > 0 && <p style={{ fontSize: 12, opacity: 0.7 }}>{t('retryHint')}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button type="button" disabled={state.busy} onClick={() => { controller.close() }}>{t('cancel')}</button>
          <button
            type="button"
            disabled={!acknowledged || state.busy}
            onClick={() => { void controller.confirm() }}
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

export const name = 'session-purge-client'
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  // `ctx.sessions.refresh()` re-pulls the real baseline through session/list
  // (ISessions.refresh -> ClientSessions.refresh -> SessionManager.refreshList,
  // single-flight per Host generation). The previous `sessions.list.refreshInPlace`
  // does not exist anywhere in this host, so the optional-chained call was a
  // silent no-op: after a successful delete the row stayed put until the user
  // happened to trigger a refresh. A host that still lacks the method now says so
  // instead of failing quietly.
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
    inject: (): HeaderFace => ({
      openConfirm: (sessionId, title) => controller.open(sessionId, title),
      setCurrentSession: sessionId => controller.setCurrentSession(sessionId),
    }),
  }, HeaderAction))

  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'session-purge-sidebar',
    order: 500,
    locale: NS,
    inject: (): SidebarFace => ({ openConfirm: (sessionId, title) => controller.open(sessionId, title) }),
  }, SidebarMenuItem))

  // Global entry point for the multi-select flow: one button in the sidebar
  // foot, beside Settings, that opens the selection manager. The slot is
  // declared by the client's sidebar entry (`sidebar.footer.action`), so the
  // plugin's ui-sidebar type view is a devDependency here and the entry is
  // additive beside the shipped ones.
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'session-purge-select',
    order: 100,
    locale: NS,
    inject: (): FooterFace => ({ controller }),
  }, FooterSelectButton))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-purge-dialog',
    locale: NS,
    inject: () => ({ controller }),
  }, ConfirmOverlay))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-purge-manager',
    order: 1000,
    locale: NS,
    inject: () => ({ controller }),
  }, SelectionManager))
}
