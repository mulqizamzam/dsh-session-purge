import { describe, expect, it, vi } from 'vitest'
import { normalizeSessionId, purgeSession, type SessionPurgeRuntime } from '../src/purge-core.ts'

const ID = '2de8b71d-bd3b-4f4d-8d1d-5dceac76f934'

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
  it('accepts raw and prefixed UUIDs and returns one canonical id', () => {
    expect(normalizeSessionId(ID)).toBe(ID)
    expect(normalizeSessionId(`session-${ID}`)).toBe(ID)
  })
  it('rejects path-like or malformed ids', () => {
    expect(() => normalizeSessionId('../../sessions')).toThrow(/UUID/)
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
})
