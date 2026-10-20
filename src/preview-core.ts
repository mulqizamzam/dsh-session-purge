/**
 * Read-only impact preview for stored sessions.
 *
 * The purge pipeline can only destroy. This module describes what a delete
 * would remove, using the host's own stored-session metadata, and it never
 * calls a removal primitive.
 */

import { normalizeSessionId } from './purge-core.ts'

/** The host's stored-session snapshot, read defensively. */
export interface StoredSessionSnapshot {
  readonly header?: { readonly createdAt?: number }
  readonly sizeBytes?: number
}

export interface SessionPreviewRuntime {
  /** The host's stored-session snapshot, or undefined when no log exists. */
  statSession(sessionId: string): Promise<StoredSessionSnapshot | undefined>
  /** True when a live agent still holds this session. */
  hasLiveAgent(sessionId: string): boolean
  /** True when a live session is still attached. */
  isAttached(sessionId: string): boolean
  /** True when the host can dispose a live session before its log is deleted. */
  canDisposeLiveSession(): boolean
}

/** What one session's deletion would remove, and whether it can be removed now. */
export interface SessionImpact {
  readonly id: string
  /** A stored log exists for this id. */
  readonly exists: boolean
  /** The stored session's creation time, epoch milliseconds. */
  readonly createdAt: number | null
  /** Age in days, rounded to one decimal. */
  readonly ageDays: number | null
  /** The stored artifact's physical size in bytes. */
  readonly sizeBytes: number | null
  /** A live agent still holds this session. */
  readonly liveAgent: boolean
  /** A live session is still attached. */
  readonly attached: boolean
  /** A successful delete would remove the stored log. */
  readonly deletable: boolean
  /** '' when deletable, otherwise the reason code. */
  readonly blockedReason: string
}

const MILLISECONDS_PER_DAY = 86_400_000

/**
 * Describe one session without touching it.
 *
 * A malformed id and a missing log are reported as reasons, not as failures:
 * the preview is a report, and one unusable id in a batch must not hide the
 * others.
 */
export async function previewSession(
  runtime: SessionPreviewRuntime,
  rawId: string,
  now: number = Date.now(),
): Promise<SessionImpact> {
  let id: string
  try {
    id = normalizeSessionId(rawId)
  } catch {
    return {
      id: rawId,
      exists: false,
      createdAt: null,
      ageDays: null,
      sizeBytes: null,
      liveAgent: false,
      attached: false,
      deletable: false,
      blockedReason: 'invalid-session-id',
    }
  }
  const snapshot = await runtime.statSession(id)
  if (snapshot === undefined) {
    return {
      id,
      exists: false,
      createdAt: null,
      ageDays: null,
      sizeBytes: null,
      liveAgent: false,
      attached: false,
      deletable: false,
      blockedReason: 'log-not-found',
    }
  }
  const createdAt = typeof snapshot.header?.createdAt === 'number' ? snapshot.header.createdAt : null
  const sizeBytes = typeof snapshot.sizeBytes === 'number' ? snapshot.sizeBytes : null
  const liveAgent = runtime.hasLiveAgent(id)
  const attached = runtime.isAttached(id)
  // A live agent blocks the purge unless the host can dispose it first — the
  // same rule the delete pipeline applies at its stop-agent stage.
  const blockedReason = liveAgent && !runtime.canDisposeLiveSession() ? 'session-live' : ''
  return {
    id,
    exists: true,
    createdAt,
    ageDays: createdAt === null
      ? null
      : Math.max(0, Math.round(((now - createdAt) / MILLISECONDS_PER_DAY) * 10) / 10),
    sizeBytes,
    liveAgent,
    attached,
    deletable: blockedReason === '',
    blockedReason,
  }
}
