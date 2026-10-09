import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { purgeSession, type PurgeResult } from './purge-core.ts'
import { createRuntimeAdapter, publicErrorMessage } from './runtime-adapter.ts'

export const name = 'session-purge'
export const inject = ['tools', 'connection']

const DELETE_PATH = '/api/session-purge/delete'

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

export function apply(ctx: Context): void {
  const runtime = createRuntimeAdapter(ctx)

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
        try {
          if (new URL(origin).origin !== new URL(request.url).origin) {
            return json({ ok: false, error: 'cross-origin-request-rejected' }, 403)
          }
        } catch {
          return json({ ok: false, error: 'invalid-origin' }, 403)
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
      const input = body as { sessionId?: unknown; confirm?: unknown }
      if (typeof input.sessionId !== 'string' || input.confirm !== true) {
        return json({ ok: false, error: 'sessionId-and-confirm-true-required' }, 400)
      }
      try {
        const result = await purgeSession(runtime, input.sessionId, request.signal)
        return json(result, resultStatus(result))
      } catch (error) {
        return json({ ok: false, error: publicErrorMessage(error) }, 500)
      }
    },
  })
}
