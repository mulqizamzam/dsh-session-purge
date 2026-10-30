import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { purgeSession, type PurgeResult } from './purge-core.ts'
import {
  createRuntimeAdapter,
  publicErrorMessage,
  type ServiceResolver,
} from './runtime-adapter.ts'

export const name = 'session-purge'
export const inject = ['tools', 'connection']

const DELETE_PATH = '/api/session-purge/delete'

/**
 * Host services the adapter capability-detects. They are captured through
 * `ctx.inject([name], ...)` instead of static `inject` or direct property
 * reads, for two measured reasons on this host (cordis 4.0.1):
 * - a static inject for a service a host never provides leaves the fiber
 *   epoch INACTIVE, so this plugin's body never runs at all, silently;
 * - a direct property read of an undeclared service throws a plain Error,
 *   which the purge sanitizer would flatten into an opaque
 *   `unexpected-error: operation failed; ...`.
 * The callback fires when the service appears and never fires when the host
 * lacks it, so capability detection stays authoritative and boot never blocks.
 */
const OPTIONAL_SERVICES = [
  'agents',
  'sessions',
  'sessionPersistence',
  'sessionProjectionCache',
  'workspaceRegistry',
  // The Web profile's session controller, which owns the disposal bridge
  // (`closeSession`) that lets a live Session be released before deletion.
  'sessionController',
] as const

function logUnexpected(ctx: Context, error: unknown, stage: string): void {
  const detail = error instanceof Error ? (error.stack || error.message) : String(error)
  ctx.logger?.error?.(`session-purge: unexpected failure at ${stage}: ${detail}`)
}

interface FetchRoute {
  path: string
  methods: readonly ('GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE' | 'PATCH')[]
  requestBody: 'buffered'
  fetch: (request: Request) => Promise<Response>
}
interface ConnectionService {
  fetch: { register(route: FetchRoute): (() => Promise<void>) | void }
}

function connectionOf(ctx: Context): ConnectionService {
  const connection = Reflect.get(ctx, 'connection') as ConnectionService | undefined
  if (!connection?.fetch?.register) {
    throw new Error('Missing ctx.connection.fetch.register; session-purge endpoint was not registered.')
  }
  return connection
}

/**
 * Authority of a Host header, normalized under the request Origin's scheme so
 * WHATWG URL parsing drops only that scheme's default port and keeps IPv6
 * literals bracketed. `undefined` means absent or unparsable, and must fail closed.
 */
function hostAuthority(value: string | null, scheme: 'http:' | 'https:'): string | undefined {
  if (value === null) return undefined
  try {
    return new URL(`${scheme}//${value.trim()}`).host
  } catch {
    return undefined
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function resultStatus(result: PurgeResult): number {
  if (result.ok) return 200
  if (result.stage === 'validate') return 400
  if (result.error.includes('runtime-capability-missing')) return 501
  if (result.error.includes('session-live') || result.error.includes('session-still-live')) return 409
  return 500
}

/**
 * Tell the host's Session list that this id is gone.
 *
 * The session-controller converts `session/disposed` into the
 * `api-session/removed` wire event, which is what makes a Client drop a row
 * (`packages/api/session-controller/src/index.ts` emits it from that listener;
 * `packages/api/session-controller/src/client/index.ts` subscribes to it and the
 * manager records a `remove` mutation for the row). A session deleted straight
 * from the sidebar is cold: the store never entered it, so no `session/disposed`
 * edge exists and that chain never runs. The Client therefore kept the row, and
 * with the workspace membership this purge releases the row moved to the
 * "Ungrouped" group instead of disappearing.
 *
 * The event name is a string contract rather than a typed one: its Context event
 * map entry is declared by the session-controller package, which this plugin
 * does not depend on. The controller still owns the policy — a subagent row is
 * flagged rather than removed — so this reports only the fact of the deletion.
 * @param ctx - plugin context, whose scope dispatches to the host's listeners.
 * @param id - the canonical session id whose log was deleted.
 */
function announceRemoval(ctx: Context, id: string): void {
  const emitter = ctx as Context & { readonly emit: (event: string, ...args: unknown[]) => void }
  emitter.emit('api-session/removed', id)
}

/**
 * Drop the `sessionPersistence.list` read cache so the next list rescan sees the
 * deletion. `dsh-session-readcache` memoizes that directory scan — the very call
 * behind `session.list` — and invalidates the memo only on `session/disposed`,
 * which the store emits for sessions it had entered. A session deleted straight
 * from the sidebar is cold (never entered), so no event fires, the memo keeps
 * serving the pre-delete scan, and the deleted session keeps appearing — with
 * its workspace membership released, the client renders that leftover under
 * "Ungrouped". The plugin exposes a POST-only purge route for exactly this;
 * a host without it answers 404 and the purge stays complete.
 *
 * Best-effort by contract: the log is already gone, so a cache call that fails
 * for any reason must not turn a completed deletion into a reported failure.
 * @param ctx - the plugin context, used only to read the web server's port.
 */
async function purgeSessionListCache(ctx: Context): Promise<void> {
  try {
    const webServer = typeof ctx.get === 'function'
      ? ctx.get('webServer') as { readonly port?: number } | undefined
      : undefined
    const port = webServer?.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0) return
    await fetch(`http://127.0.0.1:${String(port)}/plugin/session-readcache/purge`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    /* an unreachable or absent read cache cannot undo the deletion */
  }
}

export function apply(ctx: Context): void {
  const resolved = new Map<string, object>()
  for (const name of OPTIONAL_SERVICES) {
    ctx.inject([name], (injected: Context) => {
      const value = Reflect.get(injected, name) as unknown
      if (value && typeof value === 'object') resolved.set(name, value)
    })
  }
  const resolve: ServiceResolver = name => resolved.get(name) as ReturnType<ServiceResolver>
  const runtime = createRuntimeAdapter(resolve)

  ctx.tools.register(defineTool({
    name: 'session_purge',
    description: 'Explain the safe session-deletion workflow. This model-facing tool never authorizes permanent deletion by itself; use the human-confirmed Delete session UI dialog for the destructive action.',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'UUID or session-<UUID> of the one session to delete.' },
      confirm: { type: 'boolean', required: true, description: 'Must be true to authorize permanent deletion.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          log: { type: 'boolean' },
          cache: { type: 'boolean' },
          ledger: { type: 'boolean' },
          stage: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      // `confirm: true` is still model-supplied data, not proof of human consent.
      // Only the UI route is allowed to call purgeSession after the user checks
      // the irreversible-action acknowledgement and clicks the confirmation button.
      return {
        ok: false,
        id: args.sessionId,
        log: false,
        cache: false,
        ledger: false,
        stage: 'validate',
        error: 'human-confirmation-required: the agent-facing tool cannot authorize permanent deletion. Use the Delete session button and confirm in the dialog.',
      }
    },
  }))

  // DSH host routes are registered through the Connection fetch service.
  // A stock upstream runtime without SessionPersistence.delete will return 501/fail closed.
  connectionOf(ctx).fetch.register({
    path: DELETE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405)
      const origin = request.headers.get('origin')
      if (origin) {
        // `request.url` is synthetic behind the host bridge, so Host carries the
        // browser-facing authority. Parse that authority using the Origin scheme:
        // this normalizes a forwarded explicit default port (443 for HTTPS, 80
        // for HTTP) without accepting a non-default or cross-scheme port.
        let originUrl: URL
        try {
          originUrl = new URL(origin)
        } catch {
          return json({ ok: false, error: 'invalid-origin' }, 403)
        }
        if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
          return json({ ok: false, error: 'invalid-origin' }, 403)
        }
        const scheme: 'http:' | 'https:' = originUrl.protocol
        const authority = hostAuthority(request.headers.get('host'), scheme)
        if (authority === undefined || originUrl.host !== authority) {
          return json({ ok: false, error: 'cross-origin-request-rejected' }, 403)
        }
      }
      if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
        return json({ ok: false, error: 'application/json-required' }, 415)
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, error: 'invalid-json' }, 400)
      }
      if (!body || typeof body !== 'object') return json({ ok: false, error: 'invalid-request' }, 400)
      const input = body as { sessionId?: unknown; sessionIds?: unknown; confirm?: unknown }
      // Batch mode: sessionIds must be a string array + confirm.
      if (input.sessionIds !== undefined) {
        if (!Array.isArray(input.sessionIds) || !input.sessionIds.every((id: unknown) => typeof id === 'string')) {
          return json({ ok: false, error: 'invalid-sessionIds' }, 400)
        }
        if (input.confirm !== true) {
          return json({ ok: false, error: 'sessionId-and-confirm-true-required' }, 400)
        }
        const ids = input.sessionIds as string[]
        if (ids.length === 0) return json({ ok: false, error: 'empty-sessionIds' }, 400)
        const results: { ok: boolean; id: string; error?: string; stage?: string }[] = []
        for (const id of ids) {
          try {
            const result = await purgeSession(runtime, id, request.signal, (error, stage) => {
              logUnexpected(ctx, error, stage)
            })
            if (result.log) announceRemoval(ctx, result.id)
            results.push(result)
          } catch (error) {
            logUnexpected(ctx, error, 'route')
            results.push({ ok: false, id, error: publicErrorMessage(error), stage: 'route' })
          }
        }
        // Invalidate list cache once after all deletions
        try { await purgeSessionListCache(ctx) } catch { /* best-effort */ }
        const allOk = results.every(result => result.ok)
        return json({ ok: allOk, results }, allOk ? 200 : 207)
      }
      // Single mode: sessionId + confirm
      if (typeof input.sessionId !== 'string' || input.confirm !== true) {
        return json({ ok: false, error: 'sessionId-and-confirm-true-required' }, 400)
      }
      try {
        const result = await purgeSession(runtime, input.sessionId, request.signal, (error, stage) => {
          logUnexpected(ctx, error, stage)
        })
        // Only once the artifact is really gone: the read cache must not be
        // dropped for a deletion that did not happen, or the next list would
        // rescan a session that still exists. Failure here is contained — the
        // deleted log is the fact the response reports.
        if (result.log) {
          // Both are downstream of a deletion that actually happened, so neither
          // can turn a completed deletion into a reported failure: the Client's
          // row is dropped through the wire event, and the memoized list scan is
          // dropped so the next full refresh cannot resurrect it.
          announceRemoval(ctx, result.id)
          await purgeSessionListCache(ctx)
        }
        return json(result, resultStatus(result))
      } catch (error) {
        logUnexpected(ctx, error, 'route')
        return json({ ok: false, error: publicErrorMessage(error) }, 500)
      }
    },
  })
}
