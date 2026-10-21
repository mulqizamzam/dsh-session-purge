import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { BatchPurgeResult, PurgeResult } from '../purge-core.ts'
import type { PreviewReport } from '../preview-core.ts'

const DELETE_PATH = '/api/session-purge/delete'
const PREVIEW_PATH = '/api/session-purge/preview'
const POLICY_PREVIEW_PATH = '/api/session-purge/policy/preview'
const POLICY_APPLY_PATH = '/api/session-purge/policy/apply'

const BYTES_PER_MEGABYTE = 1024 * 1024

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

/** The retention limits as the operator typed them; an empty field is unset. */
export interface PolicyLimits {
  readonly maxAgeDays: string
  readonly maxCount: string
  readonly maxTotalBytes: string
}

/** What the host said a policy would remove. */
export interface PolicyPreviewSummary {
  readonly selectedCount: number
  /** How many sessions the policy flags in total, before the run cap. */
  readonly totalSelected: number
  readonly totalSessions: number
  readonly bytesToFree: number | null
  readonly selectedIds: readonly string[]
  readonly blocked: readonly { readonly id: string; readonly reason: string }[]
  readonly truncated: boolean
}

/** What one policy run did. */
export interface PolicyApplySummary {
  readonly succeeded: number
  readonly failed: number
  readonly blocked: number
  readonly bytesFreed: number | null
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
  /** What the pending deletion would remove; null until the host answers. */
  readonly impact: PreviewReport | null
  /** The retention overlay is open. */
  readonly policyOpen: boolean
  /** A policy request is in flight. */
  readonly policyBusy: boolean
  readonly policyError: string | null
  readonly policyLimits: PolicyLimits
  /** What the last policy preview selected; null until the operator previews. */
  readonly policyPreview: PolicyPreviewSummary | null
  /** What the last policy run did; null until the operator applies. */
  readonly policyResult: PolicyApplySummary | null
  /** The operator acknowledged that a policy run removes sessions permanently. */
  readonly policyAcknowledged: boolean
}

type Listener = () => void

/** The host's answer to a policy preview. */
interface PolicyPreviewPayload {
  ok?: boolean
  error?: string
  totalSessions?: number
  selectedCount?: number
  totalSelected?: number
  bytesToFree?: number | null
  truncated?: boolean
  selected?: { id?: string; blockedReason?: string }[]
}

/** The host's answer to a policy run. */
interface PolicyApplyPayload {
  ok?: boolean
  error?: string
  succeeded?: number
  failed?: number
  blocked?: number
  bytesFreed?: number | null
  results?: unknown[]
}

/**
 * One typed limit.
 *
 * An empty field is an unset limit; anything that is not a number is refused
 * here, where the operator can still see what they typed.
 * @param raw - the field's text.
 * @param name - how the field is called in the operator's language.
 */
function parseLimit(raw: string, name: string): number | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return undefined
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a number.`)
  }
  return value
}

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
    impact: null,
    policyOpen: false,
    policyBusy: false,
    policyError: null,
    policyLimits: { maxAgeDays: '', maxCount: '', maxTotalBytes: '' },
    policyPreview: null,
    policyResult: null,
    policyAcknowledged: false,
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
    // A policy run counts as a purge in flight: both mutate the same host
    // state, and the cleanup contract says one batch at a time.
    if (this.state.busy || this.state.policyBusy) return
    const token = this.nextToken++
    this.setState({
      ...this.state,
      target: { sessionId, title, token },
      batch: null,
      busy: false,
      error: null,
      itemFailures: [],
      impact: null,
    })
    void this.loadImpact([sessionId], token)
  }

  close(): void {
    if (this.state.busy) return
    this.setState({ ...this.state, target: null, batch: null, busy: false, error: null, itemFailures: [], impact: null })
  }

  openManager(rows: readonly SessionRow[]): void {
    // A purge in flight owns the dialog state. The modal blocks the pointer, but
    // the keyboard can still reach the sidebar foot behind it, so the manager
    // must refuse to stack over an open confirmation — whether that dialog is
    // busy deleting or merely waiting for consent.
    if (this.state.busy || this.state.policyBusy) return
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
    const token = this.nextToken++
    this.setState({
      ...this.state,
      managerOpen: false,
      target: null,
      batch: { items: chosen, token },
      busy: false,
      error: null,
      itemFailures: [],
      impact: null,
    })
    void this.loadImpact(chosen.map(item => item.sessionId), token)
  }

  /**
   * Open the retention overlay.
   *
   * A purge in flight owns the dialog state, so the policy overlay waits: two
   * destructive flows running at once would race over the same sessions.
   */
  openPolicy(): void {
    if (this.state.busy || this.state.policyBusy) return
    this.setState({
      ...this.state,
      policyOpen: true,
      policyError: null,
      policyPreview: null,
      policyResult: null,
      policyAcknowledged: false,
    })
  }

  closePolicy(): void {
    if (this.state.policyBusy) return
    this.setState({ ...this.state, policyOpen: false, policyError: null })
  }

  /**
   * Change one limit.
   *
   * The preview goes with it: a preview that answered different limits would
   * let the operator apply a selection they never saw.
   */
  setPolicyLimit(key: keyof PolicyLimits, value: string): void {
    if (this.state.policyBusy) return
    this.setState({
      ...this.state,
      policyLimits: { ...this.state.policyLimits, [key]: value },
      policyPreview: null,
      policyResult: null,
      policyAcknowledged: false,
      policyError: null,
    })
  }

  /** Record the operator's consent for the destructive half of the policy. */
  setPolicyAcknowledged(acknowledged: boolean): void {
    if (this.state.policyBusy) return
    this.setState({ ...this.state, policyAcknowledged: acknowledged })
  }

  /**
   * Ask the host what the policy would remove.
   *
   * Nothing is removed here: the answer only names sessions and bytes, and the
   * apply button stays gated on the operator's consent.
   */
  async previewPolicy(): Promise<void> {
    if (this.state.policyBusy) return
    let policy: Record<string, number>
    try {
      policy = this.policyLimitsToRequest()
    } catch (error) {
      this.setState({
        ...this.state,
        policyError: error instanceof Error ? error.message : 'The policy limits are not usable.',
      })
      return
    }
    this.setState({ ...this.state, policyBusy: true, policyError: null, policyResult: null })
    try {
      const response = await fetch(POLICY_PREVIEW_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          policy,
          // The session the operator is looking at is never a candidate.
          excludeSessionIds: this.state.currentSessionId === null ? [] : [this.state.currentSessionId],
        }),
      })
      const raw = await response.text()
      let payload: PolicyPreviewPayload
      try {
        payload = JSON.parse(raw) as PolicyPreviewPayload
      } catch {
        throw new Error(`The host returned an unreadable response (HTTP ${response.status}).`)
      }
      if (!response.ok || payload.ok !== true) {
        throw new Error(typeof payload.error === 'string'
          ? payload.error
          : `The policy preview failed (HTTP ${response.status}).`)
      }
      const selected = Array.isArray(payload.selected) ? payload.selected : []
      this.setState({
        ...this.state,
        policyBusy: false,
        policyPreview: {
          selectedCount: typeof payload.selectedCount === 'number' ? payload.selectedCount : selected.length,
          totalSelected: typeof payload.totalSelected === 'number' ? payload.totalSelected : selected.length,
          totalSessions: typeof payload.totalSessions === 'number' ? payload.totalSessions : 0,
          bytesToFree: typeof payload.bytesToFree === 'number' ? payload.bytesToFree : null,
          selectedIds: selected.map(item => item.id).filter((id): id is string => typeof id === 'string'),
          blocked: selected
            .filter(item => typeof item.blockedReason === 'string' && item.blockedReason.length > 0)
            .map(item => ({ id: item.id ?? '', reason: item.blockedReason ?? '' })),
          truncated: payload.truncated === true,
        },
      })
    } catch (error) {
      this.setState({
        ...this.state,
        policyBusy: false,
        policyPreview: null,
        policyError: error instanceof Error ? error.message : 'The policy preview failed.',
      })
    }
  }

  /**
   * Run the policy over exactly the sessions the preview named.
   *
   * The ids are sent, not the policy, so the run removes what the operator was
   * shown. The host re-reads its own state before removing anything, so a
   * session that became live in between is reported instead of deleted.
   */
  async applyPolicy(): Promise<void> {
    if (this.state.policyBusy) return
    const preview = this.state.policyPreview
    if (preview === null || preview.selectedIds.length === 0) return
    this.setState({ ...this.state, policyBusy: true, policyError: null })
    try {
      const response = await fetch(POLICY_APPLY_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sessionIds: preview.selectedIds, confirm: true }),
      })
      const raw = await response.text()
      let payload: PolicyApplyPayload
      try {
        payload = JSON.parse(raw) as PolicyApplyPayload
      } catch {
        throw new Error(`The host returned an unreadable response (HTTP ${response.status}).`)
      }
      // A run that skipped or failed some sessions still answers with its
      // report, so the operator is told what happened instead of a flat error.
      if (!Array.isArray(payload.results)) {
        throw new Error(typeof payload.error === 'string'
          ? payload.error
          : `The policy run failed (HTTP ${response.status}).`)
      }
      try { await this.refreshList() } catch { /* host events may still update the list */ }
      this.setState({
        ...this.state,
        policyBusy: false,
        policyPreview: null,
        policyAcknowledged: false,
        policyResult: {
          succeeded: typeof payload.succeeded === 'number' ? payload.succeeded : 0,
          failed: typeof payload.failed === 'number' ? payload.failed : 0,
          blocked: typeof payload.blocked === 'number' ? payload.blocked : 0,
          bytesFreed: typeof payload.bytesFreed === 'number' ? payload.bytesFreed : null,
        },
      })
    } catch (error) {
      this.setState({
        ...this.state,
        policyBusy: false,
        policyError: error instanceof Error ? error.message : 'The policy run failed.',
      })
    }
  }

  /**
   * The limits as the host expects them.
   *
   * The size limit is typed in megabytes and sent in bytes, and a policy with
   * no limit at all is refused here rather than sent: the host would answer
   * 400, but the operator is better served by a sentence in their own language.
   */
  private policyLimitsToRequest(): Record<string, number> {
    const policy: Record<string, number> = {}
    const age = parseLimit(this.state.policyLimits.maxAgeDays, 'The age limit')
    if (age !== undefined) policy.maxAgeDays = age
    const count = parseLimit(this.state.policyLimits.maxCount, 'The session count limit')
    if (count !== undefined) policy.maxCount = count
    const megabytes = parseLimit(this.state.policyLimits.maxTotalBytes, 'The size limit')
    if (megabytes !== undefined) policy.maxTotalBytes = Math.round(megabytes * BYTES_PER_MEGABYTE)
    if (Object.keys(policy).length === 0) {
      throw new Error('Set at least one limit before previewing the policy.')
    }
    return policy
  }

  /**
   * Ask the host what the pending deletion would remove.
   *
   * The preview is advisory: it only adds numbers to the dialog, so a failed
   * read leaves the delete path exactly as it was. An answer that arrives after
   * its dialog closed is dropped instead of reviving a closed dialog.
   */
  private async loadImpact(ids: readonly SessionId[], token: number): Promise<void> {    try {
      const response = await fetch(PREVIEW_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ sessionIds: ids }),
      })
      const raw = await response.text()
      const payload = JSON.parse(raw) as { ok?: boolean; results?: PreviewReport['results']; totalBytes?: number | null }
      if (!response.ok || payload.ok !== true || !Array.isArray(payload.results)) return
      if (this.state.target?.token !== token && this.state.batch?.token !== token) return
      this.setState({
        ...this.state,
        impact: {
          results: payload.results,
          totalBytes: typeof payload.totalBytes === 'number' ? payload.totalBytes : null,
        },
      })
    } catch {
      /* an unreadable impact must never block the deletion */
    }
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
        impact: null,
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
          impact: null,
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
        // The panel must describe the pending remainder, not the batch that was
        // just deleted: the succeeded ids are already gone, and their bytes
        // with them.
        impact: null,
      })
      if (pending.length > 0) void this.loadImpact(pending.map(item => item.sessionId), token)
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
