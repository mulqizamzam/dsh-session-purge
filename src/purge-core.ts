/**
 * Runtime-agnostic, fail-closed session deletion orchestration.
 * The adapter must use the host's canonical APIs; this module never guesses disk paths.
 */

export type PurgeStage =
  | 'validate'
  | 'stop-agent'
  | 'flush-session'
  | 'detach-session'
  | 'delete-log'
  | 'verify-log'
  | 'purge-cache'
  | 'release-ledger'
  | 'complete'

export interface PurgeResult {
  ok: boolean
  id: string
  log: boolean
  cache: boolean
  ledger: boolean
  stage: PurgeStage
  error: string
}

export interface SessionPurgeRuntime {
  /** Must stop AND drain/unregister a live agent, or reject. */
  stopAndDrainAgent(sessionId: string, signal?: AbortSignal): Promise<void>
  /** Flush all pending writes for this id; no-op if there is no live session. */
  flushSession(sessionId: string, signal?: AbortSignal): Promise<void>
  /** Detach a live session so disposal cannot re-create the deleted log. */
  detachSession(sessionId: string): Promise<void>
  /** Delete via the persistence provider's serialized deletion primitive. */
  deleteLog(sessionId: string, signal?: AbortSignal): Promise<void>
  /** Return true only when the canonical persistence layer confirms absence. */
  logIsAbsent(sessionId: string): Promise<boolean>
  /** Remove all derived projection/cache rows for this canonical id. */
  purgeProjectionCache(sessionId: string): Promise<boolean>
  /** Release workspace membership only after log absence is established. */
  releaseWorkspaceMembership(sessionId: string): Promise<void>
}

export class SessionPurgeError extends Error {
  readonly code: string
  readonly stage: PurgeStage

  constructor(code: string, stage: PurgeStage, message: string) {
    super(message)
    this.name = 'SessionPurgeError'
    this.code = code
    this.stage = stage
  }
}

/**
 * Validate a session id and return it in the form the host stores it.
 *
 * The persistence layer keys each artifact by the `SessionId` verbatim
 * (`sessionDir(root, cwd, id)` = `projectDir/encodeSegment(id)`), and the host
 * mints both forms in the wild: `<uuid>` and `session-<uuid>`. The session list
 * therefore reports the stored form, and that is the id this plugin receives.
 * Stripping the prefix rewrote `session-<uuid>` to `<uuid>`, so every lookup
 * resolved to a non-existent artifact — which the backend reports as "already
 * absent", turning the whole purge into a silent no-op answered with
 * `ok: true`. The form is preserved; only the characters are normalized.
 * @param raw - the id exactly as the host reported it.
 * @returns the trimmed, lowercased id with its prefix intact.
 */
export function normalizeSessionId(raw: string): string {
  const trimmed = raw.trim()
  const bare = trimmed.startsWith('session-') ? trimmed.slice('session-'.length) : trimmed
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuid.test(bare)) {
    throw new SessionPurgeError(
      'invalid-session-id',
      'validate',
      'sessionId must be a UUID, optionally prefixed with "session-".',
    )
  }
  return trimmed.toLowerCase()
}

export interface BatchPurgeResult {
  /** True only when every requested session reports a complete purge. */
  ok: boolean
  /** Number of ids this batch processed, duplicates included. */
  total: number
  succeeded: number
  failed: number
  /** Per-session outcomes in request order; the caller maps these back to its own rows. */
  results: PurgeResult[]
}

/**
 * Purge several sessions in one request, strictly one at a time and in the
 * order given.
 *
 * Sequencing is deliberate: the per-session purge mutates shared host state
 * (the session controller's live registry, the persistence writer, the
 * workspace ledger), so parallel items would race on the very primitives each
 * purge verifies. A failing item is isolated — its error is recorded and the
 * loop continues, because a batch that stops at the first failure would leave
 * the operator unable to tell which of N sessions were actually removed.
 *
 * The host persistence contract makes re-deleting an already-absent id a
 * successful no-op (`SessionPersistenceJsonl.delete` treats absence as
 * success and drops stale references), so processing duplicates as given is
 * safe; the caller is still expected to send a deduplicated set.
 *
 * `onLogDeleted` fires once per id whose log is confirmed gone, before the
 * next item starts, so the host layer can report each removal and drop the
 * session-list read cache as soon as the fact exists instead of after the
 * whole batch settles.
 */
export async function purgeSessions(
  runtime: SessionPurgeRuntime,
  rawIds: readonly string[],
  signal?: AbortSignal,
  onUnexpectedError?: (error: unknown, stage: PurgeStage) => void,
  onLogDeleted?: (id: string) => void | Promise<void>,
): Promise<BatchPurgeResult> {
  const results: PurgeResult[] = []
  let succeeded = 0
  for (const rawId of rawIds) {
    const result = await purgeSession(runtime, rawId, signal, onUnexpectedError)
    results.push(result)
    if (result.ok) succeeded += 1
    if (result.log) await onLogDeleted?.(result.id)
  }
  return {
    ok: results.length > 0 && succeeded === results.length,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  }
}

function messageOf(error: unknown): string {
  if (error instanceof SessionPurgeError) return `${error.code}: ${error.message}`
  // Avoid passing raw storage-provider errors (which may include host paths) to the client.
  if (error instanceof Error) return 'unexpected-error: operation failed; inspect host logs for details.'
  return 'unexpected-error: operation failed; inspect host logs for details.'
}

/**
 * True when the failure is a cancellation, not a defect. The abort primitive
 * throws a DOMException (which is NOT an `instanceof Error` in every runtime
 * this plugin can run under), so the check is duck-typed on `name` and must
 * stay runtime-agnostic. Classified separately because an aborted purge is
 * neither a host defect worth a log line nor an opaque provider failure.
 */
function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}

/**
 * Ordering invariant:
 * stop/drain -> flush -> detach -> delete -> verify absence -> purge cache -> release workspace ledger.
 * Once the log is deleted, cache and ledger cleanup are both attempted even if one fails.
 *
 * `onUnexpectedError` receives every raw exception that the public `error` string
 * sanitizes away, so the host layer can write the real cause to its log; this
 * module itself stays runtime-agnostic and never reads host services directly.
 */
export async function purgeSession(
  runtime: SessionPurgeRuntime,
  rawId: string,
  signal?: AbortSignal,
  onUnexpectedError?: (error: unknown, stage: PurgeStage) => void,
): Promise<PurgeResult> {
  let id = ''
  let stage: PurgeStage = 'validate'
  const result: PurgeResult = {
    ok: false,
    id: '',
    log: false,
    cache: false,
    ledger: false,
    stage,
    error: '',
  }

  try {
    id = normalizeSessionId(rawId)
    result.id = id
    signal?.throwIfAborted()

    stage = 'stop-agent'
    await runtime.stopAndDrainAgent(id, signal)

    stage = 'flush-session'
    await runtime.flushSession(id, signal)

    stage = 'detach-session'
    await runtime.detachSession(id)

    stage = 'delete-log'
    signal?.throwIfAborted()
    await runtime.deleteLog(id, signal)

    stage = 'verify-log'
    result.log = await runtime.logIsAbsent(id)
    if (!result.log) {
      result.stage = stage
      result.error = 'log-not-absent: persistence did not confirm that the session log was removed; cache and ledger were left untouched.'
      return result
    }

    // Do not let one derived-cleanup failure prevent the other cleanup.
    stage = 'purge-cache'
    try {
      result.cache = await runtime.purgeProjectionCache(id)
    } catch (error) {
      if (!(error instanceof SessionPurgeError)) onUnexpectedError?.(error, stage)
      result.error = `cache-cleanup-failed: ${messageOf(error)}`
    }

    stage = 'release-ledger'
    try {
      await runtime.releaseWorkspaceMembership(id)
      result.ledger = true
    } catch (error) {
      if (!(error instanceof SessionPurgeError)) onUnexpectedError?.(error, stage)
      const ledgerError = `ledger-cleanup-failed: ${messageOf(error)}`
      result.error = result.error ? `${result.error}; ${ledgerError}` : ledgerError
    }

    result.ok = result.log && result.cache && result.ledger
    result.stage = result.ok ? 'complete' : stage
    if (!result.ok && !result.error) {
      result.error = 'cleanup-incomplete: the log is gone, but one or more derived cleanup steps did not confirm success.'
    }
    return result
  } catch (error) {
    // A cancellation is an expected outcome (the browser navigated away, the
    // request was aborted), not a host defect: it answers with its own code and
    // writes no unexpected-error log line, which would otherwise fire for every
    // remaining item of an aborted batch.
    const aborted = isAbort(error)
    if (!(error instanceof SessionPurgeError) && !aborted) onUnexpectedError?.(error, stage)
    result.id = id
    result.stage = stage
    result.error = aborted
      ? 'aborted: the deletion was cancelled before it completed; the session may still exist.'
      : messageOf(error)
    return result
  }
}
