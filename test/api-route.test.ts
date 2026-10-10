import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

const ID = '2de8b71d-bd3b-4f4d-8d1d-5dceac76f934'
const PATH = '/api/session-purge/delete'

type RegisteredRoute = {
  path: string
  methods: readonly string[]
  fetch: (request: Request) => Promise<Response>
}

/**
 * How the host actually reaches a registered Fetch route. /api is mounted behind
 * `connection.admit()` (Host + Origin fence, then browser auth) and the node:http
 * request is bridged by packages/client/connection/src/http-bridge.ts, which
 * rebuilds the URL against the synthetic base `http://dsh.internal`
 * (`new URL(req.url ?? '/', 'http://dsh.internal')`). `request.url` therefore
 * never carries this deployment's authority; the Host header does, because the
 * browser fills it from the URL it believes it is talking to. Mirror that shape
 * here instead of hand-building a convenient one.
 */
function bridgeUrl(path = PATH): URL {
  return new URL(path, 'http://dsh.internal')
}

/** Browser-shaped POST the way the bridge delivers it, including the Host header node:http always sets. */
function browserRequest(body: unknown, headers: Record<string, string>): Request {
  return new Request(bridgeUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/**
 * The host services as this host actually exposes them, measured against the
 * harness source (packages/session/session-persistence-jsonl: create/open/
 * flush/stat/list only; packages/core/session SessionStore: get/list/
 * flush(Session); packages/core/agent AgentRegistry: get/list). None of them
 * carry the deletion primitives the scaffold's capability layer documents, so a
 * request against these shapes must fail closed with
 * `runtime-capability-missing`, never with `unexpected-error`.
 */
function hostShapes(): Record<string, object> {
  return {
    agents: { get: () => undefined, list: () => [] },
    sessions: { get: () => undefined, list: () => [], flush: async () => true },
    sessionPersistence: {
      create: async () => ({}),
      open: async () => ({}),
      flush: async () => {},
      stat: async () => undefined,
      list: async () => [],
    },
    sessionProjectionCache: { write: async () => {} },
    workspaceRegistry: { list: () => [], archivedSessionIds: [], pinnedSessionIds: [] },
  }
}

interface Harness {
  routes: RegisteredRoute[]
  deleted: string[]
  logs: string[]
  dispose(): Promise<void>
}

/**
 * A REAL cordis topology, not a plain-object fixture. The bug this suite locks
 * out only exists against a real Context proxy: reading a service the plugin
 * did not inject throws a plain `Error('cannot get property "<name>" without
 * inject')`, which the old fixture could never produce because its property
 * reads simply worked. The host fiber provides `tools`/`connection` plus the
 * given optional services; the plugin fiber then loads `apply` exactly the way
 * the host loads plugins. `ctx.inject` captures fire synchronously during
 * `apply` when the service already exists (measured), so requests issued after
 * this helper resolves see a fully captured resolver.
 */
async function install(services?: Record<string, object>): Promise<Harness> {
  const routes: RegisteredRoute[] = []
  const deleted: string[] = []
  const logs: string[] = []
  const root = new Context()
  const logger = root.logger as unknown as { error: (...args: unknown[]) => void }
  const originalError = logger.error.bind(root.logger)
  logger.error = (...args: unknown[]) => {
    logs.push(args.map(arg => (typeof arg === 'string' ? arg : String(arg))).join(' '))
  }
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
  const plugin = root.plugin({
    name: 'session-purge',
    inject: ['tools', 'connection'],
    apply,
  })
  await plugin
  return {
    routes,
    deleted,
    logs,
    dispose: async () => {
      logger.error = originalError
      // The root Context exposes no dispose on this cordis version; the fibers do.
      await plugin.dispose()
      await host.dispose()
    },
  }
}

/** Success-capable persistence: the host primitive this scaffold documents. */
function deleteCapablePersistence(deleted: string[], deleteCalls?: { id: string; options?: { signal?: AbortSignal } }[]): Record<string, object> {
  return {
    agents: { get: () => undefined, list: () => [] },
    sessions: { get: () => undefined, list: () => [], flush: async () => true },
    sessionPersistence: {
      delete: async (id: string, options?: { signal?: AbortSignal }) => {
        deleted.push(id)
        deleteCalls?.push({ id, options })
      },
      // The real host's mechanical absence check (SessionPersistence.stat).
      stat: async () => undefined,
      listSync: () => [] as readonly { id?: string }[],
    },
    sessionProjectionCache: { purge: async () => true },
    workspaceRegistry: { releaseSession: async () => {} },
  }
}

async function post(route: RegisteredRoute, body: unknown, headers: Record<string, string>) {
  const response = await route.fetch(browserRequest(body, headers))
  return { status: response.status, payload: await response.json() as { ok?: boolean; error?: string; stage?: string } }
}

let active: Harness[] = []

afterEach(async () => {
  for (const harness of active) await harness.dispose()
  active = []
})

async function opened(services?: Record<string, object>): Promise<Harness> {
  const harness = await install(services)
  active.push(harness)
  return harness
}

describe('POST /api/session-purge/delete origin gate', () => {
  it('registers the delete route for POST only', async () => {
    const { routes } = await opened(deleteCapablePersistence([]))
    expect(routes.map(route => route.path)).toEqual([PATH])
    expect([...routes[0].methods]).toEqual(['POST'])
  })

  // Regression: the GUI's own POST carried Origin for the page it was served from
  // and was answered 403 cross-origin-request-rejected, so deletion was unusable
  // from the browser while the identical request without Origin succeeded.
  it('admits a same-origin browser POST and completes the purge', async () => {
    const deleted: string[] = []
    const deleteCalls: { id: string; options?: { signal?: AbortSignal } }[] = []
    const { routes } = await opened(deleteCapablePersistence(deleted, deleteCalls))
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(deleted).toEqual([ID])
    // The host delete() takes an options object carrying the request signal,
    // matching the SessionPersistence method style; a positional signal threw
    // the argument away.
    expect(deleteCalls).toEqual([{ id: ID, options: expect.any(Object) }])
  })

  it('admits a request with no Origin header (non-browser clients reach the host fence instead)', async () => {
    const deleted: string[] = []
    const { routes } = await opened(deleteCapablePersistence(deleted))
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, { host: '127.0.0.1:13080' })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(deleted).toEqual([ID])
  })

  it('matches authorities through URL normalization, not raw strings', async () => {
    // Case and a redundant default port must not decide the verdict: the host's own
    // fence normalizes both sides through WHATWG, and a browser may spell the page
    // authority differently from the Host header it dialed.
    for (const [host, origin] of [
      ['localhost', 'http://localhost'],
      ['Example.COM', 'http://example.com'],
      ['example.com:80', 'http://example.com'],
    ] as const) {
      const { routes } = await opened(deleteCapablePersistence([]))
      const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, { host, origin })
      expect({ host, origin, status }).toEqual({ host, origin, status: 200 })
      expect(payload.ok).toBe(true)
    }
  })

  it('ignores the scheme, matching the host fence for TLS-terminating proxies', async () => {
    // Behind a TLS-terminating proxy the page origin is `https:` while the Host
    // header it forwards carries no scheme at all. The host's own /api fence
    // compares hosts only (api-request-trust.ts) and admits this pair, so a
    // stricter comparison here would break that legitimate deployment.
    const { routes } = await opened(deleteCapablePersistence([]))
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: 'dsg.example.com',
      origin: 'https://dsg.example.com',
    })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
  })

  it('rejects a foreign origin and deletes nothing', async () => {
    const deleted: string[] = []
    const { routes } = await opened(deleteCapablePersistence(deleted))
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://evil.example',
    })
    expect(status).toBe(403)
    expect(payload.error).toBe('cross-origin-request-rejected')
    expect(deleted).toEqual([])
  })

  it('rejects the same hostname on a different port', async () => {
    const { routes } = await opened(deleteCapablePersistence([]))
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:9999',
    })
    expect(status).toBe(403)
    expect(payload.error).toBe('cross-origin-request-rejected')
  })

  it('rejects an unparsable origin', async () => {
    const { routes } = await opened(deleteCapablePersistence([]))
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'not-a-url',
    })
    expect(status).toBe(403)
    expect(payload.error).toBe('invalid-origin')
  })

  it('fails closed when the Host header is missing', async () => {
    const { routes } = await opened(deleteCapablePersistence([]))
    const request = new Request(bridgeUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:13080' },
      body: JSON.stringify({ sessionId: ID, confirm: true }),
    })
    // Prove the fixture really is Host-less: a Request built without one stays
    // without one (the Host header only goes on the wire at fetch time), so this
    // exercises the guard's absent-authority branch and not an implicit default.
    expect(request.headers.get('host')).toBeNull()
    const response = await routes[0].fetch(request)
    expect(response.status).toBe(403)
  })

  it('still reaches the confirm gate behind the origin gate', async () => {
    const { routes } = await opened(deleteCapablePersistence([]))
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: false }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    expect(status).toBe(400)
    expect(payload.error).toBe('sessionId-and-confirm-true-required')
  })
})

describe('host capability detection on a real cordis context', () => {
  // The reported failure: every browser delete answered
  // `unexpected-error: operation failed; inspect host logs for details.`
  // because the adapter read host services it never injected, and cordis
  // throws a plain Error for those reads. The capability layer must answer
  // with its own diagnostic instead, and never that opaque string.
  it('fails closed with runtime-capability-missing when the host has no delete primitive', async () => {
    const { routes, deleted, logs } = await opened(hostShapes())
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    expect(status).toBe(501)
    expect(payload.ok).toBe(false)
    expect(payload.stage).toBe('delete-log')
    expect(payload.error).toContain('runtime-capability-missing')
    expect(payload.error).toContain('sessionPersistence.delete')
    expect(payload.error).not.toContain('unexpected-error')
    expect(deleted).toEqual([])
    expect(logs).toEqual([])
  })

  it('fails closed with runtime-capability-missing when the host provides no optional services at all', async () => {
    const { routes, logs } = await opened()
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    expect(status).toBe(501)
    expect(payload.stage).toBe('stop-agent')
    expect(payload.error).toContain('agents registry is unavailable')
    expect(payload.error).not.toContain('unexpected-error')
    expect(logs).toEqual([])
  })

  it('answers with the sanitized message but writes the raw cause to the host log', async () => {
    const deleted: string[] = []
    const services = deleteCapablePersistence(deleted)
    ;(services.sessionPersistence as { delete: (id: string) => Promise<void> }).delete = async () => {
      throw new Error('jsonl artifact locked by another process')
    }
    const { routes, logs } = await opened(services)
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    expect(status).toBe(500)
    expect(payload.error).toBe('unexpected-error: operation failed; inspect host logs for details.')
    // The public advice is only honest if the raw cause really reached the log.
    expect(logs.some(line => line.includes('session-purge: unexpected failure at delete-log'))).toBe(true)
    expect(logs.some(line => line.includes('jsonl artifact locked by another process'))).toBe(true)
    expect(deleted).toEqual([])
  })
})

describe('host API shapes the adapter must call correctly', () => {
  // The host's SessionStore.flush takes the Session object, not the id. Passing
  // the id string made the host dereference a string and throw a TypeError,
  // which the sanitizer flattened into `unexpected-error` for every live session.
  it('passes the live Session object to sessions.flush, not the id string', async () => {
    const deleted: string[] = []
    const liveSession = { header: { id: ID }, append: async () => ({}) }
    const flushCalls: unknown[] = []
    const services = deleteCapablePersistence(deleted)
    services.sessions = {
      get: (id: string) => (id === ID ? liveSession : undefined),
      list: () => [],
      flush: async (session: unknown) => { flushCalls.push(session); return true },
    }
    const { routes } = await opened(services)
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    // Flush runs before detach; the request then fails closed at detach because
    // this host exposes no sessions.detach for attached sessions.
    expect(flushCalls).toEqual([liveSession])
    expect(status).toBe(501)
    expect(payload.stage).toBe('detach-session')
    expect(payload.error).toContain('sessions.detach')
    expect(deleted).toEqual([])
  })

  // Absence must be observed through stat(), not inferred from delete()
  // resolving: a provider that answers delete() while the artifact survives
  // must stop the purge before cache and ledger cleanup.
  it('refuses to report success when stat still observes the log after delete', async () => {
    const deleted: string[] = []
    const cachePurged: string[] = []
    const ledgerReleased: string[] = []
    const services = deleteCapablePersistence(deleted)
    ;(services.sessionPersistence as { stat: (id: string) => Promise<unknown> }).stat = async () => ({ header: { id: ID } })
    ;(services.sessionProjectionCache as { purge: (id: string) => Promise<boolean> }).purge = async (id: string) => { cachePurged.push(id); return true }
    ;(services.workspaceRegistry as { releaseSession: (id: string) => Promise<void> }).releaseSession = async (id: string) => { ledgerReleased.push(id) }
    const { routes } = await opened(services)
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    expect(status).toBe(500)
    expect(payload.stage).toBe('verify-log')
    expect(payload.error).toContain('log-not-absent')
    expect(deleted).toEqual([ID])
    expect(cachePurged).toEqual([])
    expect(ledgerReleased).toEqual([])
  })
})

describe('the stored id form reaches persistence unchanged', () => {
  /**
   * Persistence that keys one artifact by the EXACT id, like the JSONL
   * backend's `sessionDir(root, cwd, id)`: `stat` resolves only the stored
   * form, so an id rewritten on the way in looks like an absent session.
   */
  function exactKeyPersistence(artifacts: Set<string>, deleted: string[]): Record<string, object> {
    return {
      agents: { get: () => undefined, list: () => [] },
      sessions: { get: () => undefined, list: () => [], flush: async () => true },
      sessionPersistence: {
        delete: async (id: string) => { deleted.push(id); artifacts.delete(id) },
        stat: async (id: string) => (artifacts.has(id) ? { header: { id } } : undefined),
        listSync: () => [] as readonly { id?: string }[],
      },
      sessionProjectionCache: { purge: async () => true },
      workspaceRegistry: { releaseSession: async () => {} },
    }
  }

  // Regression: normalizeSessionId() stripped the `session-` prefix, so a
  // host-minted `session-<uuid>` resolved to no artifact, the purge answered
  // `ok: true` on the strength of that absence, and the GUI closed the dialog
  // while the session stayed on disk — the reported "delete does nothing".
  it('deletes a session-<uuid> artifact instead of answering a no-op success', async () => {
    const artifacts = new Set([`session-${ID}`])
    const deleted: string[] = []
    const { routes } = await opened(exactKeyPersistence(artifacts, deleted))
    const { status, payload } = await post(routes[0], { sessionId: `session-${ID}`, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(deleted).toEqual([`session-${ID}`])
    expect([...artifacts]).toEqual([])
  })

  it('deletes a bare-uuid artifact too', async () => {
    const artifacts = new Set([ID])
    const deleted: string[] = []
    const { routes } = await opened(exactKeyPersistence(artifacts, deleted))
    const { status } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    expect(status).toBe(200)
    expect(deleted).toEqual([ID])
    expect([...artifacts]).toEqual([])
  })
})
