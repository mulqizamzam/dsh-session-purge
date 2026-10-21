import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

const ID = '2de8b71d-bd3b-4f4d-8d1d-5dceac76f934'
const ID2 = '8f14e45f-ceea-467a-9f1b-2c3d4e5f6a7b'
const ID3 = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e'
const PREVIEW_PATH = '/api/session-purge/preview'
const POLICY_PREVIEW_PATH = '/api/session-purge/policy/preview'
const POLICY_APPLY_PATH = '/api/session-purge/policy/apply'
const DELETE_PATH = '/api/session-purge/delete'

// The route ages the stored session against the real clock, so the fixture is
// built from the real clock too.
const NOW = Date.now()
const FIVE_DAYS_AGO = NOW - 5 * 86_400_000
const ODD_AGE_AGO = NOW - Math.round(5.37 * 86_400_000)

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
  liveAgent: 'idle' | 'live' | 'unknown'
  attached: boolean
  deletable: boolean
  blockedReason: string
}

interface PreviewPayload {
  ok?: boolean
  error?: string
  results?: Impact[]
  totalBytes?: number | null
}

/** Every mutating primitive the purge pipeline uses, recorded by name. */
interface Mutations {
  readonly [primitive: string]: string[]
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
  mutations: Mutations
  dispose(): Promise<void>
}

/**
 * A REAL cordis topology, like the delete route's suite: the plugin captures the
 * optional host services through `ctx.inject`, so the services must exist on a
 * real Context before the plugin loads.
 */
async function install(services?: Record<string, object>): Promise<Harness> {
  const routes: RegisteredRoute[] = []
  const mutations: Record<string, string[]> = {}
  const record = (primitive: string, id: string) => {
    (mutations[primitive] ??= []).push(id)
  }
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
    mutations,
    dispose: async () => {
      await plugin.dispose()
      await host.dispose()
    },
  }
}

interface HostOptions {
  readonly snapshots?: Record<string, { createdAt: number; sizeBytes?: number }>
  readonly agents?: object
  readonly statThrows?: readonly string[]
  readonly withoutAgentRegistry?: boolean
}

/**
 * A host that can report stored-session metadata. Every mutating primitive the
 * purge pipeline uses is recorded, so a test can prove that a preview touched
 * none of them — not only `delete`.
 */
function previewCapableHost(options: HostOptions = {}): { services: Record<string, object>; mutations: Mutations } {
  const mutations: Record<string, string[]> = {}
  const record = (primitive: string, id: string) => {
    (mutations[primitive] ??= []).push(id)
  }
  const snapshots = options.snapshots ?? {}
  const statThrows = options.statThrows ?? []
  const services: Record<string, object> = {
    sessions: {
      get: () => undefined,
      list: () => [],
      flush: async (session: unknown) => { record('sessions.flush', String(session)) },
    },
    sessionPersistence: {
      delete: async (id: string) => { record('sessionPersistence.delete', id) },
      stat: async (id: string) => {
        if (statThrows.includes(id)) throw new Error(`corrupt log for ${id}`)
        const entry = snapshots[id]
        if (!entry) return undefined
        return { header: { id, createdAt: entry.createdAt }, revision: 'rev-1', sizeBytes: entry.sizeBytes }
      },
      listSync: () => [] as readonly { id?: string }[],
    },
    sessionProjectionCache: { purge: async (id: string) => { record('sessionProjectionCache.purge', id); return true } },
    workspaceRegistry: { releaseSession: async (id: string) => { record('workspaceRegistry.releaseSession', id) } },
  }
  if (!options.withoutAgentRegistry) {
    services.agents = options.agents ?? { get: () => undefined, list: () => [] }
  }
  return { services, mutations }
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
    const { routes } = await opened(previewCapableHost().services)
    expect(routes.map(route => route.path)).toEqual([DELETE_PATH, PREVIEW_PATH, POLICY_PREVIEW_PATH, POLICY_APPLY_PATH])
    expect([...routes[1].methods]).toEqual(['POST'])
  })

  it('reports the stored size and age of a session', async () => {
    const { services } = previewCapableHost({ snapshots: { [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 4096 } } })
    const { routes } = await opened(services)
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
    expect(payload.totalBytes).toBe(4096)
  })

  it('rounds the age to one decimal', async () => {
    const { services } = previewCapableHost({ snapshots: { [ID]: { createdAt: ODD_AGE_AGO, sizeBytes: 10 } } })
    const { routes } = await opened(services)
    const { payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(payload.results?.[0]?.ageDays).toBe(5.4)
  })

  // The whole point of the route: it observes without touching anything.
  it('touches no mutating primitive, not even for a batch of deletable sessions', async () => {
    const { services, mutations } = previewCapableHost({
      snapshots: {
        [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 100 },
        [ID2]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 200 },
      },
    })
    const { routes } = await opened(services)
    const { status } = await preview(routes[1], { sessionIds: [ID, ID2] }, SAME_ORIGIN)
    expect(status).toBe(200)
    // Every primitive the purge pipeline uses, not only `delete`.
    expect(mutations).toEqual({})
  })

  it('previews a batch in request order and totals the stored bytes', async () => {
    const { services } = previewCapableHost({
      snapshots: {
        [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 100 },
        [ID2]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 250 },
        [ID3]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 50 },
      },
    })
    const { routes } = await opened(services)
    const { payload } = await preview(routes[1], { sessionIds: [ID3, ID, ID2] }, SAME_ORIGIN)
    expect(payload.results?.map(impact => impact.id)).toEqual([ID3, ID, ID2])
    expect(payload.totalBytes).toBe(400)
  })

  it('reports an unknown total as null, not as zero bytes', async () => {
    const { services } = previewCapableHost({ snapshots: { [ID]: { createdAt: FIVE_DAYS_AGO } } })
    const { routes } = await opened(services)
    const { payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(payload.totalBytes).toBeNull()
  })

  it('reports a session with no stored log as nothing to remove', async () => {
    const { services } = previewCapableHost()
    const { routes } = await opened(services)
    const { status, payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(status).toBe(200)
    // No log is not a blocker: deleting an absent log is a successful no-op.
    expect(payload.results?.[0]).toMatchObject({ id: ID, exists: false, deletable: false, blockedReason: '' })
  })

  it('reports a malformed id as invalid instead of failing the whole request', async () => {
    const { services } = previewCapableHost({ snapshots: { [ID2]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 10 } } })
    const { routes } = await opened(services)
    const { status, payload } = await preview(routes[1], { sessionIds: ['not-a-uuid', ID2] }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(payload.results?.[0]).toMatchObject({ id: 'not-a-uuid', deletable: false, blockedReason: 'invalid-session-id' })
    expect(payload.results?.[1]).toMatchObject({ id: ID2, deletable: true })
  })

  it('isolates one unreadable log instead of failing the whole batch', async () => {
    const { services } = previewCapableHost({
      snapshots: { [ID2]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 20 } },
      statThrows: [ID],
    })
    const { routes } = await opened(services)
    const { status, payload } = await preview(routes[1], { sessionIds: [ID, ID2] }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(payload.results?.[0]).toMatchObject({ id: ID, blockedReason: 'stat-failed', deletable: false })
    expect(payload.results?.[1]).toMatchObject({ id: ID2, blockedReason: '', deletable: true })
  })

  it('reports a live agent the host cannot stop as blocked', async () => {
    const { services } = previewCapableHost({
      snapshots: { [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 10 } },
      agents: { get: () => ({}), list: () => [] },
    })
    const { routes } = await opened(services)
    const { payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(payload.results?.[0]).toMatchObject({ liveAgent: 'live', deletable: false, blockedReason: 'session-live' })
  })

  it('reports a live agent as deletable when the host can dispose it first', async () => {
    const { services } = previewCapableHost({
      snapshots: { [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 10 } },
      agents: { get: () => ({}), list: () => [] },
    })
    services.sessionController = { closeSession: async () => {} }
    const { routes } = await opened(services)
    const { payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(payload.results?.[0]).toMatchObject({ liveAgent: 'live', deletable: true, blockedReason: '' })
  })

  it('reports a live agent as deletable when the agent itself can be stopped', async () => {
    const { services } = previewCapableHost({
      snapshots: { [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 10 } },
      agents: { get: () => ({ stop: async () => {} }), list: () => [] },
    })
    const { routes } = await opened(services)
    const { payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    // The purge's second success path: it stops the agent itself.
    expect(payload.results?.[0]).toMatchObject({ liveAgent: 'live', deletable: true, blockedReason: '' })
  })

  // The preview must not be the optimistic path of a fail-closed plugin: on a
  // host without the agent registry the delete answers 501, so the preview may
  // not call that "deletable".
  it('agrees with the delete route about a host with no agent registry', async () => {
    const { services } = previewCapableHost({
      snapshots: { [ID]: { createdAt: FIVE_DAYS_AGO, sizeBytes: 10 } },
      withoutAgentRegistry: true,
    })
    const { routes } = await opened(services)
    const { payload } = await preview(routes[1], { sessionId: ID }, SAME_ORIGIN)
    expect(payload.results?.[0]).toMatchObject({ liveAgent: 'unknown', deletable: false, blockedReason: 'agent-registry-unavailable' })
    const deletion = await routes[0].fetch(browserRequest(DELETE_PATH, { sessionId: ID, confirm: true }, SAME_ORIGIN))
    expect(deletion.status).toBe(501)
  })

  it('refuses a foreign origin', async () => {
    const { services, mutations } = previewCapableHost({ snapshots: { [ID]: { createdAt: FIVE_DAYS_AGO } } })
    const { routes } = await opened(services)
    const { status, payload } = await preview(routes[1], { sessionId: ID }, {
      host: '127.0.0.1:13080',
      origin: 'http://evil.example',
    })
    expect(status).toBe(403)
    expect(payload.error).toBe('cross-origin-request-rejected')
    expect(mutations).toEqual({})
  })

  it('refuses an unparsable origin', async () => {
    const { routes } = await opened(previewCapableHost().services)
    const { status, payload } = await preview(routes[1], { sessionId: ID }, { host: '127.0.0.1:13080', origin: 'not a url' })
    expect(status).toBe(403)
    expect(payload.error).toBe('invalid-origin')
  })

  it('requires a JSON content type', async () => {
    const { routes } = await opened(previewCapableHost().services)
    const response = await routes[1].fetch(new Request(new URL(PREVIEW_PATH, 'http://dsh.internal'), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    }))
    expect(response.status).toBe(415)
    expect((await response.json() as PreviewPayload).error).toBe('application/json-required')
  })

  it('rejects malformed JSON', async () => {
    const { routes } = await opened(previewCapableHost().services)
    const { status, payload } = await preview(routes[1], '{not json', SAME_ORIGIN)
    expect(status).toBe(400)
    expect(payload.error).toBe('invalid-json')
  })

  it('requires a session id in one of the two shapes', async () => {
    const { routes } = await opened(previewCapableHost().services)
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
