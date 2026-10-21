# Required host integration

This package intentionally does not delete files by constructing a path or by calling `fs.rm()` directly. A compatible DSH host must provide the following runtime capabilities, directly on the named services or through a small adapter:

| Capability | Required semantics |
|---|---|
| `agents.get(id)` + `agent.stop()`, or `sessionController.closeSession(id)` | Stop and drain all writes; the registry must no longer report the agent before persistence deletion begins. `AgentHandle.dispose()` is retained only by its creator, so the Web profile's session controller exposes it as `closeSession(id)`; a plugin that finds neither fails closed with `session-live`. |
| `sessions.get(id)`, `sessions.flush(id)` (or a documented equivalent), `sessions.detach(id)` | Flush first, then detach; no dispose-time callback may recreate the log. |
| `sessionPersistence.delete(id)` | Serialized, backend-owned deletion of the complete artifact; the promise must reject on failure and resolve only when the artifact is durably absent. Must be implemented by each storage backend. |
| `sessionProjectionCache.purge(id)` | Remove all derived projection-cache rows for the canonical SessionId and report success. |
| `workspaceRegistry.releaseSession(id)` or a verified equivalent | Remove membership only after log absence has been confirmed. |

Measured host APIs the adapter actually calls (DSH `0.2.0-rc.2` source, 2026-10-10): `SessionStore.flush` takes the Session **object**, not the id, `SessionStore.detach` takes the **id** and settles once the live entry is gone, and `SessionPersistence` methods take an options object carrying `signal` — the adapter calls those real shapes. The id itself must travel **verbatim**: `sessionDir(root, cwd, id)` keys every artifact by `encodeSegment(id)`, and the host mints both forms (`<uuid>` and `session-<uuid>` — a live list held 153 of the first and 4066 of the second), so rewriting the prefix makes a real artifact look absent and turns deletion into a silent no-op answered `ok: true`. One adapter detail that is deliberate: `logIsAbsent` verifies absence through `stat()` (undefined means absent) instead of trusting the `delete()` postcondition.

### Read-only capabilities (impact preview and retention policy)

Deletion needs none of these; the two read-only surfaces do. A host without them keeps the delete route working and answers HTTP 501 on the preview routes.

| Capability | Required semantics | Used by |
|---|---|---|
| `sessionPersistence.stat(id)` | Resolve the stored-session snapshot, or `undefined` once the artifact is gone. The snapshot carries `header.createdAt` and, on the JSONL backend, the physical `sizeBytes`. | `POST /api/session-purge/preview`, `POST /api/session-purge/policy/apply` |
| `sessionPersistence.list(options?)` | Resolve one snapshot per stored session, in no promised order. The JSONL backend populates `sizeBytes` for materialized artifacts; a session that was created but not yet materialized has none. | `POST /api/session-purge/policy/preview` |

Both are part of the published `SessionPersistence` contract on this host (`packages/session/session-persistence/src/index.ts`), so no new host API is needed for the retention policy.

## Status in this checkout (2026-10-10)

| Capability | Status |
|---|---|
| `sessionPersistence.delete(id, options?)` | Implemented: abstract method on the `SessionPersistence` contract plus the JSONL backend (refuses an in-process open handle and a foreign lease holder, then removes the session directory and all in-memory references; absent id resolves). |
| `sessionProjectionCache.purge(id)` | Implemented: drops the durable row, the dirty write state, and the armed interval timers for the id. |
| `workspaceRegistry.releaseSession(id)` | Implemented: drops the id from every workspace account, the archive and pin sets, and the header/path caches. |
| `agents.get(id)` + `agent.stop()` | Implemented as `sessionController.closeSession(id)` on 2026-10-11 (the public `Agent` face is still id only, so the Web profile's controller — the creator that retains the `AgentHandle` — exposes the disposal as a service method; `ApiSessionAgentController.closeSession`). |
| `sessions.detach(id)` | Implemented: `SessionStore.detach(id)` removes the live store entry and publishes its paired `session/disposed` edge, which closes the id's write handle. A delete that arrives before that close settles waits for its bookkeeping release instead of reading it as a foreign open handle. |

A stock DSH version without `sessionPersistence.delete()` will return an explicit unsupported-capability response (HTTP 501) and will not delete anything. If stopping a live agent, flushing, detaching, or cache/ledger cleanup is unsupported, deletion aborts before the log is touched or reports partial cleanup after the log is deleted. Do not replace these checks with direct deletion of `~/.dsh/sessions` files: persistence can retain in-memory indexes and later recreate removed artifacts.

## Post-delete notifications (measured 2026-10-10)

A deletion that leaves the artifact gone still has to make the row disappear. Three mechanisms are involved, and each is downstream of `result.log === true`, so none can turn a completed deletion into a reported failure.

| Step | Mechanism | Why it is needed |
|---|---|---|
| Session-list notification | This plugin emits `api-session/removed`; `packages/api/session-controller/src/client/index.ts` subscribes to it and the manager records a `remove` mutation | The session-controller emits that wire event only from its `session/disposed` listener. A session deleted from the sidebar is cold — the store never entered it — so the chain never ran and the Client kept the row. With the workspace membership the purge releases, that leftover row moved to the "Ungrouped" group instead of disappearing. |
| Read-cache invalidation | `POST :<port>/plugin/session-readcache/purge` | `dsh-session-readcache` memoizes the `sessionPersistence.list` directory scan behind `session.list` and invalidates on `session/disposed` only; a cold session produces none. The route is POST-only and answers 404 on a host without the plugin. |
| Client refresh | `ctx.sessions.refresh()` (`ISessions.refresh` -> `SessionManager.refreshList`, single-flight per Host generation) | The `sessions.list.refreshInPlace` call this replaced does not exist anywhere in the host, so the refresh was a silent no-op. |

Live evidence for the symptom these close: a host answering `{"ok":true,...,"stage":"complete"}` with the artifact removed while the row stayed visible and its workspace membership was released.

## Recommended upstream implementation path

1. Add a serialized `delete(SessionId)` primitive to the `SessionPersistence` contract and implement it for every configured backend.
2. Add a host-owned disposal operation that has the actual agent handle, drains it, and detaches the Session; plugin code cannot safely manufacture that capability.
3. Implement a workspace/cache cascade owned by the host, or guarantee the named `purge`/release APIs.
4. Keep the endpoint authenticated by the host's existing `connection.fetch` boundary and expose the route only to the web profile.
5. Re-run the checks in the root README whenever a new `SessionPersistence` backend lands. Measured 2026-10-13: JSONL is the only concrete backend in this host (`packages/session/session-persistence-jsonl`), so "both backends" had no second target to test. The crash/partial-failure half of this item is already covered: `test/api-route.test.ts` (`partiallySurvivingPersistence`), `test/controller.test.ts` ("retries only the failed remainder of a partial batch"), and `test/purge-core.test.ts` ("still releases the ledger if cache cleanup fails after log deletion").

### Derived stores that are not persistence backends (measured 2026-10-13)

`session-query-sqlite` is a **query index over sessions**, not a second `SessionPersistence` backend, so `sessionPersistence.delete()` does not target it. It keeps `persisted_sessions` plus an FTS `persisted_docs` table keyed by `session_id`, and it converges on its own: every observation cycle computes `persistentDeletes = persistedRows.filter(row => !observation.persisted.has(row.id))` and deletes those rows inside the same `BEGIN IMMEDIATE` transaction. A session deleted by this plugin therefore leaves index rows only until the next observation cycle — this is read from the source, not measured live. Unlike the read cache it exposes no per-session purge call, so a deleted session stays searchable only for that window rather than permanently.

## Upstream references checked for this scaffold

- [DSH discussion: persistence has no delete/forget API](https://github.com/deepseek-ai/deepseek-harness/discussions/4411)
- [DSH discussion: current sessions are archived but not permanently deleted](https://github.com/deepseek-ai/deepseek-harness/discussions/4441)
- [Session deletion primitive proposal and backend requirements](https://github.com/deepseek-ai/deepseek-harness/discussions/3772)
- [Official Workspace UI slot documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/README.md)
- [Official Session header slot contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/src/client/contract/slots.ts)
