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

/** Accepts a bare UUID or the display/storage form `session-<uuid>`. */
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
  return bare.toLowerCase()
}

function messageOf(error: unknown): string {
  if (error instanceof SessionPurgeError) return `${error.code}: ${error.message}`
  // Avoid passing raw storage-provider errors (which may include host paths) to the client.
  if (error instanceof Error) return 'unexpected-error: operation failed; inspect host logs for details.'
  return 'unexpected-error: operation failed; inspect host logs for details.'
}

/**
 * Ordering invariant:
 * stop/drain -> flush -> detach -> delete -> verify absence -> purge cache -> release workspace ledger.
 * Once the log is deleted, cache and ledger cleanup are both attempted even if one fails.
 */
export async function purgeSession(
  runtime: SessionPurgeRuntime,
  rawId: string,
  signal?: AbortSignal,
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
      result.error = `cache-cleanup-failed: ${messageOf(error)}`
    }

    stage = 'release-ledger'
    try {
      await runtime.releaseWorkspaceMembership(id)
      result.ledger = true
    } catch (error) {
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
    result.id = id
    result.stage = stage
    result.error = messageOf(error)
    return result
  }
}
