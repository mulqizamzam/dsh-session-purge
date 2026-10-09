import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
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

function installPlugin(): { routes: RegisteredRoute[]; deleted: string[] } {
  const routes: RegisteredRoute[] = []
  const deleted: string[] = []
  const ctx = {
    tools: { register: () => {} },
    // Services the runtime adapter capability-detects. Absent agents/live sessions
    // make the orchestration fall through to persistence + cleanup, so a request
    // that clears the gate can be observed end to end.
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
    sessionPersistence: {
      delete: async (id: string) => { deleted.push(id) },
      listSync: () => [],
    },
    sessionProjectionCache: { purge: async () => true },
    workspaceRegistry: { releaseSession: async () => {} },
    connection: {
      fetch: {
        register: (route: RegisteredRoute) => {
          routes.push(route)
          return () => {}
        },
      },
    },
  }
  apply(ctx as unknown as Context)
  return { routes, deleted }
}

async function post(route: RegisteredRoute, body: unknown, headers: Record<string, string>) {
  const response = await route.fetch(browserRequest(body, headers))
  return { status: response.status, payload: await response.json() as { ok?: boolean; error?: string; stage?: string } }
}

describe('POST /api/session-purge/delete origin gate', () => {
  it('registers the delete route for POST only', () => {
    const { routes } = installPlugin()
    expect(routes.map(route => route.path)).toEqual([PATH])
    expect([...routes[0].methods]).toEqual(['POST'])
  })

  // Regression: the GUI's own POST carried Origin for the page it was served from
  // and was answered 403 cross-origin-request-rejected, so deletion was unusable
  // from the browser while the identical request without Origin succeeded.
  it('admits a same-origin browser POST and completes the purge', async () => {
    const { routes, deleted } = installPlugin()
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(deleted).toEqual([ID])
  })

  it('admits a request with no Origin header (non-browser clients reach the host fence instead)', async () => {
    const { routes, deleted } = installPlugin()
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, { host: '127.0.0.1:13080' })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(deleted).toEqual([ID])
  })

  it('matches authorities through URL normalization, not raw strings', async () => {
    const { routes } = installPlugin()
    // Case and a redundant default port must not decide the verdict: the host's own
    // fence normalizes both sides through WHATWG, and a browser may spell the page
    // authority differently from the Host header it dialed.
    for (const [host, origin] of [
      ['localhost', 'http://localhost'],
      ['Example.COM', 'http://example.com'],
      ['example.com:80', 'http://example.com'],
    ] as const) {
      const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, { host, origin })
      expect({ host, origin, status }).toEqual({ host, origin, status: 200 })
      expect(payload.ok).toBe(true)
    }
  })

  it('ignores the scheme, matching the host fence for TLS-terminating proxies', async () => {
    const { routes } = installPlugin()
    // Behind a TLS-terminating proxy the page origin is `https:` while the Host
    // header it forwards carries no scheme at all. The host's own /api fence
    // compares hosts only (api-request-trust.ts) and admits this pair, so a
    // stricter comparison here would break that legitimate deployment.
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: 'dsg.example.com',
      origin: 'https://dsg.example.com',
    })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
  })

  it('rejects a foreign origin and deletes nothing', async () => {
    const { routes, deleted } = installPlugin()
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://evil.example',
    })
    expect(status).toBe(403)
    expect(payload.error).toBe('cross-origin-request-rejected')
    expect(deleted).toEqual([])
  })

  it('rejects the same hostname on a different port', async () => {
    const { routes, deleted } = installPlugin()
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:9999',
    })
    expect(status).toBe(403)
    expect(payload.error).toBe('cross-origin-request-rejected')
    expect(deleted).toEqual([])
  })

  it('rejects an unparsable origin', async () => {
    const { routes, deleted } = installPlugin()
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: true }, {
      host: '127.0.0.1:13080',
      origin: 'not-a-url',
    })
    expect(status).toBe(403)
    expect(payload.error).toBe('invalid-origin')
    expect(deleted).toEqual([])
  })

  it('fails closed when the Host header is missing', async () => {
    const { routes, deleted } = installPlugin()
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
    expect(deleted).toEqual([])
  })

  it('still reaches the confirm gate behind the origin gate', async () => {
    const { routes, deleted } = installPlugin()
    const { status, payload } = await post(routes[0], { sessionId: ID, confirm: false }, {
      host: '127.0.0.1:13080',
      origin: 'http://127.0.0.1:13080',
    })
    expect(status).toBe(400)
    expect(payload.error).toBe('sessionId-and-confirm-true-required')
    expect(deleted).toEqual([])
  })
})
