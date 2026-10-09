import type { Context } from '@deepseek-ai/cordis'
import {
  SessionPurgeError,
  type SessionPurgeRuntime,
} from './purge-core.ts'

/** Structural view of the optional services available in compatible DSH forks. */
interface LooseService {
  get?: (id: string) => unknown
  flush?: (id: string, signal?: AbortSignal) => Promise<unknown>
  detach?: (id: string) => Promise<unknown> | unknown
  stop?: () => Promise<unknown> | unknown
  delete?: (id: string, signal?: AbortSignal) => Promise<unknown>
  listSync?: () => readonly { id?: string }[]
  purge?: (id: string) => Promise<boolean>
  releaseSession?: (id: string) => Promise<unknown> | unknown
  detachSession?: (id: string) => Promise<unknown> | unknown
}

function service(ctx: Context, name: string): LooseService | undefined {
  const value = Reflect.get(ctx, name) as unknown
  return value && typeof value === 'object' ? value as LooseService : undefined
}

function needMethod<T extends (...args: never[]) => unknown>(
  object: object | undefined,
  method: string,
  serviceName: string,
): T {
  const fn = object ? Reflect.get(object, method) : undefined
  if (typeof fn !== 'function') {
    throw new SessionPurgeError(
      'runtime-capability-missing',
      'validate',
      `The installed DSH runtime does not expose ${serviceName}.${method}; session deletion is disabled until the host integration is added.`,
    )
  }
  return fn.bind(object) as T
}

/**
 * Build an adapter only from explicit host capabilities. Missing critical methods
 * fail closed; this code intentionally does not unlink guessed filesystem paths.
 */
export function createRuntimeAdapter(ctx: Context): SessionPurgeRuntime {
  return {
    async stopAndDrainAgent(id, signal) {
      signal?.throwIfAborted()
      const agents = service(ctx, 'agents')
      if (!agents || typeof agents.get !== 'function') {
        throw new SessionPurgeError(
          'runtime-capability-missing',
          'stop-agent',
          'The agents registry is unavailable; cannot prove that the session is not being written.',
        )
      }
      const agent = agents.get(id) as { stop?: () => Promise<unknown> | unknown } | undefined
      if (!agent) return
      if (typeof agent.stop !== 'function') {
        throw new SessionPurgeError(
          'session-live',
          'stop-agent',
          'This runtime has a live agent but exposes no safe stop-and-dispose capability to plugins. Stop/close the session first or add the host-owned disposal bridge; the log was not deleted.',
        )
      }
      await agent.stop()
      if (agents.get(id)) {
        throw new SessionPurgeError(
          'session-still-live',
          'stop-agent',
          'The agent still appears in the registry after stop(); refusing to delete a log that may still be written.',
        )
      }
    },

    async flushSession(id, signal) {
      signal?.throwIfAborted()
      const sessions = service(ctx, 'sessions')
      const persistence = service(ctx, 'sessionPersistence')
      if (!sessions || typeof sessions.get !== 'function') {
        throw new SessionPurgeError(
          'runtime-capability-missing',
          'flush-session',
          'The sessions registry is unavailable; cannot establish a safe deletion boundary.',
        )
      }
      const liveSession = sessions.get(id)
      if (!liveSession) return
      const flush = sessions.flush ?? persistence?.flush
      if (typeof flush !== 'function') {
        throw new SessionPurgeError(
          'flush-unavailable',
          'flush-session',
          'A live session exists but the runtime exposes no flush method; refusing to delete its log.',
        )
      }
      await flush.call(sessions.flush ? sessions : persistence, id, signal)
    },

    async detachSession(id) {
      const sessions = service(ctx, 'sessions')
      if (!sessions || typeof sessions.get !== 'function') {
        throw new SessionPurgeError(
          'runtime-capability-missing',
          'detach-session',
          'The sessions registry is unavailable; cannot ensure the session will not rewrite its log.',
        )
      }
      if (!sessions.get(id)) return
      const detach = needMethod<(id: string) => Promise<unknown> | unknown>(
        sessions,
        'detach',
        'sessions',
      )
      await detach(id)
      if (sessions.get(id)) {
        throw new SessionPurgeError(
          'session-still-attached',
          'detach-session',
          'The session remains attached after detach(); refusing to delete its log.',
        )
      }
    },

    async deleteLog(id, signal) {
      const persistence = service(ctx, 'sessionPersistence')
      const remove = needMethod<(id: string, signal?: AbortSignal) => Promise<unknown>>(
        persistence,
        'delete',
        'sessionPersistence',
      )
      await remove(id, signal)
    },

    async logIsAbsent(id) {
      const persistence = service(ctx, 'sessionPersistence')
      if (!persistence) {
        throw new SessionPurgeError(
          'runtime-capability-missing',
          'verify-log',
          'The persistence service is unavailable; log absence cannot be verified.',
        )
      }
      // A successful delete() is itself a postcondition in compatible persistence
      // providers. If listSync is also exposed, use it as an independent check.
      if (typeof persistence.listSync !== 'function') return true
      return !persistence.listSync().some(row => {
        if (typeof row.id !== 'string') return false
        const candidate = row.id.startsWith('session-') ? row.id.slice(8) : row.id
        return candidate.toLowerCase() === id.toLowerCase()
      })
    },

    async purgeProjectionCache(id) {
      const projectionCache = service(ctx, 'sessionProjectionCache')
      const purge = needMethod<(id: string) => Promise<boolean>>(
        projectionCache,
        'purge',
        'sessionProjectionCache',
      )
      return await purge(id)
    },

    async releaseWorkspaceMembership(id) {
      const workspaceRegistry = service(ctx, 'workspaceRegistry')
      const method = typeof workspaceRegistry?.releaseSession === 'function'
        ? workspaceRegistry.releaseSession
        : workspaceRegistry?.detachSession
      if (typeof method !== 'function') {
        throw new SessionPurgeError(
          'workspace-ledger-unavailable',
          'release-ledger',
          'The workspace registry exposes neither releaseSession() nor detachSession(); ledger cleanup was not performed.',
        )
      }
      await method.call(workspaceRegistry, id)
    },
  }
}

/** Avoid leaking host filesystem paths or stack traces through an HTTP response. */
export function publicErrorMessage(error: unknown): string {
  if (error instanceof SessionPurgeError) return `${error.code}: ${error.message}`
  // Provider exceptions can contain absolute host paths; keep them in host logs only.
  if (error instanceof Error) return 'unexpected-error: operation failed; inspect host logs for details.'
  return 'unexpected-error: operation failed; inspect host logs for details.'
}
