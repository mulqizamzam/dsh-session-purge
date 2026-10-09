import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PurgeResult } from '../purge-core.ts'

export interface DeleteTarget {
  readonly sessionId: SessionId
  readonly title: string
  /** Changes on every dialog open, even when the same session is selected again. */
  readonly token: number
}

export interface PurgeUiState {
  readonly target: DeleteTarget | null
  readonly busy: boolean
  readonly error: string | null
}

type Listener = () => void

export class SessionPurgeController {
  private state: PurgeUiState = { target: null, busy: false, error: null }
  private readonly listeners = new Set<Listener>()
  private nextToken = 1

  constructor(private readonly refreshList: () => void | Promise<void>) {}

  readonly getSnapshot = (): PurgeUiState => this.state

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  open(sessionId: SessionId, title: string): void {
    this.setState({ target: { sessionId, title, token: this.nextToken++ }, busy: false, error: null })
  }

  close(): void {
    if (this.state.busy) return
    this.setState({ target: null, busy: false, error: null })
  }

  async confirm(): Promise<void> {
    const target = this.state.target
    if (!target || this.state.busy) return

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
        throw new Error(typeof result.error === 'string'
          ? result.error
          : `Session deletion failed (HTTP ${response.status}).`)
      }
      // The delete endpoint is authoritative. A failed optional in-place refresh
      // must not misreport a completed deletion as a failed delete.
      try { await this.refreshList() } catch { /* host events may still update the list */ }
      this.setState({ target: null, busy: false, error: null })
    } catch (error) {
      this.setState({
        ...this.state,
        busy: false,
        error: error instanceof Error ? error.message : 'Session deletion failed.',
      })
    }
  }

  private setState(next: PurgeUiState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }
}
