import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

const ID_OLD = '2de8b71d-bd3b-4f4d-8d1d-5dceac76f934'
const ID_MID = '8f14e45f-ceea-467a-9f1b-2c3d4e5f6a7b'
const ID_NEW = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e'

const POLICY_PREVIEW_PATH = '/api/session-purge/policy/preview'
const POLICY_APPLY_PATH = '/api/session-purge/policy/apply'

const DAY = 86_400_000
const NOW = Date.now()

type RegisteredRoute = {
  path: string
  methods: readonly string[]
  fetch: (request: Request) => Promise<Response>
}

interface Mutations {
  [primitive: string]: string[]
}

interface StoredSession {
  createdAt: number
  sizeBytes?: number
}

function browserRequest(path: string, body: unknown, headers: Record<string, string>): Request {
  return new Request(new URL(path, 'http://dsh.internal'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

interface Harness {
  routes: RegisteredRoute[]
  dispose(): Promise<void>
}

async function install(services?: Record<string, object>): Promise<Harness> {
  const routes: RegisteredRoute[] = []
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
    dispose: async () => {
      await plugin.dispose()
      await host.dispose()
    },
  }
}

interface HostOptions {
  readonly stored?: Record<string, StoredSession>
  readonly live?: readonly string[]
  /** Sessions the host still holds open, so flush and detach are reached. */
  readonly attached?: readonly string[]
  readonly withoutList?: boolean
  readonly withoutStat?: boolean
}

/**
 * A host that can list its stored sessions, report their metadata and remove
 * them. Every mutating primitive is recorded, so a test can prove the policy
 * preview touched none of them.
 */
function policyCapableHost(options: HostOptions = {}): { services: Record<string, object>; mutations: Mutations } {
  const mutations: Mutations = {}
  const record = (primitive: string, id: string) => {
    ;(mutations[primitive] ??= []).push(id)
  }
  // The store is mutable: a real delete removes the log, and the purge verifies
  // the absence afterwards.
  const stored: Record<string, StoredSession> = { ...(options.stored ?? {}) }
  const live = new Set(options.live ?? [])
  const attached = new Set(options.attached ?? [])
  const persistence: Record<string, unknown> = {
    delete: async (id: string) => {
      record('sessionPersistence.delete', id)
      delete stored[id]
    },
    listSync: () => [] as readonly { id?: string }[],
  }
  if (!options.withoutList) {
    persistence.list = async () => Object.entries(stored).map(([id, entry]) => ({
      header: { id, createdAt: entry.createdAt },
      revision: 'rev-1',
      ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
    }))
  }
  if (!options.withoutStat) {
    persistence.stat = async (id: string) => {
      const entry = stored[id]
      if (!entry) return undefined
      return {
        header: { id, createdAt: entry.createdAt },
        revision: 'rev-1',
        ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
      }
    }
  }
  const services: Record<string, object> = {
    // A live agent leaves the registry when it is stopped, exactly as the
    // purge's postcondition expects.
    agents: {
      get: (id: string) => (live.has(id)
        ? { stop: async () => { record('agents.stop', id); live.delete(id) } }
        : undefined),
      list: () => [],
    },
    sessions: {
      get: (id: string) => (attached.has(id) ? { id } : undefined),
      list: () => [],
      flush: async (session: unknown) => { record('sessions.flush', String((session as { id?: string })?.id ?? '')) },
      detach: async (id: string) => { record('sessions.detach', id); attached.delete(id) },
    },
    sessionPersistence: persistence,
    sessionProjectionCache: { purge: async (id: string) => { record('sessionProjectionCache.purge', id); return true } },
    workspaceRegistry: { releaseSession: async (id: string) => { record('workspaceRegistry.releaseSession', id) } },
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

async function call(route: RegisteredRoute, body: unknown, headers: Record<string, string> = {}) {
  const response = await route.fetch(browserRequest(route.path, body, headers))
  return { status: response.status, payload: await response.json() as Record<string, unknown> }
}

const SAME_ORIGIN = { host: '127.0.0.1:13080', origin: 'http://127.0.0.1:13080' }

const THREE_SESSIONS = {
  [ID_OLD]: { createdAt: NOW - 31 * DAY, sizeBytes: 300 },
  [ID_MID]: { createdAt: NOW - 30 * DAY, sizeBytes: 300 },
  [ID_NEW]: { createdAt: NOW - 1 * DAY, sizeBytes: 300 },
}

describe('the policy routes', () => {
  it('registers both policy routes for POST only', async () => {
    const { routes } = await opened(policyCapableHost().services)
    expect(routes.map(route => route.path)).toEqual([
      '/api/session-purge/delete',
      '/api/session-purge/preview',
      POLICY_PREVIEW_PATH,
      POLICY_APPLY_PATH,
    ])
    expect([...routes[2].methods]).toEqual(['POST'])
    expect([...routes[3].methods]).toEqual(['POST'])
  })

  it('refuses a foreign origin on both routes', async () => {
    const { routes } = await opened(policyCapableHost().services)
    const foreign = { host: '127.0.0.1:13080', origin: 'http://evil.example' }
    const preview = await call(routes[2], { policy: { maxAgeDays: 30 } }, foreign)
    expect(preview.status).toBe(403)
    expect(preview.payload.error).toBe('cross-origin-request-rejected')
    const apply = await call(routes[3], { policy: { maxAgeDays: 30 }, confirm: true }, foreign)
    expect(apply.status).toBe(403)
  })

  it('requires a JSON content type', async () => {
    const { routes } = await opened(policyCapableHost().services)
    const response = await routes[2].fetch(new Request(new URL(POLICY_PREVIEW_PATH, 'http://dsh.internal'), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    }))
    expect(response.status).toBe(415)
  })

  it('rejects malformed JSON', async () => {
    const { routes } = await opened(policyCapableHost().services)
    const { status, payload } = await call(routes[2], '{not json', SAME_ORIGIN)
    expect(status).toBe(400)
    expect(payload.error).toBe('invalid-json')
  })
})

describe('POST /api/session-purge/policy/preview', () => {
  it('names the sessions the policy would remove and totals their bytes', async () => {
    const { routes } = await opened(policyCapableHost({ stored: THREE_SESSIONS }).services)
    const { status, payload } = await call(routes[2], { policy: { maxAgeDays: 30 } }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(payload.totalSessions).toBe(3)
    expect(payload.selectedCount).toBe(1)
    expect(payload.keptCount).toBe(2)
    expect(payload.bytesToFree).toBe(300)
    const selected = payload.selected as { id: string; ageDays: number }[]
    expect(selected.map(item => item.id)).toEqual([ID_OLD])
    expect(selected[0]?.ageDays).toBe(31)
  })

  it('touches no mutating primitive', async () => {
    // The host holds one session open with a live agent, so a preview that
    // reached into the cleanup pipeline would record a stop, a flush and a
    // detach. Every primitive is recorded, not only the delete.
    const { services, mutations } = policyCapableHost({
      stored: THREE_SESSIONS,
      live: [ID_OLD],
      attached: [ID_OLD],
    })
    const { routes } = await opened(services)
    const { status } = await call(routes[2], { policy: { maxAgeDays: 1 } }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(mutations).toEqual({})
  })

  it('never names the excluded session', async () => {
    const { routes } = await opened(policyCapableHost({ stored: THREE_SESSIONS }).services)
    const { payload } = await call(routes[2], { policy: { maxAgeDays: 1 }, excludeSessionIds: [ID_NEW] }, SAME_ORIGIN)
    const selected = payload.selected as { id: string }[]
    expect(selected.map(item => item.id)).not.toContain(ID_NEW)
  })

  it('refuses a policy with no limit', async () => {
    const { routes } = await opened(policyCapableHost({ stored: THREE_SESSIONS }).services)
    const { status, payload } = await call(routes[2], { policy: {} }, SAME_ORIGIN)
    expect(status).toBe(400)
    expect(String(payload.error)).toContain('invalid-policy')
  })

  it('refuses a limit that is not a usable number', async () => {
    const { routes } = await opened(policyCapableHost({ stored: THREE_SESSIONS }).services)
    const { status, payload } = await call(routes[2], { policy: { maxAgeDays: -3 } }, SAME_ORIGIN)
    expect(status).toBe(400)
    expect(String(payload.error)).toContain('invalid-policy')
  })

  it('answers 501 when the host cannot list its stored sessions', async () => {
    const { routes } = await opened(policyCapableHost({ stored: THREE_SESSIONS, withoutList: true }).services)
    const { status, payload } = await call(routes[2], { policy: { maxAgeDays: 30 } }, SAME_ORIGIN)
    expect(status).toBe(501)
    expect(String(payload.error)).toContain('runtime-capability-missing')
  })
})

describe('POST /api/session-purge/policy/apply', () => {
  it('refuses to run without an explicit confirmation', async () => {
    const { services, mutations } = policyCapableHost({ stored: THREE_SESSIONS })
    const { routes } = await opened(services)
    const { status, payload } = await call(routes[3], { policy: { maxAgeDays: 30 } }, SAME_ORIGIN)
    expect(status).toBe(400)
    expect(payload.error).toBe('confirm-true-required')
    expect(mutations).toEqual({})
  })

  it('removes exactly the sessions the preview named', async () => {
    const { services, mutations } = policyCapableHost({ stored: THREE_SESSIONS })
    const { routes } = await opened(services)
    const preview = await call(routes[2], { policy: { maxAgeDays: 30 } }, SAME_ORIGIN)
    const selectedIds = (preview.payload.selected as { id: string }[]).map(item => item.id)

    const { status, payload } = await call(routes[3], { sessionIds: selectedIds, confirm: true }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(payload.total).toBe(1)
    expect(payload.succeeded).toBe(1)
    expect(payload.failed).toBe(0)
    expect(payload.blocked).toBe(0)
    expect(payload.bytesFreed).toBe(300)
    // The dry run and the run name the same session.
    expect(mutations['sessionPersistence.delete']).toEqual(selectedIds)
  })

  it('selects the same sessions when the host is asked to run the policy itself', async () => {
    const { services, mutations } = policyCapableHost({ stored: THREE_SESSIONS })
    const { routes } = await opened(services)
    const preview = await call(routes[2], { policy: { maxAgeDays: 30 } }, SAME_ORIGIN)
    const selectedIds = (preview.payload.selected as { id: string }[]).map(item => item.id)

    const { status, payload } = await call(routes[3], { policy: { maxAgeDays: 30 }, confirm: true }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(payload.total).toBe(selectedIds.length)
    expect(mutations['sessionPersistence.delete']).toEqual(selectedIds)
  })

  it('removes a session whose live agent the host is able to stop', async () => {
    const { services, mutations } = policyCapableHost({ stored: THREE_SESSIONS, live: [ID_OLD] })
    const { routes } = await opened(services)
    const { status, payload } = await call(routes[3], { sessionIds: [ID_OLD], confirm: true }, SAME_ORIGIN)
    // The host can stop that agent, so it is removable after all.
    expect(status).toBe(200)
    expect(mutations['sessionPersistence.delete']).toEqual([ID_OLD])
    expect(payload.blocked).toBe(0)
  })

  it('reports a session the host refuses to stop as blocked and leaves it alone', async () => {
    const { services, mutations } = policyCapableHost({ stored: THREE_SESSIONS })
    services.agents = { get: (id: string) => (id === ID_OLD ? {} : undefined), list: () => [] }
    const { routes } = await opened(services)
    const { status, payload } = await call(routes[3], { sessionIds: [ID_OLD], confirm: true }, SAME_ORIGIN)
    expect(status).toBe(409)
    expect(payload.ok).toBe(false)
    expect(payload.blocked).toBe(1)
    expect(payload.succeeded).toBe(0)
    const blocked = payload.blockedResults as { id: string; reason: string }[]
    expect(blocked[0]?.id).toBe(ID_OLD)
    expect(blocked[0]?.reason).toBe('session-live')
    expect(mutations['sessionPersistence.delete']).toBeUndefined()
  })

  it('removes the rest of the batch when one session is blocked', async () => {
    const { services, mutations } = policyCapableHost({ stored: THREE_SESSIONS })
    services.agents = { get: (id: string) => (id === ID_OLD ? {} : undefined), list: () => [] }
    const { routes } = await opened(services)
    const { status, payload } = await call(routes[3], { sessionIds: [ID_OLD, ID_MID], confirm: true }, SAME_ORIGIN)
    expect(status).toBe(409)
    expect(payload.succeeded).toBe(1)
    expect(payload.failed).toBe(0)
    expect(payload.blocked).toBe(1)
    expect(mutations['sessionPersistence.delete']).toEqual([ID_MID])
  })

  it('reports a session with no stored log as removed, because its removal is a no-op', async () => {
    const { services, mutations } = policyCapableHost({ stored: THREE_SESSIONS })
    const { routes } = await opened(services)
    const { status, payload } = await call(routes[3], { sessionIds: ['11111111-2222-4333-8444-555555555555'], confirm: true }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(payload.succeeded).toBe(1)
    expect(payload.bytesFreed).toBeNull()
    expect(mutations['sessionPersistence.delete']).toEqual(['11111111-2222-4333-8444-555555555555'])
  })

  it('refuses an empty id list', async () => {
    const { routes } = await opened(policyCapableHost({ stored: THREE_SESSIONS }).services)
    const empty = await call(routes[3], { sessionIds: [], confirm: true }, SAME_ORIGIN)
    expect(empty.status).toBe(400)
    expect(String(empty.payload.error)).toContain('sessionIds-must-be-1..500-strings')
  })

  it('refuses an id list longer than one run may remove', async () => {
    const { routes } = await opened(policyCapableHost({ stored: THREE_SESSIONS }).services)
    const tooMany = Array.from({ length: 501 }, (_unused, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`)
    const oversized = await call(routes[3], { sessionIds: tooMany, confirm: true }, SAME_ORIGIN)
    expect(oversized.status).toBe(400)
    expect(String(oversized.payload.error)).toContain('sessionIds-must-be-1..500-strings')
  })

  it('leaves an excluded session alone even when the request names it', async () => {
    const { services, mutations } = policyCapableHost({ stored: THREE_SESSIONS })
    const { routes } = await opened(services)
    const { status, payload } = await call(routes[3], {
      sessionIds: [ID_OLD, ID_MID],
      excludeSessionIds: [ID_OLD],
      confirm: true,
    }, SAME_ORIGIN)
    expect(status).toBe(200)
    // The exclusion is honoured on the explicit-ids path too.
    expect(mutations['sessionPersistence.delete']).toEqual([ID_MID])
    expect(payload.excluded).toBe(1)
    expect(payload.total).toBe(1)
  })

  it('reports a policy that selects nothing as a successful no-op', async () => {
    const { services, mutations } = policyCapableHost({ stored: THREE_SESSIONS })
    const { routes } = await opened(services)
    // Every stored session is inside a 3650-day limit, so nothing is selected.
    const { status, payload } = await call(routes[3], { policy: { maxAgeDays: 3650 }, confirm: true }, SAME_ORIGIN)
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(payload.total).toBe(0)
    expect(payload.succeeded).toBe(0)
    expect(payload.blocked).toBe(0)
    expect(mutations).toEqual({})
  })

  it('counts the bytes of a session whose log is gone even when its cleanup failed', async () => {
    const { services } = policyCapableHost({ stored: THREE_SESSIONS })
    // The log is deleted and verified; the derived cleanup then fails.
    services.sessionProjectionCache = { purge: async () => { throw new Error('the cache is down') } }
    const { routes } = await opened(services)
    const { status, payload } = await call(routes[3], { sessionIds: [ID_OLD], confirm: true }, SAME_ORIGIN)
    expect(status).toBe(500)
    expect(payload.failed).toBe(1)
    expect(payload.ok).toBe(false)
    // The log is what held the bytes, and it is gone: the space was freed even
    // though the cleanup after it failed.
    expect(payload.bytesFreed).toBe(300)
  })

  it('answers 501 when the host cannot report stored-session metadata', async () => {
    const { services } = policyCapableHost({ stored: THREE_SESSIONS, withoutStat: true })
    const { routes } = await opened(services)
    const { status, payload } = await call(routes[3], { sessionIds: [ID_OLD], confirm: true }, SAME_ORIGIN)
    expect(status).toBe(501)
    expect(String(payload.error)).toContain('runtime-capability-missing')
  })
})
