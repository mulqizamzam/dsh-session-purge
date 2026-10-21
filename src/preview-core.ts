/**
 * Read-only impact preview for stored sessions.
 *
 * The purge pipeline can only destroy. This module describes what a delete
 * would remove, using the host's own stored-session metadata, and it never
 * calls a removal primitive.
 */

import { normalizeSessionId, SessionPurgeError } from './purge-core.ts'

/** The host's stored-session snapshot, read defensively. */
export interface StoredSessionSnapshot {
  readonly header?: { readonly id?: string; readonly createdAt?: number }
  readonly sizeBytes?: number
}

/**
 * What the host knows about a session's agent.
 *
 * `unknown` is not the same as `idle`: without the agent registry the purge
 * pipeline cannot even look for a live agent, and it answers
 * `runtime-capability-missing` for the whole deletion.
 */
export type LiveAgentState = 'idle' | 'live' | 'unknown'

export interface SessionPreviewRuntime {
  /** The host's stored-session snapshot, or undefined when no log exists. */
  statSession(sessionId: string): Promise<StoredSessionSnapshot | undefined>
  /** 'unknown' when the host exposes no agent registry at all. */
  liveAgentState(sessionId: string): LiveAgentState
  /** True when the purge pipeline could stop and drain this session's agent. */
  canStopAndDrain(sessionId: string): boolean
  /** True when a live session is still attached. */
  isAttached(sessionId: string): boolean
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
  readonly liveAgent: LiveAgentState
  readonly attached: boolean
  /** A successful delete would remove the stored log. */
  readonly deletable: boolean
  /**
   * '' when nothing blocks the deletion, otherwise the reason code:
   * `invalid-session-id`, `session-live`, `agent-registry-unavailable` or
   * `stat-failed`. A session with no stored log is not a blocker: deleting it
   * is a successful no-op, which `exists: false` already says.
   */
  readonly blockedReason: string
}

/** One preview answer: the per-session records and the bytes they hold. */
export interface PreviewReport {
  readonly results: readonly SessionImpact[]
  /** The known total size, or null when no size could be read. */
  readonly totalBytes: number | null
}

const MILLISECONDS_PER_DAY = 86_400_000

/**
 * Age in days, rounded to one decimal.
 *
 * The rounding is the number the operator is shown, so every rule that reads
 * an age (the impact panel, the retention policy) must read this same value —
 * a policy that silently used a different precision would select a session the
 * panel described as still inside the limit.
 * @param createdAt - the stored session's creation time, epoch milliseconds.
 * @param now - the reference time, epoch milliseconds.
 * @returns the age in days, never negative.
 */
export function ageInDays(createdAt: number, now: number): number {
  return Math.max(0, Math.round(((now - createdAt) / MILLISECONDS_PER_DAY) * 10) / 10)
}

/** A finite number, or null when the host reported nothing usable. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** What the host already reported about one stored session. */
export interface SessionFacts {
  /** A stored log exists for this id. */
  readonly exists: boolean
  /** The stored session's creation time, epoch milliseconds. */
  readonly createdAt: number | null
  /** The stored artifact's physical size in bytes. */
  readonly sizeBytes: number | null
}

/**
 * Describe one session from facts the host already reported.
 *
 * The live-agent rules are the same ones the purge pipeline obeys, so the
 * description can never promise something the delete would refuse: without an
 * agent registry the pipeline cannot even look for a live agent and answers
 * `runtime-capability-missing`, and a live agent is only removable when the
 * host owns a disposal bridge or the agent itself can be stopped.
 * @param id - the normalized session id.
 * @param facts - what the host reported about the stored session.
 * @param runtime - the host's live state.
 * @param now - the reference time, epoch milliseconds.
 */
export function describeSession(
  id: string,
  facts: SessionFacts,
  runtime: SessionPreviewRuntime,
  now: number,
): SessionImpact {
  const liveAgent = runtime.liveAgentState(id)
  const attached = runtime.isAttached(id)
  let blockedReason = ''
  if (liveAgent === 'unknown') {
    blockedReason = 'agent-registry-unavailable'
  } else if (liveAgent === 'live' && !runtime.canStopAndDrain(id)) {
    blockedReason = 'session-live'
  }
  return {
    id,
    exists: facts.exists,
    createdAt: facts.createdAt,
    ageDays: facts.createdAt === null ? null : ageInDays(facts.createdAt, now),
    sizeBytes: facts.sizeBytes,
    liveAgent,
    attached,
    deletable: facts.exists && blockedReason === '',
    blockedReason,
  }
}

function impact(id: string, extra: Partial<SessionImpact>): SessionImpact {
  return {
    id,
    exists: false,
    createdAt: null,
    ageDays: null,
    sizeBytes: null,
    liveAgent: 'idle',
    attached: false,
    deletable: false,
    blockedReason: '',
    ...extra,
  }
}

/**
 * Describe one session without touching it.
 *
 * A malformed id and an unreadable log are reported as reasons, not as
 * failures: the preview is a report, and one unusable id in a batch must not
 * hide the others. A missing host capability is different — that is the host's
 * answer about itself, so it fails the whole request instead.
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
    return impact(rawId, { blockedReason: 'invalid-session-id' })
  }
  let snapshot: StoredSessionSnapshot | undefined
  try {
    snapshot = await runtime.statSession(id)
  } catch (error) {
    if (error instanceof SessionPurgeError) throw error
    return impact(id, { blockedReason: 'stat-failed' })
  }
  if (snapshot === undefined) {
    // No stored log: nothing to remove, and the delete is a successful no-op.
    return impact(id, {})
  }
  return describeSession(id, {
    exists: true,
    createdAt: finiteOrNull(snapshot.header?.createdAt),
    sizeBytes: finiteOrNull(snapshot.sizeBytes),
  }, runtime, now)
}

/**
 * Collect the impact of several sessions.
 *
 * One unreadable log is reported as that session's reason; the others are
 * still described. A missing host capability still fails the whole request.
 */
export async function previewSessions(
  runtime: SessionPreviewRuntime,
  rawIds: readonly string[],
  now: number = Date.now(),
): Promise<PreviewReport> {
  const results: SessionImpact[] = []
  for (const rawId of rawIds) {
    results.push(await previewSession(runtime, rawId, now))
  }
  const known = results.filter(item => item.sizeBytes !== null)
  return {
    results,
    // null, not 0, when no size is known: "0 bytes" would claim the sessions
    // hold nothing.
    totalBytes: known.length === 0 ? null : known.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
  }
}
