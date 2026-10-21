import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { purgeSession, purgeSessions, normalizeSessionId, type PurgeResult } from './purge-core.ts'
import { previewSessions } from './preview-core.ts'
import {
  MAX_POLICY_SESSIONS,
  normalizeExcludedIds,
  planPolicyApply,
  previewPolicy,
  validatePolicy,
  type RetentionPolicy,
} from './policy-core.ts'
import {
  createPolicyAdapter,
  createPreviewAdapter,
  createRuntimeAdapter,
  publicErrorMessage,
  type ServiceResolver,
} from './runtime-adapter.ts'

export const name = 'session-purge'
export const inject = ['tools', 'connection']

const DELETE_PATH = '/api/session-purge/delete'
const PREVIEW_PATH = '/api/session-purge/preview'
const POLICY_PREVIEW_PATH = '/api/session-purge/policy/preview'
const POLICY_APPLY_PATH = '/api/session-purge/policy/apply'

/**
 * Upper bound on one batch request. The client only ever sends ids it listed
 * from the live session snapshot, so this is a guard against an accidental
 * unbounded loop on the host, not a product limit.
 */
const MAX_BATCH_IDS = 200

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
 * Authority of a Host header, normalized the way the host's own /api trust fence
 * normalizes it: parse the bare authority under `http:` (a WHATWG special scheme,
 * so the hostname survives and the parse throws on junk), which drops default
 * ports and keeps IPv6 literals bracketed. `undefined` means absent or
 * unparsable, and must fail closed.
 */
function hostAuthority(value: string | null): string | undefined {
  if (value === null) return undefined
  try {
    return new URL(`http://${value.trim()}`).host
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

/**
 * The origin fence both routes share.
 *
 * `request.url` cannot name this deployment's authority: the host bridges
 * /api requests through packages/client/connection/src/http-bridge.ts, which
 * rebuilds each URL against the synthetic base `http://dsh.internal`, so its
 * origin is never the browser's. The Host header is the authority the browser
 * actually dialed and the one the host's own /api trust fence binds, so compare
 * the two hosts. Scheme is deliberately not compared: behind a TLS-terminating
 * proxy the page origin is `https:` while the Host header it forwards carries
 * no scheme, and the host fence accepts that same pair.
 * @returns a refusal response, or null when the request may proceed.
 */
function originFence(request: Request): Response | null {
  const origin = request.headers.get('origin')
  if (!origin) return null
  const authority = hostAuthority(request.headers.get('host'))
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return json({ ok: false, error: 'invalid-origin' }, 403)
  }
  if (authority === undefined || originHost !== authority) {
    return json({ ok: false, error: 'cross-origin-request-rejected' }, 403)
  }
  return null
}

/** The JSON body both routes share: the content type, the parse, the shape. */
async function jsonBody(request: Request): Promise<{ body: unknown } | { response: Response }> {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return { response: json({ ok: false, error: 'application/json-required' }, 415) }
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return { response: json({ ok: false, error: 'invalid-json' }, 400) }
  }
  if (!body || typeof body !== 'object') return { response: json({ ok: false, error: 'invalid-request' }, 400) }
  return { body }
}

function resultStatus(result: PurgeResult): number {
  if (result.ok) return 200
  if (result.stage === 'validate') return 400
  if (result.error.includes('runtime-capability-missing')) return 501
  if (
    result.error.includes('session-live')
    || result.error.includes('session-still-live')
    || result.error.includes('session-write-lease-held')
  ) return 409
  return 500
}

/**
 * HTTP status for a batch outcome, using the same severity order as the
 * single-response mapping: a malformed request is the caller's bug (400), a
 * host that cannot delete at all is a capability report (501), sessions that
 * stay live or lease-held are retryable conflicts (409), and anything else is
 * a genuine per-item failure (500). A mixed batch reports its most severe
 * condition — the per-item `results` array carries the individual truth, and
 * the dialog renders those, not this code.
 */
function batchStatus(results: readonly PurgeResult[]): number {
  if (results.some(result => result.stage === 'validate')) return 400
  if (results.some(result => result.error.includes('runtime-capability-missing'))) return 501
  if (results.some(result => (
    result.error.includes('session-live')
    || result.error.includes('session-still-live')
    || result.error.includes('session-write-lease-held')
  ))) return 409
  return results.every(result => result.ok) ? 200 : 500
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

/**
 * Report one removal to the host and drop the session-list read cache.
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
 *
 * Both halves are reporting side-channels: a listener that throws must not
 * rewrite a completed deletion into a reported failure, and the cache may only
 * be dropped once the fact exists.
 * @param ctx - plugin context, whose scope dispatches to the host's listeners.
 * @param id - the canonical session id whose log was deleted.
 */
async function announceRemoval(ctx: Context, id: string): Promise<void> {
  try {
    const emitter = ctx as Context & { readonly emit: (event: string, ...args: unknown[]) => void }
    emitter.emit('api-session/removed', id)
  } catch (error) {
    logUnexpected(ctx, error, 'announce')
  }
  await purgeSessionListCache(ctx)
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
  const preview = createPreviewAdapter(resolve)
  const policy = createPolicyAdapter(resolve)

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
      const refused = originFence(request)
      if (refused) return refused
      const parsed = await jsonBody(request)
      if ('response' in parsed) return parsed.response
      const input = parsed.body as { sessionId?: unknown; sessionIds?: unknown; confirm?: unknown }
      // Batch first: a body carrying `sessionIds` is always the multi-session
      // form, even when it also carries `sessionId`. Both shapes share one path
      // so the origin/auth fence, the buffering policy and the purge pipeline
      // exist exactly once — a second route could drift from this one.
      if (Array.isArray(input.sessionIds)) {
        if (input.confirm !== true) {
          return json({ ok: false, error: 'sessionIds-and-confirm-true-required' }, 400)
        }
        if (
          input.sessionIds.length === 0
          || input.sessionIds.length > MAX_BATCH_IDS
          || !input.sessionIds.every(id => typeof id === 'string')
        ) {
          return json({ ok: false, error: `sessionIds-must-be-1..${String(MAX_BATCH_IDS)}-strings` }, 400)
        }
        try {
          const batch = await purgeSessions(
            runtime,
            input.sessionIds as readonly string[],
            request.signal,
            (error, stage) => { logUnexpected(ctx, error, stage) },
            async id => {
              // Report each removal and drop the list read cache the moment the
              // fact exists, so a failure or abort later in the batch cannot
              // swallow the announcements of sessions that were really deleted.
              await announceRemoval(ctx, id)
            },
          )
          return json(batch, batchStatus(batch.results))
        } catch (error) {
          logUnexpected(ctx, error, 'route')
          return json({ ok: false, error: publicErrorMessage(error) }, 500)
        }
      }
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
          // Downstream of a deletion that actually happened, so neither half
          // can turn a completed deletion into a reported failure: the
          // Client's row is dropped through the wire event, and the memoized
          // list scan is dropped so the next full refresh cannot resurrect it.
          await announceRemoval(ctx, result.id)
        }
        return json(result, resultStatus(result))
      } catch (error) {
        logUnexpected(ctx, error, 'route')
        return json({ ok: false, error: publicErrorMessage(error) }, 500)
      }
    },
  })

  // The read-only half of the plugin: what a delete would remove, asked before
  // the operator commits. It never calls a removal primitive, so it needs no
  // `confirm` — the consent belongs to the destructive route alone.
  connectionOf(ctx).fetch.register({
    path: PREVIEW_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405)
      const refused = originFence(request)
      if (refused) return refused
      const parsed = await jsonBody(request)
      if ('response' in parsed) return parsed.response
      const input = parsed.body as { sessionId?: unknown; sessionIds?: unknown }
      try {
        if (Array.isArray(input.sessionIds)) {
          if (
            input.sessionIds.length === 0
            || input.sessionIds.length > MAX_BATCH_IDS
            || !input.sessionIds.every(id => typeof id === 'string')
          ) {
            return json({ ok: false, error: `sessionIds-must-be-1..${String(MAX_BATCH_IDS)}-strings` }, 400)
          }
          return json({ ok: true, ...await previewSessions(preview, input.sessionIds as readonly string[]) })
        }
        if (typeof input.sessionId !== 'string') {
          return json({ ok: false, error: 'sessionId-or-sessionIds-required' }, 400)
        }
        return json({ ok: true, ...await previewSessions(preview, [input.sessionId]) })
      } catch (error) {
        logUnexpected(ctx, error, 'preview')
        const message = publicErrorMessage(error)
        return json({ ok: false, error: message }, message.includes('runtime-capability-missing') ? 501 : 500)
      }
    },
  })

  // The policy preview: what a retention policy would remove, asked before
  // the operator commits to it. Like the impact preview it never calls a
  // removal primitive, so it needs no `confirm`.
  connectionOf(ctx).fetch.register({
    path: POLICY_PREVIEW_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405)
      const refused = originFence(request)
      if (refused) return refused
      const parsed = await jsonBody(request)
      if ('response' in parsed) return parsed.response
      const input = parsed.body as { policy?: unknown; excludeSessionIds?: unknown }
      let limits: RetentionPolicy
      try {
        limits = validatePolicy(input.policy)
      } catch (error) {
        return json({ ok: false, error: publicErrorMessage(error) }, 400)
      }
      try {
        const report = await previewPolicy(policy, limits, Date.now(), stringIds(input.excludeSessionIds))
        return json({ ok: true, ...report })
      } catch (error) {
        logUnexpected(ctx, error, 'policy-preview')
        const message = publicErrorMessage(error)
        return json({ ok: false, error: message }, message.includes('runtime-capability-missing') ? 501 : 500)
      }
    },
  })

  // The policy apply: run the purge pipeline over the sessions a policy
  // selects. The ids may be sent explicitly (what the preview listed, so the
  // dry run and the run name the same sessions) or left to the host, which
  // then selects them again from the policy.
  connectionOf(ctx).fetch.register({
    path: POLICY_APPLY_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405)
      const refused = originFence(request)
      if (refused) return refused
      const parsed = await jsonBody(request)
      if ('response' in parsed) return parsed.response
      const input = parsed.body as {
        policy?: unknown
        sessionIds?: unknown
        excludeSessionIds?: unknown
        confirm?: unknown
      }
      // The destructive half of the policy: the same explicit consent the
      // single-session delete asks for.
      if (input.confirm !== true) {
        return json({ ok: false, error: 'confirm-true-required' }, 400)
      }
      let ids: readonly string[]
      // How many sessions the caller asked for, before the exclusions were
      // applied. The difference is what the run left alone on request.
      let requestedCount = 0
      // The exclusions are the caller's "leave this alone" list. They are
      // honoured on BOTH paths: the policy path hands them to the selection,
      // and the explicit-ids path filters them out here, so a request that
      // names an excluded session still cannot remove it.
      const excluded = normalizeExcludedIds(stringIds(input.excludeSessionIds))
      try {
        if (Array.isArray(input.sessionIds)) {
          if (
            input.sessionIds.length === 0
            || input.sessionIds.length > MAX_POLICY_SESSIONS
            || !input.sessionIds.every(id => typeof id === 'string')
          ) {
            return json({ ok: false, error: `sessionIds-must-be-1..${String(MAX_POLICY_SESSIONS)}-strings` }, 400)
          }
          const requested = input.sessionIds as readonly string[]
          requestedCount = requested.length
          ids = requested.filter(id => !isExcluded(id, excluded))
        } else {
          const limits = validatePolicy(input.policy)
          const report = await previewPolicy(policy, limits, Date.now(), stringIds(input.excludeSessionIds))
          ids = report.selected.map(item => item.id)
          requestedCount = ids.length
        }
      } catch (error) {
        logUnexpected(ctx, error, 'policy-apply-select')
        const message = publicErrorMessage(error)
        const status = message.includes('invalid-policy') ? 400 : message.includes('runtime-capability-missing') ? 501 : 500
        return json({ ok: false, error: message }, status)
      }

      try {
        // The host's state is read again here instead of trusting the preview:
        // a session may have become live, or its log may have gone, between
        // the two requests.
        const plan = await planPolicyApply(preview, ids, Date.now())
        const batch = await purgeSessions(
          runtime,
          plan.deletableIds,
          request.signal,
          (error, stage) => { logUnexpected(ctx, error, stage) },
          async id => { await announceRemoval(ctx, id) },
        )
        const sizes = new Map(plan.impacts.map(item => [item.id, item.sizeBytes]))
        const freed = batch.results
          // The log is what holds the bytes. A session whose log is gone but
          // whose cache cleanup failed did free its space, so it counts.
          .filter(result => result.log)
          .map(result => sizes.get(result.id) ?? null)
        const known = freed.filter((size): size is number => size !== null)
        const response = {
          // A run that removed nothing because the policy selected nothing is a
          // successful no-op, not a failure: `batch.ok` is false for an empty
          // batch, and a policy that keeps everything is exactly what the
          // operator asked for.
          ok: batch.failed === 0 && plan.blocked.length === 0,
          total: ids.length,
          succeeded: batch.succeeded,
          failed: batch.failed,
          blocked: plan.blocked.length,
          // How many of the requested sessions were left alone on request.
          excluded: Math.max(0, requestedCount - ids.length),
          bytesFreed: known.length === 0 ? null : known.reduce((sum, size) => sum + size, 0),
          results: batch.results,
          blockedResults: plan.blocked.map(item => ({ id: item.id, reason: item.blockedReason })),
        }
        return json(response, policyApplyStatus(batch.results, plan.blocked.length))
      } catch (error) {
        logUnexpected(ctx, error, 'policy-apply')
        const message = publicErrorMessage(error)
        return json({ ok: false, error: message }, message.includes('runtime-capability-missing') ? 501 : 500)
      }
    },
  })
}

/** The ids a caller asked to leave alone; anything that is not a string is not an id. */
function stringIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string')
}

/**
 * True when the caller asked for this id to be left alone.
 *
 * The comparison happens in the normalized form, so an exclusion matches the
 * session whether the caller wrote `session-<uuid>` or `<uuid>`.
 * @param rawId - the id as the caller wrote it.
 * @param excluded - the normalized exclusion list.
 */
function isExcluded(rawId: string, excluded: ReadonlySet<string>): boolean {
  if (excluded.size === 0) return false
  try {
    return excluded.has(normalizeSessionId(rawId))
  } catch {
    // An id that cannot name a stored session cannot be removed either.
    return false
  }
}

/**
 * HTTP status for a policy run.
 *
 * The severity order matches the delete route's: a host that cannot delete at
 * all is a capability report (501), a session something still holds is a
 * retryable conflict (409), and anything else is a genuine per-item failure
 * (500). A run that skipped nothing and failed nothing is a success (200).
 */
function policyApplyStatus(results: readonly PurgeResult[], blocked: number): number {
  const status = batchStatus(results)
  if (status === 200 && blocked > 0) return 409
  return status
}
