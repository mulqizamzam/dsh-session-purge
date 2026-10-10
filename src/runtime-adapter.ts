import {
  SessionPurgeError,
  type SessionPurgeRuntime,
} from './purge-core.ts'

/**
 * Structural view of the optional services available in compatible DSH forks.
 */
interface LooseService {
  get?: (id: string) => unknown
  flush?: (session: unknown) => Promise<unknown>
  detach?: (id: string) => Promise<unknown> | unknown
  stop?: () => Promise<unknown> | unknown
  delete?: (id: string, options?: { signal?: AbortSignal }) => Promise<unknown>
  stat?: (id: string) => Promise<unknown>
  listSync?: () => readonly { id?: string }[]
  purge?: (id: string) => Promise<boolean>
  releaseSession?: (id: string) => Promise<unknown> | unknown
  detachSession?: (id: string) => Promise<unknown> | unknown
}

/**
 * Service lookup for the adapter. The host context must NEVER be read with a
 * bare property access for a service this plugin does not statically inject:
 * on a real cordis Context (measured with cordis 4.0.1 on this host) the proxy
 * trap throws a plain `Error('cannot get property "<name>" without inject')`
 * for every undeclared name, which the purge's sanitizer would then flatten
 * into `unexpected-error: operation failed; ...`. The resolver is fed by
 * `ctx.inject([name], ...)` captures in `apply()`, which fire when a service
 * appears and simply never fire on hosts that lack it, so the capability
 * detection below stays authoritative.
 */
export type ServiceResolver = (name: string) => LooseService | undefined

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
export function createRuntimeAdapter(resolve: ServiceResolver): SessionPurgeRuntime {
  return {
    async stopAndDrainAgent(id, signal) {
      signal?.throwIfAborted()
      const agents = resolve('agents')
      if (!agents || typeof agents.get !== 'function') {
        throw new SessionPurgeError(
          'runtime-capability-missing',
          'stop-agent',
          'The agents registry is unavailable; cannot prove that the session is not being written.',
        )
      }
      // Host-owned disposal bridge first. The Web profile's session controller
      // retains the AgentHandle it minted (ctx.agents.get() only ever returns a
      // bare Agent), and its closeSession() runs the real dispose: stop, drain,
      // unregister, remove from the store. Without it a live Session could never
      // be deleted — which is the reported "session baru tidak bisa dihapus".
      const controller = resolve('sessionController') as {
        closeSession?: (sessionId: string) => Promise<unknown>
      } | undefined
      if (controller && typeof controller.closeSession === 'function') {
        await controller.closeSession(id)
        if (agents.get(id)) {
          throw new SessionPurgeError(
            'session-still-live',
            'stop-agent',
            'The agent still appears in the registry after the host disposal bridge ran; refusing to delete a log that may still be written.',
          )
        }
        return
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
      const sessions = resolve('sessions')
      const persistence = resolve('sessionPersistence')
      if (!sessions || typeof sessions.get !== 'function') {
        throw new SessionPurgeError(
          'runtime-capability-missing',
          'flush-session',
          'The sessions registry is unavailable; cannot establish a safe deletion boundary.',
        )
      }
      const liveSession = sessions.get(id)
      if (!liveSession) return
      // The real host API is `flush(session)` — the Session object, not the id
      // (packages/core/session SessionStore). Passing the id string made the
      // host dereference a string and throw a TypeError, which surfaced as
      // `unexpected-error`. `persistence.flush()` is the service-wide
      // equivalent and takes no arguments.
      if (typeof sessions.flush === 'function') {
        await (sessions.flush as (session: unknown) => Promise<unknown>).call(sessions, liveSession)
        return
      }
      // SessionPersistence.flush() is the service-wide barrier and takes no
      // arguments; it is a different shape from SessionStore.flush(session).
      const serviceWideFlush = (persistence as { flush?: () => Promise<unknown> } | undefined)?.flush
      if (typeof serviceWideFlush === 'function') {
        await serviceWideFlush.call(persistence)
        return
      }
      throw new SessionPurgeError(
        'flush-unavailable',
        'flush-session',
        'A live session exists but the runtime exposes no flush method; refusing to delete its log.',
      )
    },

    async detachSession(id) {
      const sessions = resolve('sessions')
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
      const persistence = resolve('sessionPersistence')
      const remove = needMethod<(id: string, options?: { signal?: AbortSignal }) => Promise<unknown>>(
        persistence,
        'delete',
        'sessionPersistence',
      )
      await remove(id, { signal })
    },

    async logIsAbsent(id) {
      const persistence = resolve('sessionPersistence')
      if (!persistence) {
        throw new SessionPurgeError(
          'runtime-capability-missing',
          'verify-log',
          'The persistence service is unavailable; log absence cannot be verified.',
        )
      }
      // Mechanical absence check on the real host API: stat() resolves the
      // snapshot or `undefined` once the artifact is gone. Trusting the
      // delete() postcondition alone reported "verified" without observing
      // anything, so stat is preferred whenever the host exposes it.
      if (typeof persistence.stat === 'function') {
        return await (persistence.stat as (id: string) => Promise<unknown>).call(persistence, id) === undefined
      }
      // Older-shaped providers: a successful delete() is itself a postcondition.
      if (typeof persistence.listSync !== 'function') return true
      return !persistence.listSync().some(row => {
        if (typeof row.id !== 'string') return false
        const candidate = row.id.startsWith('session-') ? row.id.slice(8) : row.id
        return candidate.toLowerCase() === id.toLowerCase()
      })
    },

    async purgeProjectionCache(id) {
      const projectionCache = resolve('sessionProjectionCache')
      const purge = needMethod<(id: string) => Promise<boolean>>(
        projectionCache,
        'purge',
        'sessionProjectionCache',
      )
      return await purge(id)
    },

    async releaseWorkspaceMembership(id) {
      const workspaceRegistry = resolve('workspaceRegistry')
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
