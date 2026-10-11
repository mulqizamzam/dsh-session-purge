import { describe, expect, it, vi } from 'vitest'
import { normalizeSessionId, purgeSession, purgeSessions, SessionPurgeError, type SessionPurgeRuntime } from '../src/purge-core.ts'

const ID = '2de8b71d-bd3b-4f4d-8d1d-5dceac76f934'
const ID2 = '8f14e45f-ceea-467a-9f1b-2c3d4e5f6a7b'

function runtime(overrides: Partial<SessionPurgeRuntime> = {}) {
  const calls: string[] = []
  const base: SessionPurgeRuntime = {
    stopAndDrainAgent: async () => { calls.push('stop') },
    flushSession: async () => { calls.push('flush') },
    detachSession: async () => { calls.push('detach') },
    deleteLog: async () => { calls.push('delete') },
    logIsAbsent: async () => { calls.push('verify'); return true },
    purgeProjectionCache: async () => { calls.push('cache'); return true },
    releaseWorkspaceMembership: async () => { calls.push('ledger') },
  }
  return { runtime: { ...base, ...overrides }, calls }
}

describe('normalizeSessionId', () => {
  it('preserves the stored id form, because persistence keys each artifact by it verbatim', () => {
    expect(normalizeSessionId(ID)).toBe(ID)
    expect(normalizeSessionId(`session-${ID}`)).toBe(`session-${ID}`)
    expect(normalizeSessionId(`  session-${ID.toUpperCase()}  `)).toBe(`session-${ID}`)
  })
  it('rejects path-like or malformed ids', () => {
    expect(() => normalizeSessionId('../../sessions')).toThrow(/UUID/)
    expect(() => normalizeSessionId('session-../..')).toThrow(/UUID/)
  })
  it('hands the persistence layer the same id the host reported', async () => {
    const seen: string[] = []
    const { runtime: adapter } = runtime({
      deleteLog: async id => { seen.push(id) },
      logIsAbsent: async id => { seen.push(id); return true },
    })
    await purgeSession(adapter, `session-${ID}`)
    expect(seen).toEqual([`session-${ID}`, `session-${ID}`])
  })
})

describe('purgeSession', () => {
  it('runs destructive steps in the required order', async () => {
    const { runtime: adapter, calls } = runtime()
    const result = await purgeSession(adapter, ID)
    expect(result.ok).toBe(true)
    expect(calls).toEqual(['stop', 'flush', 'detach', 'delete', 'verify', 'cache', 'ledger'])
  })

  it('does not purge cache or ledger if log absence cannot be confirmed', async () => {
    const { runtime: adapter, calls } = runtime({ logIsAbsent: async () => { calls.push('verify'); return false } })
    const result = await purgeSession(adapter, ID)
    expect(result.ok).toBe(false)
    expect(result.log).toBe(false)
    expect(calls).toEqual(['stop', 'flush', 'detach', 'delete', 'verify'])
  })

  it('still releases the ledger if cache cleanup fails after log deletion', async () => {
    const { runtime: adapter, calls } = runtime({
      purgeProjectionCache: async () => { calls.push('cache'); throw new Error('cache I/O failed') },
    })
    const result = await purgeSession(adapter, ID)
    expect(result.ok).toBe(false)
    expect(result.log).toBe(true)
    expect(result.cache).toBe(false)
    expect(result.ledger).toBe(true)
    expect(calls).toEqual(['stop', 'flush', 'detach', 'delete', 'verify', 'cache', 'ledger'])
  })

  it('does not proceed to deletion when stop/drain fails', async () => {
    const stopError = new Error('agent still live')
    const { runtime: adapter, calls } = runtime({ stopAndDrainAgent: async () => { calls.push('stop'); throw stopError } })
    const result = await purgeSession(adapter, ID)
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('stop-agent')
    expect(calls).toEqual(['stop'])
  })

  it('passes a cancellation signal into the host lifecycle steps', async () => {
    const controller = new AbortController()
    const stop = vi.fn(async (_id: string, signal?: AbortSignal) => { expect(signal).toBe(controller.signal) })
    const { runtime: adapter } = runtime({ stopAndDrainAgent: stop })
    await purgeSession(adapter, ID, controller.signal)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('hands the raw exception of a sanitized failure to the observer', async () => {
    const raw = new Error('jsonl artifact locked by another process')
    const { runtime: adapter } = runtime({ stopAndDrainAgent: async () => { throw raw } })
    const observed: { message: string; stage: string }[] = []
    const result = await purgeSession(adapter, ID, undefined, (error, stage) => {
      observed.push({ message: error instanceof Error ? error.message : String(error), stage })
    })
    expect(result.error).toBe('unexpected-error: operation failed; inspect host logs for details.')
    // The public string hides the cause, so the observer must carry it instead.
    expect(observed).toEqual([{ message: 'jsonl artifact locked by another process', stage: 'stop-agent' }])
  })

  it('does not hand typed SessionPurgeErrors to the observer', async () => {
    // A typed failure already carries its full diagnostic in the public message.
    const { runtime: adapter } = runtime({ deleteLog: async () => { throw new SessionPurgeError('runtime-capability-missing', 'delete-log', 'no delete primitive') } })
    const observed: unknown[] = []
    const result = await purgeSession(adapter, ID, undefined, error => { observed.push(error) })
    expect(result.error).toBe('runtime-capability-missing: no delete primitive')
    expect(observed).toEqual([])
  })

  // A cancelled purge is neither a host defect nor a provider failure: it
  // answers with its own code and reaches no observer, so an aborted request
  // stops polluting the host log with "unexpected failure" lines.
  it('classifies an abort instead of reporting unexpected-error', async () => {
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    const { runtime: adapter } = runtime({ deleteLog: async () => { throw abort } })
    const observed: unknown[] = []
    const result = await purgeSession(adapter, ID, undefined, error => { observed.push(error) })
    expect(result.error).toContain('aborted:')
    expect(result.stage).toBe('delete-log')
    expect(result.ok).toBe(false)
    expect(observed).toEqual([])
  })
})

describe('purgeSessions', () => {
  it('purges every id in request order and reports per-item results', async () => {
    const seen: string[] = []
    const { runtime: adapter } = runtime({ deleteLog: async id => { seen.push(id) } })
    const batch = await purgeSessions(adapter, [ID, `session-${ID2}`])
    expect(batch).toMatchObject({ ok: true, total: 2, succeeded: 2, failed: 0 })
    expect(seen).toEqual([ID, `session-${ID2}`])
    expect(batch.results.map(result => result.ok)).toEqual([true, true])
  })

  // The point of a batch: one item failing must not abort the rest, or the
  // operator cannot tell which of N sessions were actually removed.
  it('isolates a failing item and continues with the rest', async () => {
    const deleted: string[] = []
    const { runtime: adapter } = runtime({
      deleteLog: async id => {
        deleted.push(id)
        if (id === ID2) throw new Error('jsonl artifact locked by another process')
      },
    })
    const batch = await purgeSessions(adapter, [ID, ID2, ID])
    expect(deleted).toEqual([ID, ID2, ID])
    expect(batch.ok).toBe(false)
    expect(batch.total).toBe(3)
    expect(batch.succeeded).toBe(2)
    expect(batch.failed).toBe(1)
    expect(batch.results[1].ok).toBe(false)
    expect(batch.results[1].error).toContain('unexpected-error')
  })

  it('reports onLogDeleted only for ids whose log is confirmed gone', async () => {
    const announced: string[] = []
    const { runtime: adapter } = runtime({
      logIsAbsent: async id => id !== ID2,
    })
    const batch = await purgeSessions(adapter, [ID, ID2], undefined, undefined, async id => { announced.push(id) })
    expect(batch.succeeded).toBe(1)
    expect(announced).toEqual([ID])
  })

  it('answers ok:false for an empty batch instead of a false success', async () => {
    const { runtime: adapter } = runtime()
    const batch = await purgeSessions(adapter, [])
    expect(batch.ok).toBe(false)
    expect(batch.total).toBe(0)
    expect(batch.results).toEqual([])
  })

  it('never starts a further item once the request is aborted', async () => {
    const controller = new AbortController()
    const abort = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    const deleted: string[] = []
    const { runtime: adapter } = runtime({
      deleteLog: async id => {
        deleted.push(id)
        controller.abort()
        throw abort
      },
    })
    const batch = await purgeSessions(adapter, [ID, ID2], controller.signal)
    // The first item is cancelled mid-delete; the second fails its pre-stage
    // abort check and never reaches any host lifecycle step.
    expect(deleted).toEqual([ID])
    expect(batch.results.map(result => result.error)).toEqual([
      expect.stringContaining('aborted:'),
      expect.stringContaining('aborted:'),
    ])
    expect(batch.succeeded).toBe(0)
  })
})
