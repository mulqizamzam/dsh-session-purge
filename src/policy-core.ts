/**
 * Retention policy: which stored sessions a policy selects.
 *
 * The purge pipeline destroys whatever it is handed, one id at a time. This
 * module decides *which* stored sessions fall outside the operator's limits,
 * using the host's own stored-session metadata, and it never calls a removal
 * primitive. The selection is deterministic: the host's `list()` promises no
 * order, so every decision here is made against an explicit ordering.
 */

import { normalizeSessionId, SessionPurgeError } from './purge-core.ts'
import {
  ageInDays,
  describeSession,
  previewSession,
  type SessionImpact,
  type SessionPreviewRuntime,
  type StoredSessionSnapshot,
} from './preview-core.ts'

/**
 * The operator's limits. At least one of them must be set — a policy with no
 * limit would select nothing and a policy with an unlimited limit would
 * select everything, and neither is a limit.
 */
export interface RetentionPolicy {
  /** Sessions older than this many days are removed. */
  readonly maxAgeDays?: number
  /** At most this many sessions are kept; the older ones are removed. */
  readonly maxCount?: number
  /** At most this many bytes are kept; the older ones are removed. */
  readonly maxTotalBytes?: number
}

/**
 * The most sessions one policy run may remove.
 *
 * A run is a batch of sequential purges, and the response has to name every
 * session it touches. A policy over a large store can flag more than that; the
 * preview then reports the full count and lists only the first ones, so the
 * operator can run it again for the remainder instead of being handed a
 * response nobody can read.
 */
export const MAX_POLICY_SESSIONS = 500

/** One stored session, reduced to what a policy decision needs. */
export interface PolicyCandidate {
  readonly id: string
  /** The stored session's creation time, epoch milliseconds. */
  readonly createdAt: number | null
  /** The stored artifact's physical size in bytes. */
  readonly sizeBytes: number | null
}

/** What a policy decided. */
export interface PolicySelection {
  /** The sessions the policy removes, oldest first. */
  readonly selected: readonly PolicyCandidate[]
  /** The sessions the policy keeps. */
  readonly kept: readonly PolicyCandidate[]
  /** The known bytes the selection frees, or null when no size is known. */
  readonly bytesToFree: number | null
  /** The known bytes the kept sessions hold, or null when no size is known. */
  readonly bytesKept: number | null
}

/** The policy's answer, as the operator sees it. */
export interface PolicyPreviewReport {
  readonly policy: RetentionPolicy
  /** Every stored session the host reported. */
  readonly totalSessions: number
  /** How many sessions this run removes (at most {@link MAX_POLICY_SESSIONS}). */
  readonly selectedCount: number
  /** How many sessions the policy flags in total, before the run cap. */
  readonly totalSelected: number
  /** How many sessions are kept. */
  readonly keptCount: number
  /** The known bytes this run frees, or null when no size is known. */
  readonly bytesToFree: number | null
  /** The known bytes the kept sessions hold, or null when no size is known. */
  readonly bytesKept: number | null
  /** The impact of each session this run removes. */
  readonly selected: readonly SessionImpact[]
  /** The ids the caller asked to leave alone. */
  readonly excludedIds: readonly string[]
  /** The policy flags more sessions than one run removes. */
  readonly truncated: boolean
}

/** The host services the policy needs on top of the preview's. */
export interface SessionPolicyRuntime extends SessionPreviewRuntime {
  /** Every stored session the host knows about, in no promised order. */
  listSessions(signal?: AbortSignal): Promise<readonly StoredSessionSnapshot[]>
}

function requireLimit(value: unknown, name: string, minimum: number, integer: boolean): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || (integer && !Number.isInteger(value))
  ) {
    throw new SessionPurgeError(
      'invalid-policy',
      'validate',
      `${name} must be a finite number of at least ${String(minimum)}.`,
    )
  }
  return value
}

/**
 * Read the operator's limits out of an untrusted body.
 *
 * The limits are the whole point of the request, so an unusable one is a
 * caller bug rather than something to guess at: an empty policy would select
 * nothing and appear to succeed, and a negative limit would select everything.
 * @param raw - the untrusted policy object.
 * @returns the normalized policy.
 */
export function validatePolicy(raw: unknown): RetentionPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SessionPurgeError(
      'invalid-policy',
      'validate',
      'The policy must be an object with at least one of maxAgeDays, maxCount or maxTotalBytes.',
    )
  }
  const source = raw as Record<string, unknown>
  const policy: { maxAgeDays?: number; maxCount?: number; maxTotalBytes?: number } = {}
  let limits = 0
  if (source.maxAgeDays !== undefined && source.maxAgeDays !== null) {
    policy.maxAgeDays = requireLimit(source.maxAgeDays, 'maxAgeDays', 1, false)
    limits += 1
  }
  if (source.maxCount !== undefined && source.maxCount !== null) {
    policy.maxCount = requireLimit(source.maxCount, 'maxCount', 1, true)
    limits += 1
  }
  if (source.maxTotalBytes !== undefined && source.maxTotalBytes !== null) {
    policy.maxTotalBytes = requireLimit(source.maxTotalBytes, 'maxTotalBytes', 0, false)
    limits += 1
  }
  if (limits === 0) {
    throw new SessionPurgeError(
      'invalid-policy',
      'validate',
      'The policy needs at least one limit: maxAgeDays, maxCount or maxTotalBytes.',
    )
  }
  return policy
}

/**
 * Reduce the host's stored-session snapshots to policy candidates.
 *
 * A snapshot whose id is not a session id at all cannot be addressed by the
 * purge pipeline, so it is left out of the selection entirely rather than
 * being carried as an unselectable row.
 */
export function candidatesFrom(snapshots: readonly StoredSessionSnapshot[]): PolicyCandidate[] {
  const candidates: PolicyCandidate[] = []
  for (const snapshot of snapshots) {
    const rawId = snapshot.header?.id
    if (typeof rawId !== 'string' || rawId.trim().length === 0) continue
    let id: string
    try {
      id = normalizeSessionId(rawId)
    } catch {
      continue
    }
    const createdAt = typeof snapshot.header?.createdAt === 'number' && Number.isFinite(snapshot.header.createdAt)
      ? snapshot.header.createdAt
      : null
    const sizeBytes = typeof snapshot.sizeBytes === 'number' && Number.isFinite(snapshot.sizeBytes)
      ? snapshot.sizeBytes
      : null
    candidates.push({ id, createdAt, sizeBytes })
  }
  return candidates
}

/**
 * Newest first; a session with no known creation time sorts last; ties break
 * on the id so two runs over the same store always decide the same way.
 */
function compareCandidates(a: PolicyCandidate, b: PolicyCandidate): number {
  const left = a.createdAt ?? Number.NEGATIVE_INFINITY
  const right = b.createdAt ?? Number.NEGATIVE_INFINITY
  if (left !== right) return right - left
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function sumKnown(candidates: readonly PolicyCandidate[]): number | null {
  const known = candidates.filter(candidate => candidate.sizeBytes !== null)
  if (known.length === 0) return null
  return known.reduce((sum, candidate) => sum + (candidate.sizeBytes ?? 0), 0)
}

/**
 * Decide which stored sessions a policy removes.
 *
 * The three limits are independent budgets and a session is removed when it
 * breaks any one of them, so the selection is their union: a session can be
 * too old, or beyond the count cap, or beyond the byte cap, and breaking one
 * budget is enough. Each budget is evaluated over *all* candidates, including
 * the ones the caller excluded, because an excluded session still occupies a
 * count slot and still holds bytes — excluding it may only keep it, never
 * move the cut.
 *
 * The byte budget is positional: the newest sessions are kept while their
 * known sizes fit under the cap, and everything past that point is removed. A
 * session whose size the host did not report is kept — its size cannot be
 * proven to break the budget, and this tool only removes what it can show is
 * over the limit.
 * @param candidates - every stored session.
 * @param policy - the operator's limits.
 * @param now - the reference time, epoch milliseconds.
 * @param excluded - ids that must never be removed.
 */
export function selectByPolicy(
  candidates: readonly PolicyCandidate[],
  policy: RetentionPolicy,
  now: number = Date.now(),
  excluded: ReadonlySet<string> = new Set<string>(),
): PolicySelection {
  const ordered = [...candidates].sort(compareCandidates)
  const flagged = new Set<string>()

  if (policy.maxAgeDays !== undefined) {
    for (const candidate of ordered) {
      if (candidate.createdAt === null) continue
      // The same rounded age the operator is shown: a session that reads as
      // 30.0 days old is inside a 30-day limit.
      if (ageInDays(candidate.createdAt, now) > policy.maxAgeDays) flagged.add(candidate.id)
    }
  }

  if (policy.maxCount !== undefined) {
    const cap = policy.maxCount
    ordered.forEach((candidate, index) => {
      if (index >= cap) flagged.add(candidate.id)
    })
  }

  if (policy.maxTotalBytes !== undefined) {
    let used = 0
    let overBudget = false
    for (const candidate of ordered) {
      if (overBudget) {
        flagged.add(candidate.id)
        continue
      }
      if (candidate.sizeBytes === null) continue
      if (used + candidate.sizeBytes > policy.maxTotalBytes) {
        overBudget = true
        flagged.add(candidate.id)
        continue
      }
      used += candidate.sizeBytes
    }
  }

  const selected = ordered.filter(candidate => flagged.has(candidate.id) && !excluded.has(candidate.id)).reverse()
  const kept = ordered.filter(candidate => !flagged.has(candidate.id) || excluded.has(candidate.id))
  return {
    selected,
    kept,
    bytesToFree: sumKnown(selected),
    bytesKept: sumKnown(kept),
  }
}

/** Normalize the ids the caller asked to leave alone; an unusable one cannot match anything. */
function excludedSet(rawIds: readonly string[]): Set<string> {
  const excluded = new Set<string>()
  for (const raw of rawIds) {
    try {
      excluded.add(normalizeSessionId(raw))
    } catch {
      /* an id that cannot name a stored session protects nothing */
    }
  }
  return excluded
}

/**
 * Answer what a policy would remove, without removing anything.
 * @param runtime - the host's stored-session metadata and live state.
 * @param policy - the operator's limits.
 * @param now - the reference time, epoch milliseconds.
 * @param excludeIds - ids that must never be removed.
 */
export async function previewPolicy(
  runtime: SessionPolicyRuntime,
  policy: RetentionPolicy,
  now: number = Date.now(),
  excludeIds: readonly string[] = [],
): Promise<PolicyPreviewReport> {
  const excluded = excludedSet(excludeIds)
  const snapshots = await runtime.listSessions()
  const candidates = candidatesFrom(snapshots)
  const selection = selectByPolicy(candidates, policy, now, excluded)
  const listed = selection.selected.slice(0, MAX_POLICY_SESSIONS)
  const selected = listed.map(candidate => describeSession(candidate.id, {
    exists: true,
    createdAt: candidate.createdAt,
    sizeBytes: candidate.sizeBytes,
  }, runtime, now))
  return {
    policy,
    totalSessions: candidates.length,
    selectedCount: listed.length,
    totalSelected: selection.selected.length,
    keptCount: candidates.length - selection.selected.length,
    bytesToFree: sumKnown(listed),
    bytesKept: selection.bytesKept,
    selected,
    excludedIds: [...excluded],
    truncated: selection.selected.length > listed.length,
  }
}

/** What an apply run would attempt, and what it would have to skip. */
export interface PolicyApplyPlan {
  /** The impact of every requested session, in request order. */
  readonly impacts: readonly SessionImpact[]
  /** The sessions the host would let the purge pipeline remove. */
  readonly deletableIds: readonly string[]
  /** The sessions something stands in the way of. */
  readonly blocked: readonly SessionImpact[]
}

/**
 * Work out, at apply time, which of the requested sessions can be removed.
 *
 * The host's state is read again here instead of trusting the preview: a
 * session may have become live, or its log may have gone, between the two
 * requests. A session with no stored log is not a blocker — removing it is a
 * successful no-op — so only a real reason keeps it out of the run.
 * @param runtime - the host's live state and metadata.
 * @param ids - the session ids to remove.
 * @param now - the reference time, epoch milliseconds.
 */
export async function planPolicyApply(
  runtime: SessionPreviewRuntime,
  ids: readonly string[],
  now: number = Date.now(),
): Promise<PolicyApplyPlan> {
  const impacts: SessionImpact[] = []
  for (const raw of ids) {
    impacts.push(await previewSession(runtime, raw, now))
  }
  return {
    impacts,
    deletableIds: impacts.filter(item => item.blockedReason === '').map(item => item.id),
    blocked: impacts.filter(item => item.blockedReason !== ''),
  }
}
