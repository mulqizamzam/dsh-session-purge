import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

const ID = '2de8b71d-bd3b-4f4d-8d1d-5dceac76f934'
const ID2 = '8f14e45f-ceea-467a-9f1b-2c3d4e5f6a7b'
const ID3 = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e'
const PREVIEW_PATH = '/api/session-purge/preview'
const DELETE_PATH = '/api/session-purge/delete'

// The route ages the stored session against the real clock, so the fixture is
// built from the real clock too.
const NOW = Date.now()
const FIVE_DAYS_AGO = NOW - 5 * 86_400_000

type RegisteredRoute = {
  path: string
  methods: readonly string[]
  fetch: (request: Request) => Promise<Response>
}

interface Impact {
  id: string
  exists: boolean
  createdAt: number | null
  ageDays: number | null
  sizeBytes: number | null
  liveAgent: boolean
  attached: boolean
  deletable: boolean
  blockedReason: string
}

interface PreviewPayload {
  ok?: boolean
  error?: string
  results?: Impact[]
  totalBytes?: number
}

/** The host bridges /api requests against a synthetic base; request.url never carries this authority. */
function browserRequest(path: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(new URL(path, 'http://dsh.internal'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

interface Harness {
  routes: RegisteredRoute[]
  deleted: string[]
  dispose(): Promise<void>
}

/**
 * A REAL cordis topology, like the delete route's suite: the plugin captures the
 * optional host services through `ctx.inject`, so the services must exist on a
 * real Context before the plugin loads.
 */
async function install(services?: Record<string, object>): Promise<Harness> {
  const routes: RegisteredRoute[] = []
  const deleted: string[] = []
  const root = new Context()
  const host = root.plugin({
    name: 'test-host',
    apply(c) {
      c.reflect.provide('tools', { register: () => {} })
      c.reflect.provide('connection', {
        fetch: {
          register: (route: RegisteredRoute) => {
            routes.push(route)
            return () => {}
          },
        },
      })
      for (const [name, value] of Object.entries(services ?? {})) {
        c.reflect.provide(name, value)
      }
    },
  })
  await host
  const plugin = root.plugin({ name: 'session-purge', inject: ['tools', 'connection'], apply })
  await plugin
  return {
    routes,
    deleted,
    dispose: async () => {
      await plugin.dispose()
      await host.dispose()
    },
  }
}

/** A host that can report stored-session metadata and can delete (the delete must never be called). */
function previewCapableHost(
  snapshots: Record<string, { createdAt: number; sizeBytes?: number }>,
  deleted: string[],
  extra: Record<string, object> = {},
): Record<string, object> {
  return {
    agents: { get: () => undefined, list: () => [] },
    sessions: { get: () => undefined, list: () => [], flush: async () => true },
    sessionPersistence: {
      delete: async (id: string) => { deleted.push(id) },
      stat: async (id: string) => {
        const entry = snapshots[id]
        if (!entry) return undefined
        return { header: { id, createdAt: entry.createdAt }, revision: 'rev-1', sizeBytes: entry.sizeBytes }
      },
      listSync: () => [] as readonly { id?: string }[],
    },
    sessionProjectionCache: { purge: async () => true },
    workspaceRegistry: { releaseSession: async () => {} },
    ...extra,
  }
}

let active: Harness[] = []

afterEach(async () => {
  for (const harness of active.splice(0)) await harness.dispose()
})

async function opened(services?: Record<string, object>): Promise<Harness> {
  const harness = await install(services)
  active.push(harness)
  return harness
}

async function preview(route: RegisteredRoute, body: unknown, headers: Record<string, string> = {}) {
  const response = await route.fetch(browserRequest(PREVIEW_PATH, body, headers))
  return { status: response.status, payload: await response.json() as PreviewPayload }
}

const SAME_ORIGIN = { host: '127.0.0.1:13080', origin: 'http://127.0.0.1:13080' }

describe('POST /api/session-purge/preview', () => {
  it('registers the preview route for POST only, beside the delete route', async () => {
    const { routes } = await opened(previewCapableHost({}, []))
    expect(routes.map(route => route.path)).toEqual([DELETE_PATH, PREVIEW_PATH])
    expect([...routes[1].methods]).toEqual(['POST'])
  })

  it('reports the stored size and age of a session', async () => {
    const deleted: string[] = []
    const { routes } = await opened(previewCapableHost({ [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 4096 } }, deleted))
    const { status, payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    const impact = payload.results?.[0]
    expect(impact?.id).toBe(ID)
    expect(impact?.exists).toBe(true)
    expect(impact?.sizeBytes).toBe(4096)
    expect(impact?.createdAt).toBe(FIVE_DAYS_AGO)
    expect(impact?.ageDays).toBeGreaterThan(4.9)
    expect(impact?.ageDays).toBeLessThan(5.1)
    expect(impact?.deletable).toBe(true)
    expect(impact?.blockedReason).toBe('')
  })

  // The whole point of the route: it observes without touching anything.
  it('never deletes, not even for a batch of deletable sessions', async () => {
    const deleted: string[] = []
    const { routes } = await opened(previewCapableHost({
      [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 100 },
      [ID2]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 200 },
    }, deleted))
    const { status } = await preview(routes[1], { sessionIds: [ID, ID2] }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(deleted).toEqual([])
  })

  it('previews a batch in request order and totals the stored bytes', async () => {
    const deleted: string[] = []
    const { routes } = await opened(previewCapableHost({
      [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 100 },
      [ID2]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 250 },
      [ID3]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 50 },
    }, deleted))
    const { payload } = await preview(routes[1], { sessionIds: [ID3, ID, ID2] }, SAME_ORIGIN)
    expect(payload.results?.map(impact => impact.id)).toEqual([ID3, ID, ID2])
    expect(payload.totalBytes).toBe(400)
  })

  it('reports a session with no stored log as nothing to remove', async () => {
    const deleted: string[] = []
    const { routes } = await opened(previewCapableHost({}, deleted))
    const { status, payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(payload.results?.[0]).toMatchObject({ id: ID, exists: false, deletable: false, blockedReason: 'log-not-found' })
  })

  it('reports a malformed id as invalid instead of failing the whole request', async () => {
    const deleted: string[] = []
    const { routes } = await opened(previewCapableHost({ [ID2]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 10 } }, deleted))
    const { status, payload } = await preview(routes[1], { sessionIds: ['not-a-uuid', ID2] }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(payload.results?.[0]).toMatchObject({ id: 'not-a-uuid', deletable: false, blockedReason: 'invalid-session-id' })
    expect(payload.results?.[1]).toMatchObject({ id: ID2, deletable: true })
  })

  it('reports a live agent the host cannot dispose as blocked', async () => {
    const deleted: string[] = []
    const { routes } = await opened(previewCapableHost(
      { [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 10 } },
      deleted,
      { agents: { get: () => ({}), list: () => [] } },
    ))
    const { payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(payload.results?.[0]).toMatchObject({ liveAgent: true, deletable: false, blockedReason: 'session-live' })
  })

  it('reports a live agent as deletable when the host can dispose it first', async () => {
    const deleted: string[] = []
    const { routes } = await opened(previewCapableHost(
      { [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 10 } },
      deleted,
      { agents: { get: () => ({}), list: () => [] }, sessionController: { closeSession: async () => {} } },
    ))
    const { payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(payload.results?.[0]).toMatchObject({ liveAgent: true, deletable: true, blockedReason: '' })
  })

  it('refuses a foreign origin', async () => {
    const deleted: string[] = []
    const { routes } = await opened(previewCapableHost({ [ID]: { createdAt: FIVE_DAYS_AGO } }, deleted))
    const { status, payload } = await preview(routes[1], { sessionId: ID }, {
      host: '127.0.0.1:13080',
      origin: 'http://evil.example',
    })
    expect(status).toBe(403)
    expect(payload.error).toBe('cross-origin-request-rejected')
    expect(deleted).toEqual([])
  })

  it('refuses an unparsable origin', async () => {
    const { routes } = await opened(previewCapableHost({}, []))
    const { status, payload } = await preview(routes[1], { sessionId: ID }, { host: '127.0.0.1:13080', origin: 'not a url' })
    expect(status).toBe(403)
    expect(payload.error).toBe('invalid-origin')
  })

  it('requires a JSON content type', async () => {
    const { routes } = await opened(previewCapableHost({}, []))
    const response = await routes[1].fetch(new Request(new URL(PREVIEW_PATH, 'http://dsh.internal'), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    }))
    expect(response.status).toBe(415)
    expect((await response.json() as PreviewPayload).error).toBe('application/json-required')
  })

  it('rejects malformed JSON', async () => {
    const { routes } = await opened(previewCapableHost({}, []))
    const { status, payload } = await preview(routes[1], '{not json', SAME_ORIGIN)
    expect(status).toBe(400)
    expect(payload.error).toBe('invalid-json')
  })

  it('requires a session id in one of the two shapes', async () => {
    const { routes } = await opened(previewCapableHost({}, []))
    const { status, payload } = await preview(routes[1], {}, SAME_ORIGIN)
    expect(status).toBe(400)
    expect(payload.error).toBe('sessionId-or-sessionIds-required')
  })

  it('answers 501 when the host cannot report stored-session metadata', async () => {
    const { routes } = await opened({
      agents: { get: () => undefined, list: () => [] },
      sessions: { get: () => undefined, list: () => [], flush: async () => true },
      sessionPersistence: { delete: async () => {}, listSync: () => [] },
    })
    const { status, payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(status).toBe(501)
    expect(payload.error).toContain('runtime-capability-missing')
  })
})
