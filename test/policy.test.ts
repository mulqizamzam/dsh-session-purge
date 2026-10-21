import { describe, expect, it } from 'vitest'
import {
  MAX_POLICY_SESSIONS,
  candidatesFrom,
  planPolicyApply,
  previewPolicy,
  selectByPolicy,
  validatePolicy,
  type PolicyCandidate,
  type SessionPolicyRuntime,
} from '../src/policy-core.ts'
import { SessionPurgeError } from '../src/purge-core.ts'
import type { LiveAgentState, SessionImpact, StoredSessionSnapshot } from '../src/preview-core.ts'

const ID_OLD = '2de8b71d-bd3b-4f4d-8d1d-5dceac76f934'
const ID_MID = '8f14e45f-ceea-467a-9f1b-2c3d4e5f6a7b'
const ID_NEW = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e'
const ID_OTHER = 'c3d4e5f6-a7b8-4900-8123-456789abcdef'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 4, 20)

function daysAgo(days: number): number {
  return NOW - days * DAY
}

function candidate(id: string, days: number, sizeBytes: number | null): PolicyCandidate {
  return { id, createdAt: daysAgo(days), sizeBytes }
}

describe('validatePolicy', () => {
  it('accepts a single limit on its own', () => {
    expect(validatePolicy({ maxAgeDays: 30 })).toEqual({ maxAgeDays: 30 })
    expect(validatePolicy({ maxCount: 5 })).toEqual({ maxCount: 5 })
    expect(validatePolicy({ maxTotalBytes: 1024 })).toEqual({ maxTotalBytes: 1024 })
  })

  it('accepts several limits together and ignores unset ones', () => {
    expect(validatePolicy({ maxAgeDays: 30, maxCount: 10, maxTotalBytes: null })).toEqual({ maxAgeDays: 30, maxCount: 10 })
  })

  it('refuses a policy with no limit at all', () => {
    expect(() => validatePolicy({})).toThrow(SessionPurgeError)
    expect(() => validatePolicy({ maxAgeDays: null })).toThrow(/at least one limit/)
  })

  it('refuses a policy that is not an object', () => {
    expect(() => validatePolicy('maxAgeDays=30')).toThrow(SessionPurgeError)
    expect(() => validatePolicy(null)).toThrow(SessionPurgeError)
    expect(() => validatePolicy([{ maxAgeDays: 1 }])).toThrow(SessionPurgeError)
  })

  it('refuses limits that are not usable numbers', () => {
    expect(() => validatePolicy({ maxAgeDays: 'thirty' })).toThrow(/maxAgeDays/)
    expect(() => validatePolicy({ maxAgeDays: Number.NaN })).toThrow(/maxAgeDays/)
    expect(() => validatePolicy({ maxAgeDays: Number.POSITIVE_INFINITY })).toThrow(/maxAgeDays/)
    expect(() => validatePolicy({ maxAgeDays: 0 })).toThrow(/maxAgeDays/)
    expect(() => validatePolicy({ maxCount: 0 })).toThrow(/maxCount/)
    expect(() => validatePolicy({ maxCount: 2.5 })).toThrow(/maxCount/)
    expect(() => validatePolicy({ maxTotalBytes: -1 })).toThrow(/maxTotalBytes/)
  })

  it('accepts a byte budget of zero, which removes every known-sized session', () => {
    expect(validatePolicy({ maxTotalBytes: 0 })).toEqual({ maxTotalBytes: 0 })
    const selection = selectByPolicy(
      [candidate(ID_OLD, 31, 100), candidate(ID_NEW, 1, 200)],
      { maxTotalBytes: 0 },
      NOW,
    )
    expect(selection.selected.map(item => item.id)).toEqual([ID_OLD, ID_NEW])
  })
})

describe('candidatesFrom', () => {
  it('reduces a host snapshot to the facts a policy needs', () => {
    const candidates = candidatesFrom([
      { header: { id: ID_OLD, createdAt: 1000 }, sizeBytes: 2048 },
      { header: { id: ID_NEW, createdAt: 2000 } },
    ])
    expect(candidates).toEqual([
      { id: ID_OLD, createdAt: 1000, sizeBytes: 2048 },
      { id: ID_NEW, createdAt: 2000, sizeBytes: null },
    ])
  })

  it('leaves out a snapshot whose id cannot name a stored session', () => {
    const candidates = candidatesFrom([
      { header: { id: 'not-a-uuid', createdAt: 1000 } },
      { header: { createdAt: 1000 } },
      { header: { id: ID_OLD, createdAt: 1000 } },
    ])
    expect(candidates.map(item => item.id)).toEqual([ID_OLD])
  })

  it('normalizes the host id form without dropping its prefix', () => {
    const candidates = candidatesFrom([{ header: { id: `session-${ID_OLD}`, createdAt: 1000 } }])
    expect(candidates[0]?.id).toBe(`session-${ID_OLD}`)
  })
})

describe('selectByPolicy', () => {
  it('selects exactly the sessions older than the age limit', () => {
    const selection = selectByPolicy(
      [candidate(ID_OLD, 31, 10), candidate(ID_MID, 30, 10), candidate(ID_NEW, 29, 10)],
      { maxAgeDays: 30 },
      NOW,
    )
    expect(selection.selected.map(item => item.id)).toEqual([ID_OLD])
    expect(selection.kept.map(item => item.id)).toEqual([ID_NEW, ID_MID])
  })

  it('reads the age with the same rounding the operator is shown', () => {
    // 30.04 days old reads as 30.0 days, so a 30-day limit keeps it.
    const borderline: PolicyCandidate = { id: ID_MID, createdAt: NOW - Math.round(30.04 * DAY), sizeBytes: 10 }
    const selection = selectByPolicy([borderline], { maxAgeDays: 30 }, NOW)
    expect(selection.selected).toEqual([])
  })

  it('keeps the newest sessions and selects the rest when the count is capped', () => {
    const selection = selectByPolicy(
      [candidate(ID_OLD, 31, 10), candidate(ID_MID, 30, 10), candidate(ID_NEW, 29, 10)],
      { maxCount: 2 },
      NOW,
    )
    expect(selection.selected.map(item => item.id)).toEqual([ID_OLD])
    expect(selection.kept.map(item => item.id)).toEqual([ID_NEW, ID_MID])
  })

  it('keeps the newest sessions that fit under the byte budget', () => {
    const selection = selectByPolicy(
      [candidate(ID_OLD, 31, 300), candidate(ID_MID, 30, 300), candidate(ID_NEW, 29, 300)],
      { maxTotalBytes: 700 },
      NOW,
    )
    // The newest two fit (600 bytes); the oldest one does not.
    expect(selection.selected.map(item => item.id)).toEqual([ID_OLD])
    expect(selection.bytesToFree).toBe(300)
    expect(selection.bytesKept).toBe(600)
  })

  it('selects everything past the byte budget, whatever the size of each session', () => {
    const selection = selectByPolicy(
      [candidate(ID_OLD, 31, 100), candidate(ID_MID, 30, 100), candidate(ID_NEW, 29, 100)],
      { maxTotalBytes: 100 },
      NOW,
    )
    // Oldest first: the cut falls after the newest session.
    expect(selection.selected.map(item => item.id)).toEqual([ID_OLD, ID_MID])
  })

  it('keeps a session whose size the host did not report', () => {
    const selection = selectByPolicy(
      [candidate(ID_OLD, 31, null), candidate(ID_NEW, 1, 100)],
      { maxTotalBytes: 100 },
      NOW,
    )
    // Its size cannot be shown to break the budget, so it is not removed.
    expect(selection.selected.map(item => item.id)).toEqual([])
    expect(selection.bytesToFree).toBeNull()
  })

  it('keeps a session whose size the host did not report even past the byte cut', () => {
    // The cut falls at C: A fits the cap, C does not, and D sits behind the cut
    // with a size the host never reported. The positional cut may only remove
    // sessions whose size is known.
    const selection = selectByPolicy(
      [candidate(ID_NEW, 1, 100), candidate(ID_OLD, 31, 200), { id: ID_MID, createdAt: daysAgo(20), sizeBytes: null }],
      { maxTotalBytes: 100 },
      NOW,
    )
    expect(selection.selected.map(item => item.id)).toEqual([ID_OLD])
    expect(selection.kept.map(item => item.id)).toContain(ID_MID)
  })

  it('never removes a session without a known creation time because of its age', () => {
    const selection = selectByPolicy(
      [{ id: ID_OLD, createdAt: null, sizeBytes: 10 }],
      { maxAgeDays: 1 },
      NOW,
    )
    expect(selection.selected).toEqual([])
  })

  it('removes a session that breaks any one of the limits', () => {
    const selection = selectByPolicy(
      [candidate(ID_OLD, 31, 10), candidate(ID_MID, 30, 10), candidate(ID_NEW, 29, 10)],
      { maxAgeDays: 30, maxCount: 2 },
      NOW,
    )
    expect(selection.selected.map(item => item.id)).toEqual([ID_OLD])
  })

  it('never removes an excluded session, but it still occupies a count slot', () => {
    const selection = selectByPolicy(
      [candidate(ID_OLD, 31, 10), candidate(ID_MID, 30, 10), candidate(ID_NEW, 29, 10)],
      { maxCount: 2 },
      NOW,
      new Set([ID_MID]),
    )
    // The excluded session holds a slot, so the older one is still removed.
    expect(selection.selected.map(item => item.id)).toEqual([ID_OLD])
    expect(selection.kept.map(item => item.id)).toEqual([ID_NEW, ID_MID])
  })

  it('decides the same way twice over the same store', () => {
    const store = [candidate(ID_OLD, 31, 10), candidate(ID_MID, 30, 10), candidate(ID_NEW, 29, 10)]
    const first = selectByPolicy(store, { maxCount: 1 }, NOW)
    const second = selectByPolicy([...store].reverse(), { maxCount: 1 }, NOW)
    expect(first.selected.map(item => item.id)).toEqual(second.selected.map(item => item.id))
    expect(first.selected.map(item => item.id)).toEqual([ID_OLD, ID_MID])
  })

  it('lists the selection oldest first', () => {
    const selection = selectByPolicy(
      [candidate(ID_OLD, 31, 10), candidate(ID_MID, 30, 10), candidate(ID_NEW, 29, 10)],
      { maxCount: 1 },
      NOW,
    )
    expect(selection.selected.map(item => item.id)).toEqual([ID_OLD, ID_MID])
  })
})

interface FakeRuntime extends SessionPolicyRuntime {
  listed: string[]
}

function fakeRuntime(options: {
  snapshots: readonly StoredSessionSnapshot[]
  live?: readonly string[]
  liveAgentState?: LiveAgentState
  attached?: readonly string[]
  canStopAndDrain?: (id: string) => boolean
}): FakeRuntime {
  const listed: string[] = []
  const live = new Set(options.live ?? [])
  const attached = new Set(options.attached ?? [])
  return {
    listed,
    async listSessions() {
      listed.push('list')
      return options.snapshots
    },
    async statSession(id: string) {
      return options.snapshots.find(snapshot => snapshot.header?.id === id)
    },
    liveAgentState(id: string): LiveAgentState {
      if (options.liveAgentState) return options.liveAgentState
      return live.has(id) ? 'live' : 'idle'
    },
    canStopAndDrain: options.canStopAndDrain ?? (() => true),
    isAttached: (id: string) => attached.has(id),
  }
}

describe('previewPolicy', () => {
  const snapshots: StoredSessionSnapshot[] = [
    { header: { id: ID_OLD, createdAt: daysAgo(31) }, sizeBytes: 300 },
    { header: { id: ID_MID, createdAt: daysAgo(30) }, sizeBytes: 300 },
    { header: { id: ID_NEW, createdAt: daysAgo(1) }, sizeBytes: 300 },
  ]

  it('reports what the policy would remove without touching anything', async () => {
    const runtime = fakeRuntime({ snapshots })
    const report = await previewPolicy(runtime, { maxAgeDays: 30 }, NOW)
    expect(report.totalSessions).toBe(3)
    expect(report.selectedCount).toBe(1)
    expect(report.totalSelected).toBe(1)
    expect(report.keptCount).toBe(2)
    expect(report.bytesToFree).toBe(300)
    expect(report.bytesKept).toBe(600)
    expect(report.selected.map(item => item.id)).toEqual([ID_OLD])
    expect(report.selected[0]?.deletable).toBe(true)
    expect(report.truncated).toBe(false)
  })

  it('describes the age of each selected session', async () => {
    const runtime = fakeRuntime({ snapshots })
    const report = await previewPolicy(runtime, { maxAgeDays: 30 }, NOW)
    expect(report.selected[0]?.ageDays).toBe(31)
    expect(report.selected[0]?.sizeBytes).toBe(300)
  })

  it('keeps an excluded session and never reports it as selected', async () => {
    const runtime = fakeRuntime({ snapshots })
    const report = await previewPolicy(runtime, { maxAgeDays: 30 }, NOW, [ID_OLD])
    expect(report.selected).toEqual([])
    expect(report.totalSelected).toBe(0)
    expect(report.excludedIds).toEqual([ID_OLD])
  })

  it('reports a session a live agent holds as blocked when the host cannot stop it', async () => {
    const runtime = fakeRuntime({ snapshots, live: [ID_OLD] })
    runtime.canStopAndDrain = () => false
    const report = await previewPolicy(runtime, { maxAgeDays: 30 }, NOW)
    expect(report.selected[0]?.liveAgent).toBe('live')
    expect(report.selected[0]?.blockedReason).toBe('session-live')
    expect(report.selected[0]?.deletable).toBe(false)
  })

  it('reports a session a live agent holds as removable when the host can stop it', async () => {
    const runtime = fakeRuntime({ snapshots, live: [ID_OLD] })
    const report = await previewPolicy(runtime, { maxAgeDays: 30 }, NOW)
    expect(report.selected[0]?.liveAgent).toBe('live')
    expect(report.selected[0]?.blockedReason).toBe('')
    expect(report.selected[0]?.deletable).toBe(true)
  })

  it('reports a host without an agent registry as blocking everything', async () => {
    const runtime = fakeRuntime({ snapshots, liveAgentState: 'unknown' })
    const report = await previewPolicy(runtime, { maxAgeDays: 30 }, NOW)
    expect(report.selected[0]?.blockedReason).toBe('agent-registry-unavailable')
    expect(report.selected[0]?.deletable).toBe(false)
  })

  it('caps one run and says so', async () => {
    const many: StoredSessionSnapshot[] = Array.from({ length: MAX_POLICY_SESSIONS + 25 }, (_unused, index) => ({
      header: { id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`, createdAt: daysAgo(100 + index) },
      sizeBytes: 10,
    }))
    const runtime = fakeRuntime({ snapshots: many })
    const report = await previewPolicy(runtime, { maxAgeDays: 1 }, NOW)
    expect(report.selectedCount).toBe(MAX_POLICY_SESSIONS)
    expect(report.totalSelected).toBe(MAX_POLICY_SESSIONS + 25)
    expect(report.truncated).toBe(true)
  })
})

describe('planPolicyApply', () => {
  const snapshots: StoredSessionSnapshot[] = [
    { header: { id: ID_OLD, createdAt: daysAgo(31) }, sizeBytes: 300 },
    { header: { id: ID_NEW, createdAt: daysAgo(1) }, sizeBytes: 300 },
  ]

  it('separates the removable sessions from the blocked ones', async () => {
    const runtime = fakeRuntime({ snapshots })
    const plan = await planPolicyApply(runtime, [ID_OLD, ID_NEW], NOW)
    expect(plan.deletableIds).toEqual([ID_OLD, ID_NEW])
    expect(plan.blocked).toEqual([])
  })

  it('keeps a session out of the run when a live agent holds it and the host cannot stop it', async () => {
    const runtime = fakeRuntime({ snapshots, live: [ID_OLD] })
    runtime.canStopAndDrain = () => false
    const plan = await planPolicyApply(runtime, [ID_OLD, ID_NEW], NOW)
    expect(plan.deletableIds).toEqual([ID_NEW])
    expect(plan.blocked.map(item => item.id)).toEqual([ID_OLD])
    expect(plan.blocked[0]?.blockedReason).toBe('session-live')
  })

  it('treats a session with no stored log as removable, because its removal is a no-op', async () => {
    const runtime = fakeRuntime({ snapshots: [] })
    const plan = await planPolicyApply(runtime, [ID_OLD], NOW)
    expect(plan.deletableIds).toEqual([ID_OLD])
    expect(plan.blocked).toEqual([])
  })

  it('keeps a malformed id out of the run', async () => {
    const runtime = fakeRuntime({ snapshots })
    const plan = await planPolicyApply(runtime, ['not-a-uuid'], NOW)
    expect(plan.deletableIds).toEqual([])
    expect(plan.blocked[0]?.blockedReason).toBe('invalid-session-id')
  })
})
