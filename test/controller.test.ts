import { afterEach, describe, expect, it, vi } from 'vitest'
import { nonEmptySessionTitle, SessionPurgeController, type SessionRow } from '../src/client/controller.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const ID = '2de8b71d-bd3b-4f4d-8d1d-5dceac76f934' as SessionId
const ID2 = 'a7f69c60-2a03-41cd-b9e1-dfb270ce6c83' as SessionId

function row(sessionId: SessionId): SessionRow {
  return { sessionId, title: String(sessionId), running: false }
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

function mockFetch(payload: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => response(payload, status)))
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('SessionPurgeController toast lifecycle', () => {
  it('toast auto-clears after 4s', async () => {
    vi.useFakeTimers()
    mockFetch({ ok: true })
    const controller = new SessionPurgeController(() => {})
    controller.open(ID, 'Session')
    await controller.confirm()
    expect(controller.getSnapshot().toast).toBe('1 session deleted')
    vi.advanceTimersByTime(3999)
    expect(controller.getSnapshot().toast).toBe('1 session deleted')
    vi.advanceTimersByTime(1)
    expect(controller.getSnapshot().toast).toBeNull()
  })

  it('opening a new dialog clears a lingering toast', async () => {
    vi.useFakeTimers()
    mockFetch({ ok: true })
    const controller = new SessionPurgeController(() => {})
    controller.open(ID, 'Session')
    await controller.confirm()
    expect(controller.getSnapshot().toast).toBe('1 session deleted')
    expect(vi.getTimerCount()).toBe(1)
    controller.open(ID2, 'Another session')
    expect(controller.getSnapshot().toast).toBeNull()
    expect(vi.getTimerCount()).toBe(0)

    await controller.confirm()
    expect(controller.getSnapshot().toast).toBe('1 session deleted')
    controller.setAvailableRows([row(ID)])
    controller.toggle(ID)
    controller.openBatchFromSelection()
    expect(controller.getSnapshot().toast).toBeNull()
    expect(controller.getSnapshot().batch?.items).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('two consecutive toasts do not stack (second replaces first and re-arms timer)', async () => {
    vi.useFakeTimers()
    mockFetch({ ok: true })
    const controller = new SessionPurgeController(() => {})
    controller.open(ID, 'Session')
    await controller.confirm()
    expect(controller.getSnapshot().toast).toBe('1 session deleted')
    vi.advanceTimersByTime(3000)
    controller.setAvailableRows([row(ID2)])
    controller.toggle(ID2)
    controller.openBatchFromSelection()
    mockFetch({ ok: false, results: [{ ok: true }] }, 207)
    await controller.confirm()
    expect(controller.getSnapshot().toast).toBe('1 sessions deleted')
    vi.advanceTimersByTime(1000)
    expect(controller.getSnapshot().toast).toBe('1 sessions deleted')
    vi.advanceTimersByTime(2999)
    expect(controller.getSnapshot().toast).toBe('1 sessions deleted')
    vi.advanceTimersByTime(1)
    expect(controller.getSnapshot().toast).toBeNull()
  })

  it('dispose clears the pending toast timer', async () => {
    vi.useFakeTimers()
    mockFetch({ ok: true })
    const controller = new SessionPurgeController(() => {})
    controller.open(ID, 'Session')
    await controller.confirm()
    expect(vi.getTimerCount()).toBe(1)
    controller.dispose()
    expect(controller.getSnapshot().toast).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unsubscribing the last listener clears the pending toast timer', async () => {
    vi.useFakeTimers()
    mockFetch({ ok: true })
    const controller = new SessionPurgeController(() => {})
    const unsubscribe = controller.subscribe(() => {})
    controller.open(ID, 'Session')
    await controller.confirm()
    expect(vi.getTimerCount()).toBe(1)
    unsubscribe()
    expect(controller.getSnapshot().toast).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('header title fallback', () => {
  it('never resolves a missing or blank header title to an empty string', () => {
    expect(nonEmptySessionTitle('', 'current session')).toBe('current session')
    expect(nonEmptySessionTitle('   ', 'current session')).toBe('current session')
    expect(nonEmptySessionTitle(undefined, 'current session')).toBe('current session')
    expect(nonEmptySessionTitle('Project Alpha', 'current session')).toBe('Project Alpha')
  })
})

describe('SessionPurgeController selection reconciliation', () => {
  it('stale selections are pruned when rows change', () => {
    const controller = new SessionPurgeController(() => {})
    controller.setAvailableRows([row(ID), row(ID2)])
    controller.toggle(ID)
    controller.toggle(ID2)
    controller.setAvailableRows([row(ID2)])
    expect(controller.getSnapshot().selected).toEqual([ID2])
  })

  it('opening batch with only stale ids surfaces an error and clears selection', () => {
    const controller = new SessionPurgeController(() => {})
    controller.toggle(ID)
    controller.openBatchFromSelection()
    expect(controller.getSnapshot().selected).toEqual([])
    expect(controller.getSnapshot().error).toBe('selection-stale: selected sessions are no longer visible.')
    expect(controller.getSnapshot().batch).toBeNull()
  })

  it('uses string-form equality when matching selected ids to rows', () => {
    const controller = new SessionPurgeController(() => {})
    const wrappedId = new String(ID) as unknown as SessionId
    controller.setAvailableRows([row(wrappedId)])
    controller.toggle(ID)
    controller.openBatchFromSelection()
    expect(controller.getSnapshot().batch?.items.map(item => item.sessionId)).toEqual([wrappedId])
  })

  it('matches id casing for UI selection and posts the original row id', async () => {
    const differentlyCasedId = ID.toUpperCase() as SessionId
    const controller = new SessionPurgeController(() => {})
    controller.setAvailableRows([row(differentlyCasedId)])
    controller.toggle(ID)
    controller.openBatchFromSelection()
    expect(controller.getSnapshot().batch?.items.map(item => item.sessionId)).toEqual([differentlyCasedId])

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => response({ ok: true, results: [{ ok: true }] }))
    vi.stubGlobal('fetch', fetchMock)
    await controller.confirm()

    const request = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toEqual({ sessionIds: [differentlyCasedId], confirm: true })
  })

  it('does not treat a prefixed session id as its bare UUID in UI selection', () => {
    const prefixedId = ('session-' + ID) as SessionId
    const controller = new SessionPurgeController(() => {})
    controller.setAvailableRows([row(prefixedId)])
    controller.toggle(ID)
    controller.openBatchFromSelection()

    expect(controller.getSnapshot().batch).toBeNull()
    expect(controller.getSnapshot().selected).toEqual([])
    expect(controller.getSnapshot().error).toBe('selection-stale: selected sessions are no longer visible.')
  })

  it('toggleMany preserves bare and prefixed ids as distinct selections', () => {
    const prefixedId = ('session-' + ID) as SessionId
    const controller = new SessionPurgeController(() => {})
    controller.toggleMany([ID, prefixedId])
    expect(controller.getSnapshot().selected).toEqual([ID, prefixedId])

    controller.toggleMany([ID])
    expect(controller.getSnapshot().selected).toEqual([prefixedId])
  })

  it('selectAll selects and clears bare and prefixed ids independently', () => {
    const prefixedId = ('session-' + ID) as SessionId
    const rows = [row(ID), row(prefixedId)]
    const controller = new SessionPurgeController(() => {})
    controller.selectAll(rows)
    expect(controller.getSnapshot().selected).toEqual([ID, prefixedId])

    controller.selectAll(rows)
    expect(controller.getSnapshot().selected).toEqual([])
  })

  it('ignores attempts to open either dialog while a delete is in flight', async () => {
    let resolveFetch!: (value: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => {
      resolveFetch = resolve
    })))
    const controller = new SessionPurgeController(() => {})
    controller.setAvailableRows([row(ID2)])
    controller.toggle(ID2)
    controller.open(ID, 'Original session')
    const pending = controller.confirm()
    expect(controller.getSnapshot().busy).toBe(true)
    controller.open(ID2, 'Replacement session')
    controller.openBatchFromSelection()
    expect(controller.getSnapshot().target?.sessionId).toBe(ID)
    expect(controller.getSnapshot().batch).toBeNull()
    expect(controller.getSnapshot().busy).toBe(true)
    resolveFetch(response({ ok: true }))
    await pending
    expect(controller.getSnapshot().target).toBeNull()
  })

  it('accepts HTTP 207 batch responses by trusting their per-item results', async () => {
    const controller = new SessionPurgeController(() => {})
    controller.setAvailableRows([row(ID)])
    controller.toggle(ID)
    controller.openBatchFromSelection()
    mockFetch({ ok: false, results: [{ ok: true }] }, 207)
    await controller.confirm()
    expect(controller.getSnapshot().itemFailures).toEqual([])
    expect(controller.getSnapshot().error).toBeNull()
    expect(controller.getSnapshot().toast).toBe('1 sessions deleted')
  })
})
