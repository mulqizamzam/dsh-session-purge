import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PurgeResult } from '../purge-core.ts'

export interface DeleteTarget {
  readonly sessionId: SessionId
  readonly title: string
  readonly token: number
}

export interface BatchDialog {
  readonly items: readonly SessionRow[]
  readonly token: number
}

export interface SessionRow {
  readonly sessionId: SessionId
  readonly title: string
  readonly running: boolean
}

export interface ItemFailure {
  readonly sessionId: SessionId
  readonly title: string
  readonly error: string
}

export interface PurgeUiState {
  readonly target: DeleteTarget | null
  readonly batch: BatchDialog | null
  readonly selected: readonly SessionId[]
  readonly availableRows: readonly SessionRow[]
  readonly busy: boolean
  readonly error: string | null
  readonly itemFailures: readonly ItemFailure[]
  readonly toast: string | null
}

type Listener = () => void

export class SessionPurgeController {
  private state: PurgeUiState = {
    target: null,
    batch: null,
    selected: [],
    availableRows: [],
    busy: false,
    error: null,
    itemFailures: [],
    toast: null,
  }
  private readonly listeners = new Set<Listener>()
  private nextToken = 1
  private toastTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly refreshList: () => void | Promise<void>) {}

  readonly getSnapshot = (): PurgeUiState => this.state

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.setToast(null)
    }
  }

  /** Called by RowCheckboxInjector when rows are injected into DOM. */
  setAvailableRows(rows: readonly SessionRow[]): void {
    const live = new Set(rows.map(row => String(row.sessionId)))
    const selected = this.state.selected.filter(id => live.has(String(id)))
    this.setState({ ...this.state, availableRows: rows, selected })
  }

  toggle(sessionId: SessionId): void {
    const selected = this.state.selected.some(id => String(id) === String(sessionId))
      ? this.state.selected.filter(id => String(id) !== String(sessionId))
      : [...this.state.selected, sessionId]
    this.setState({ ...this.state, selected })
  }

  /** Toggle all given session ids to the opposite of their current state (workspace checkbox). */
  toggleMany(sessionIds: readonly SessionId[]): void {
    if (sessionIds.length === 0) return
    const current = new Set(this.state.selected.map(id => String(id)))
    const allOn = sessionIds.every(id => current.has(String(id)))
    const next = new Set<string>(current)
    for (const id of sessionIds) {
      if (allOn) next.delete(String(id))
      else next.add(String(id))
    }
    this.setState({ ...this.state, selected: [...next] as SessionId[] })
  }

  selectAll(rows: readonly SessionRow[]): void {
    const ids = rows.map(row => row.sessionId)
    const selected = new Set(this.state.selected.map(id => String(id)))
    const allSelected = ids.length > 0 && ids.every(id => selected.has(String(id)))
    this.setState({
      ...this.state,
      selected: allSelected ? [] : ids,
    })
  }

  clearSelection(): void {
    if (this.state.selected.length === 0) return
    this.setState({ ...this.state, selected: [] })
  }

  /** Open batch dialog with currently selected sessions from available rows. */
  openBatchFromSelection(): void {
    if (this.state.busy) return
    this.setToast(null)
    if (this.state.selected.length === 0) return
    const selected = new Set(this.state.selected.map(id => String(id)))
    const chosen = this.state.availableRows.filter(row => selected.has(String(row.sessionId)))
    if (chosen.length === 0) {
      this.setState({
        ...this.state,
        selected: [],
        error: 'selection-stale: selected sessions are no longer visible.',
      })
      return
    }
    const token = this.nextToken++
    this.setState({
      ...this.state,
      batch: { items: chosen, token },
      target: null,
      busy: false,
      error: null,
      itemFailures: [],
    })
  }

  closeBatch(): void {
    if (this.state.busy) return
    this.setToast(null)
    this.setState({ ...this.state, batch: null, error: null, itemFailures: [] })
  }

  open(sessionId: SessionId, title: string): void {
    if (this.state.busy) return
    this.setToast(null)
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
    this.setToast(null)
    this.setState({ ...this.state, target: null, batch: null, busy: false, error: null, itemFailures: [] })
  }

  async confirm(): Promise<void> {
    const target = this.state.target
    const batch = this.state.batch
    if ((!target && !batch) || this.state.busy) return

    if (target) {
      await this.confirmSingle(target)
    } else if (batch) {
      await this.confirmBatch(batch)
    }
  }

  private async confirmSingle(target: DeleteTarget): Promise<void> {
    this.setState({ ...this.state, busy: true, error: null })
    try {
      const response = await fetch('/api/session-purge/delete', {
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
        throw new Error(typeof result.error === 'string' ? result.error : `Session deletion failed (HTTP ${response.status}).`)
      }
      try { await this.refreshList() } catch { /* host events may still update the list */ }
      const sessionId = target.sessionId
      const selected = this.state.selected.filter(id => String(id) !== String(sessionId))
      this.setState({
        ...this.state,
        target: null,
        batch: null,
        busy: false,
        error: null,
        itemFailures: [],
        selected,
      })
      this.setToast('1 session deleted')
    } catch (error) {
      this.setState({
        ...this.state,
        busy: false,
        error: error instanceof Error ? error.message : 'Session deletion failed.',
      })
    }
  }

  private async confirmBatch(dialog: BatchDialog): Promise<void> {
    const { items } = dialog
    this.setState({ ...this.state, busy: true, error: null, itemFailures: [] })
    try {
      const response = await fetch('/api/session-purge/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sessionIds: items.map(i => i.sessionId), confirm: true }),
      })
      const raw = await response.text()
      let payload: { ok?: boolean; results?: Partial<PurgeResult>[]; error?: string }
      try {
        payload = JSON.parse(raw) as { ok?: boolean; results?: Partial<PurgeResult>[]; error?: string }
      } catch {
        throw new Error(`The host returned an unreadable response (HTTP ${response.status}).`)
      }
      const results = Array.isArray(payload.results) ? payload.results : []
      const failures: ItemFailure[] = []
      const succeeded: SessionId[] = []
      items.forEach((item, index) => {
        const result = results[index]
        if (result && result.ok === true) {
          succeeded.push(item.sessionId)
        } else {
          const error = typeof result?.error === 'string' && result.error.length > 0
            ? result.error
            : `Session deletion failed (HTTP ${String(response.status)}).`
          failures.push({ sessionId: item.sessionId, title: item.title, error })
        }
      })
      try { await this.refreshList() } catch { /* host events may still update the list */ }
      const succeededIds = new Set(succeeded.map(id => String(id)))
      const remaining = this.state.selected.filter(id => !succeededIds.has(String(id)))
      this.setState({
        ...this.state,
        batch: null,
        target: null,
        busy: false,
        error: failures.length === items.length
          ? `${items.length} sessions failed to delete.`
          : failures.length > 0
            ? `${succeeded.length} deleted, ${failures.length} failed.`
            : null,
        itemFailures: failures,
        selected: remaining,
      })
      this.setToast(failures.length === 0 ? `${succeeded.length} sessions deleted` : null)
    } catch (error) {
      this.setToast(null)
      this.setState({
        ...this.state,
        busy: false,
        batch: null,
        target: null,
        error: error instanceof Error ? error.message : 'Session deletion failed.',
      })
    }
  }

  private setToast(message: string | null): void {
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    this.setState({ ...this.state, toast: message })
    if (message !== null) {
      this.toastTimer = setTimeout(() => this.setToast(null), 4000)
    }
  }

  dispose(): void {
    this.setToast(null)
    this.listeners.clear()
  }

  private setState(next: PurgeUiState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
