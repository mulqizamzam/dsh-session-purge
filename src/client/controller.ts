import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BatchPurgeResult, PurgeResult } from '../purge-core.ts'

const DELETE_PATH = '/api/session-purge/delete'

/** One listable session as the selection manager shows it. */
export interface SessionRow {
  readonly sessionId: SessionId
  readonly title: string
  /** Host running state; drives the manager's running badge. */
  readonly running: boolean
}

export interface DeleteTarget {
  readonly sessionId: SessionId
  readonly title: string
  /** Changes on every dialog open, even when the same session is selected again. */
  readonly token: number
}

export interface BatchDialog {
  /**
   * The sessions still pending in this dialog. A confirm that partially failed
   * replaces this with only the failed remainder, so a retry never re-sends ids
   * whose deletion already succeeded.
   */
  readonly items: readonly SessionRow[]
  readonly token: number
}

export interface ItemFailure {
  readonly sessionId: SessionId
  readonly title: string
  readonly error: string
}

export interface PurgeUiState {
  readonly target: DeleteTarget | null
  readonly batch: BatchDialog | null
  readonly managerOpen: boolean
  /** Snapshot of the listable sessions, taken when the manager opens. */
  readonly rows: readonly SessionRow[]
  /** Chosen ids; intersected with `rows` (and minus the current session) at confirm time. */
  readonly selected: readonly SessionId[]
  /** The session the operator is viewing; excluded from batch selection by rule. */
  readonly currentSessionId: SessionId | null
  readonly busy: boolean
  readonly error: string | null
  readonly itemFailures: readonly ItemFailure[]
}

type Listener = () => void

export class SessionPurgeController {
  private state: PurgeUiState = {
    target: null,
    batch: null,
    managerOpen: false,
    rows: [],
    selected: [],
    currentSessionId: null,
    busy: false,
    error: null,
    itemFailures: [],
  }
  private readonly listeners = new Set<Listener>()
  private nextToken = 1

  constructor(private readonly refreshList: () => void | Promise<void>) {}

  readonly getSnapshot = (): PurgeUiState => this.state

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  open(sessionId: SessionId, title: string): void {
    // A purge in flight owns the dialog state. Opening another target would
    // silently clear `busy`, and the in-flight completion would then close the
    // NEW dialog while that session's own purge is still running — two deletes
    // racing through one state slot. The request is ignored instead.
    if (this.state.busy) return
    this.setState({
      ...this.state,
      target: { sessionId, title, token: this.nextToken++ },
      batch: null,
      busy: false,
      error: null,
      itemFailures: [],
    })
  }

  close(): void {
    if (this.state.busy) return
    this.setState({ ...this.state, target: null, batch: null, busy: false, error: null, itemFailures: [] })
  }

  openManager(rows: readonly SessionRow[]): void {
    // A purge in flight owns the dialog state. The modal blocks the pointer, but
    // the keyboard can still reach the sidebar foot behind it, so the manager
    // must refuse to stack over an open confirmation — whether that dialog is
    // busy deleting or merely waiting for consent.
    if (this.state.busy) return
    if (this.state.target !== null || this.state.batch !== null) return
    // Selection survives a re-open (a refresh while picking must not lose
    // picks); the manager intersects it with the fresh rows before confirming.
    this.setState({ ...this.state, managerOpen: true, rows, error: null, itemFailures: [] })
  }

  closeManager(): void {
    if (this.state.managerOpen) this.setState({ ...this.state, managerOpen: false })
  }

  setCurrentSession(sessionId: SessionId | null): void {
    if (this.state.currentSessionId === sessionId) return
    this.setState({ ...this.state, currentSessionId: sessionId })
  }

  toggle(sessionId: SessionId): void {
    const selected = this.state.selected.includes(sessionId)
      ? this.state.selected.filter(id => id !== sessionId)
      : [...this.state.selected, sessionId]
    this.setState({ ...this.state, selected })
  }

  /** Select every selectable row in the current snapshot. */
  selectAll(): void {
    this.setState({ ...this.state, selected: this.selectableRows().map(row => row.sessionId) })
  }

  clearSelection(): void {
    if (this.state.selected.length === 0) return
    this.setState({ ...this.state, selected: [] })
  }

  /** Rows the manager offers: the snapshot minus the current session. */
  readonly selectableRows = (): readonly SessionRow[] =>
    this.state.rows.filter(row => row.sessionId !== this.state.currentSessionId)

  /** Chosen rows, in snapshot order, already minus the current session. */
  readonly selectedRows = (): readonly SessionRow[] =>
    this.selectableRows().filter(row => this.state.selected.includes(row.sessionId))

  openBatchFromManager(): void {
    if (this.state.busy) return
    const chosen = this.selectedRows()
    if (chosen.length === 0) return
    this.setState({
      ...this.state,
      managerOpen: false,
      target: null,
      batch: { items: chosen, token: this.nextToken++ },
      busy: false,
      error: null,
      itemFailures: [],
    })
  }

  async confirm(): Promise<void> {
    if (this.state.busy) return
    if (this.state.target) await this.confirmSingle(this.state.target)
    else if (this.state.batch) await this.confirmBatch(this.state.batch)
  }

  private async confirmSingle(target: DeleteTarget): Promise<void> {
    const { token } = target
    this.setState({ ...this.state, busy: true, error: null, itemFailures: [] })
    try {
      const response = await fetch(DELETE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sessionId: target.sessionId, confirm: true }),
      })
      const raw = await response.text()
      let result: Partial<PurgeResult> & { error?: string }
      try {
        result = JSON.parse(raw) as Partial<PurgeResult> & { error?: string }
      } catch {
        throw new Error(`The host returned an unreadable response (HTTP ${response.status}).`)
      }
      if (!response.ok || result.ok !== true) {
        throw new Error(typeof result.error === 'string'
          ? result.error
          : `Session deletion failed (HTTP ${response.status}).`)
      }
      // The delete endpoint is authoritative. A failed optional in-place refresh
      // must not misreport a completed deletion as a failed delete.
      try { await this.refreshList() } catch { /* host events may still update the list */ }
      // Only this dialog's own completion may settle its state.
      this.settle(token, () => ({
        ...this.state,
        target: null,
        busy: false,
        error: null,
        itemFailures: [],
      }))
    } catch (error) {
      this.settle(token, () => ({
        ...this.state,
        busy: false,
        error: error instanceof Error ? error.message : 'Session deletion failed.',
      }))
    }
  }

  private async confirmBatch(dialog: BatchDialog): Promise<void> {
    const { token } = dialog
    this.setState({ ...this.state, busy: true, error: null, itemFailures: [] })
    try {
      const response = await fetch(DELETE_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          sessionIds: dialog.items.map(item => item.sessionId),
          confirm: true,
        }),
      })
      const raw = await response.text()
      let payload: Partial<BatchPurgeResult> & { error?: string }
      try {
        payload = JSON.parse(raw) as Partial<BatchPurgeResult> & { error?: string }
      } catch {
        throw new Error(`The host returned an unreadable response (HTTP ${response.status}).`)
      }
      if (this.state.batch?.token !== token) {
        // A newer dialog replaced this one; its own flow governs the state.
        this.setState({ ...this.state, busy: false })
        return
      }
      const results = Array.isArray(payload.results) ? payload.results : []
      const { failures, pending } = classifyBatch(dialog, results, response.status)
      if (response.ok && payload.ok === true && failures.length === 0) {
        // The delete endpoint is authoritative; the optional refresh may fail
        // (host events still update the list) without misreporting the outcome.
        try { await this.refreshList() } catch { /* host events may still update the list */ }
        const deleted = new Set<SessionId>(dialog.items.map(item => item.sessionId))
        this.setState({
          ...this.state,
          batch: null,
          managerOpen: false,
          busy: false,
          error: null,
          itemFailures: [],
          selected: this.state.selected.filter(id => !deleted.has(id)),
        })
        return
      }
      const summary = failures.length === dialog.items.length
        ? `No session was deleted (${failures.length} of ${dialog.items.length} failed).`
        : `${dialog.items.length - failures.length} of ${dialog.items.length} deleted; ${failures.length} failed.`
      this.setState({
        ...this.state,
        busy: false,
        // Retry re-sends only the failed remainder, never an id whose deletion
        // already succeeded.
        batch: pending.length > 0 ? { items: pending, token } : null,
        error: summary,
        itemFailures: failures,
      })
    } catch (error) {
      this.settleBatch(token, () => ({
        ...this.state,
        busy: false,
        error: error instanceof Error ? error.message : 'Session deletion failed.',
      }))
    }
  }

  /** Apply a completion only while `token` still names the open single dialog. */
  private settle(token: number, next: () => PurgeUiState): void {
    if (this.state.target?.token !== token) {
      this.setState({ ...this.state, busy: false })
      return
    }
    this.setState(next())
  }

  /** Same guard for the batch dialog. */
  private settleBatch(token: number, next: () => PurgeUiState): void {
    if (this.state.batch?.token !== token) {
      this.setState({ ...this.state, busy: false })
      return
    }
    this.setState(next())
  }

  private setState(next: PurgeUiState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}

/**
 * Zip the dialog's items against the host's per-item results.
 *
 * Every item without a matching `ok: true` result is a failure — including a
 * tail of items the response never mentioned, so a truncated or malformed
 * results array cannot silently drop sessions from the retry set. The pending
 * remainder is what a retry re-sends.
 */
function classifyBatch(
  dialog: BatchDialog,
  results: readonly Partial<PurgeResult>[],
  status: number,
): { failures: ItemFailure[]; pending: SessionRow[] } {
  const failures: ItemFailure[] = []
  const pending: SessionRow[] = []
  dialog.items.forEach((item, index) => {
    const result = results[index]
    if (result && result.ok === true) return
    const error = typeof result?.error === 'string' && result.error.length > 0
      ? result.error
      : `Session deletion failed (HTTP ${String(status)}).`
    failures.push({ sessionId: item.sessionId, title: item.title, error })
    pending.push(item)
  })
  return { failures, pending }
}
