import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionPurgeController, type SessionRow } from '../src/client/controller.ts'

const ID_A = SessionId('2de8b71d-bd3b-4f4d-8d1d-5dceac76f934')
const ID_B = SessionId('8f14e45f-ceea-467a-9f1b-2c3d4e5f6a7b')
const ID_C = SessionId('b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e')

const rowA: SessionRow = { sessionId: ID_A, title: 'alpha', running: false }
const rowB: SessionRow = { sessionId: ID_B, title: 'beta', running: true }
const rowC: SessionRow = { sessionId: ID_C, title: 'gamma', running: false }
const rows = [rowA, rowB, rowC]

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function okResult(id: string) {
  return { ok: true, id, log: true, cache: true, ledger: true, stage: 'complete', error: '' }
}
function failedResult(id: string, error: string) {
  return { ok: false, id, log: false, cache: false, ledger: false, stage: 'delete-log', error }
}

/** Restores every fetch stub a factory installed, even when a test forgets. */
const installed: (() => void)[] = []
afterEach(() => {
  for (const restore of installed.splice(0)) restore()
})

function stubFetch(handler: () => Promise<Response>): { fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(handler)
  const original = globalThis.fetch
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  installed.push(() => { globalThis.fetch = original })
  return { fetchMock }
}

/**
 * A controller whose fetch result is settled by the test, so a request can be
 * observed while it is still in flight — the only state in which the
 * open-while-busy bug was reachable.
 */
function pendingController() {
  let settle: (response: Response) => void = () => {}
  const { fetchMock } = stubFetch(() => new Promise<Response>(resolve => { settle = resolve }))
  const refreshList = vi.fn(async () => {})
  return {
    controller: new SessionPurgeController(refreshList),
    fetchMock,
    refreshList,
    settle: (response: Response) => { settle(response) },
  }
}

/** A controller whose fetch always answers `payload` with `status`. */
function answeringController(payload: unknown, status = 200) {
  const { fetchMock } = stubFetch(async () => jsonResponse(payload, status))
  const refreshList = vi.fn(async () => {})
  return {
    controller: new SessionPurgeController(refreshList),
    fetchMock,
    refreshList,
  }
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>): { sessionId?: string, sessionIds?: string[], confirm?: boolean } {
  const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit | undefined
  return JSON.parse(String(init?.body ?? '{}')) as { sessionId?: string, sessionIds?: string[], confirm?: boolean }
}

describe('SessionPurgeController — dialog invariants', () => {
  // Regression: open() used to clear `busy` unconditionally, so a second delete
  // could be confirmed while the first was still in flight, and the first
  // completion then closed the second dialog while its own purge ran.
  it('ignores open() while a delete is in flight', async () => {
    const { controller, settle } = pendingController()
    controller.open(ID_A, 'alpha')
    const inFlight = controller.confirm()
    expect(controller.getSnapshot().busy).toBe(true)
    controller.open(ID_B, 'beta')
    expect(controller.getSnapshot().target).toMatchObject({ sessionId: ID_A, title: 'alpha' })
    expect(controller.getSnapshot().busy).toBe(true)
    settle(jsonResponse(okResult(ID_A)))
    await inFlight
    expect(controller.getSnapshot()).toMatchObject({ target: null, busy: false, error: null })
  })

  it('clears the dialog and refreshes the list after a successful single delete', async () => {
    const { controller, refreshList, fetchMock } = answeringController(okResult(ID_A))
    controller.open(ID_A, 'alpha')
    await controller.confirm()
    expect(postedBody(fetchMock)).toEqual({ sessionId: ID_A, confirm: true })
    expect(refreshList).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({ target: null, busy: false, error: null })
  })

  it('keeps the dialog open with the host error after a failed single delete', async () => {
    const { controller, refreshList } = answeringController(
      failedResult(ID_A, 'session-write-lease-held: another writer still holds this session'),
      409,
    )
    controller.open(ID_A, 'alpha')
    await controller.confirm()
    expect(controller.getSnapshot()).toMatchObject({ target: { sessionId: ID_A }, busy: false })
    expect(controller.getSnapshot().error).toContain('session-write-lease-held')
    expect(refreshList).not.toHaveBeenCalled()
  })

  it('refuses a second confirm while one is in flight', async () => {
    const { controller, settle, fetchMock } = pendingController()
    controller.open(ID_A, 'alpha')
    const inFlight = controller.confirm()
    await controller.confirm()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    settle(jsonResponse(okResult(ID_A)))
    await inFlight
  })
})

describe('SessionPurgeController — selection manager', () => {
  it('opens with a fresh snapshot and keeps the selection across a re-open', () => {
    const { controller } = answeringController({ ok: true })
    controller.openManager(rows)
    controller.toggle(ID_A)
    controller.openManager([rowB, rowC])
    expect(controller.getSnapshot().rows).toEqual([rowB, rowC])
    expect(controller.getSnapshot().selected).toEqual([ID_A])
  })

  it('resolves the confirmation from the intersection of selection and rows', () => {
    const { controller } = answeringController({ ok: true })
    controller.openManager(rows)
    controller.toggle(ID_A)
    controller.toggle(ID_C)
    // A refresh drops gamma: its id survives in the selection but must not be
    // sent to the host, which would answer a pointless per-item failure.
    controller.openManager([rowA, rowB])
    controller.openBatchFromManager()
    expect(controller.getSnapshot().batch?.items.map(item => item.sessionId)).toEqual([ID_A])
  })

  it('excludes the current session from the batch', () => {
    const { controller } = answeringController({ ok: true })
    controller.setCurrentSession(ID_A)
    controller.openManager(rows)
    controller.selectAll()
    expect(controller.selectedRows().map(row => row.sessionId)).toEqual([ID_B, ID_C])
    controller.openBatchFromManager()
    expect(controller.getSnapshot().batch?.items.map(item => item.sessionId)).toEqual([ID_B, ID_C])
    expect(controller.getSnapshot().managerOpen).toBe(false)
  })

  it('does not open a batch dialog with nothing selectable', () => {
    const { controller } = answeringController({ ok: true })
    controller.setCurrentSession(ID_A)
    controller.openManager([rowA])
    controller.selectAll()
    controller.openBatchFromManager()
    expect(controller.getSnapshot().batch).toBeNull()
  })

  it('refuses to open the manager while a delete is in flight', async () => {
    const { controller, settle } = pendingController()
    controller.open(ID_A, 'alpha')
    const inFlight = controller.confirm()
    controller.openManager(rows)
    expect(controller.getSnapshot().managerOpen).toBe(false)
    settle(jsonResponse(okResult(ID_A)))
    await inFlight
  })

  it('refuses to open the manager over an open confirmation dialog', () => {
    // The confirm overlay is modal, but the keyboard can still reach the sidebar
    // foot behind it; the manager must not stack over the dialog.
    const { controller } = answeringController({ ok: true })
    controller.open(ID_A, 'alpha')
    controller.openManager(rows)
    expect(controller.getSnapshot().managerOpen).toBe(false)
  })
})

describe('SessionPurgeController — batch deletion', () => {
  it('posts every selected id and clears the selection of deleted ids', async () => {
    const { controller, fetchMock, refreshList } = answeringController({
      ok: true,
      total: 2,
      succeeded: 2,
      failed: 0,
      results: [okResult(ID_A), okResult(ID_B)],
    })
    controller.openManager(rows)
    controller.toggle(ID_A)
    controller.toggle(ID_B)
    controller.openBatchFromManager()
    await controller.confirm()
    expect(postedBody(fetchMock)).toEqual({ sessionIds: [ID_A, ID_B], confirm: true })
    expect(refreshList).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({ batch: null, managerOpen: false, error: null })
    expect(controller.getSnapshot().selected).toEqual([])
  })

  it('retries only the failed remainder of a partial batch', async () => {
    let call = 0
    const { fetchMock } = stubFetch(async () => {
      call += 1
      return call === 1
        ? jsonResponse({
          ok: false,
          total: 2,
          succeeded: 1,
          failed: 1,
          results: [okResult(ID_A), failedResult(ID_B, 'session-still-live: the agent still appears in the registry')],
        }, 409)
        : jsonResponse({ ok: true, total: 1, succeeded: 1, failed: 0, results: [okResult(ID_B)] })
    })
    const controller = new SessionPurgeController(async () => {})
    controller.openManager(rows)
    controller.selectAll()
    controller.setCurrentSession(ID_C)
    controller.openBatchFromManager()
    await controller.confirm()
    // First answer: the failure kept the dialog open; the retry set is the failed id only.
    expect(controller.getSnapshot().batch?.items.map(item => item.sessionId)).toEqual([ID_B])
    expect(controller.getSnapshot().itemFailures).toHaveLength(1)
    expect(controller.getSnapshot().itemFailures[0].error).toContain('session-still-live')
    expect(controller.getSnapshot().error).toContain('1 of 2 deleted')
    await controller.confirm()
    expect(postedBody(fetchMock)).toEqual({ sessionIds: [ID_B], confirm: true })
    expect(controller.getSnapshot().batch).toBeNull()
    expect(controller.getSnapshot().itemFailures).toEqual([])
  })

  it('reports a batch where every item failed as deleting nothing', async () => {
    const { controller } = answeringController({
      ok: false,
      total: 2,
      succeeded: 0,
      failed: 2,
      results: [failedResult(ID_A, 'runtime-capability-missing: no delete primitive'), failedResult(ID_B, 'runtime-capability-missing: no delete primitive')],
    }, 501)
    controller.openManager(rows)
    controller.toggle(ID_A)
    controller.toggle(ID_B)
    controller.openBatchFromManager()
    await controller.confirm()
    expect(controller.getSnapshot().error).toContain('No session was deleted')
    // Both stay in the retry set — nothing was accomplished.
    expect(controller.getSnapshot().batch?.items.map(item => item.sessionId)).toEqual([ID_A, ID_B])
  })

  it('keeps the dialog open on a network failure without inventing per-item results', async () => {
    stubFetch(async () => { throw new Error('Failed to fetch') })
    const controller = new SessionPurgeController(async () => {})
    controller.openManager(rows)
    controller.toggle(ID_A)
    controller.openBatchFromManager()
    await controller.confirm()
    expect(controller.getSnapshot().batch?.items.map(item => item.sessionId)).toEqual([ID_A])
    expect(controller.getSnapshot().error).toBe('Failed to fetch')
    expect(controller.getSnapshot().itemFailures).toEqual([])
    expect(controller.getSnapshot().busy).toBe(false)
  })

  it('marks an item failed when the host results array is shorter than the request', async () => {
    const { controller } = answeringController({
      ok: false,
      total: 3,
      succeeded: 0,
      failed: 3,
      // The route answered for only two of the three requested items.
      results: [failedResult(ID_A, 'unexpected-error: operation failed'), failedResult(ID_B, 'unexpected-error: operation failed')],
    }, 500)
    controller.openManager(rows)
    controller.selectAll()
    controller.openBatchFromManager()
    await controller.confirm()
    // The third item must stay in the retry set instead of vanishing.
    expect(controller.getSnapshot().batch?.items.map(item => item.sessionId)).toEqual([ID_A, ID_B, ID_C])
    expect(controller.getSnapshot().itemFailures).toHaveLength(3)
    expect(controller.getSnapshot().itemFailures[2].error).toContain('HTTP 500')
  })
})
