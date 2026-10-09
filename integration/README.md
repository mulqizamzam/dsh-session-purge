# Required host integration

This package intentionally does not delete files by constructing a path or by calling `fs.rm()` directly. A compatible DSH host must provide the following runtime capabilities, directly on the named services or through a small adapter:

| Capability | Required semantics |
|---|---|
| `agents.get(id)` + `agent.stop()` or an injected host-owned disposer | Stop and drain all writes; the registry must no longer report the agent before persistence deletion begins. The public upstream API may not expose this disposer to arbitrary plugins. |
| `sessions.get(id)`, `sessions.flush(id)` (or a documented equivalent), `sessions.detach(id)` | Flush first, then detach; no dispose-time callback may recreate the log. |
| `sessionPersistence.delete(id)` | Serialized, backend-owned deletion of the complete artifact; the promise must reject on failure and resolve only when the artifact is durably absent. Must be implemented by each storage backend. |
| `sessionProjectionCache.purge(id)` | Remove all derived projection-cache rows for the canonical SessionId and report success. |
| `workspaceRegistry.releaseSession(id)` or a verified equivalent | Remove membership only after log absence has been confirmed. |

A stock DSH version without `sessionPersistence.delete()` will return an explicit unsupported-capability response (HTTP 501) and will not delete anything. If stopping a live agent, flushing, detaching, or cache/ledger cleanup is unsupported, deletion aborts before the log is touched or reports partial cleanup after the log is deleted. Do not replace these checks with direct deletion of `~/.dsh/sessions` files: persistence can retain in-memory indexes and later recreate removed artifacts.

## Recommended upstream implementation path

1. Add a serialized `delete(SessionId)` primitive to the `SessionPersistence` contract and implement it for every configured backend.
2. Add a host-owned disposal operation that has the actual agent handle, drains it, and detaches the Session; plugin code cannot safely manufacture that capability.
3. Implement a workspace/cache cascade owned by the host, or guarantee the named `purge`/release APIs.
4. Keep the endpoint authenticated by the host's existing `connection.fetch` boundary and expose the route only to the web profile.
5. Run the checks in the root README against both JSONL and SQLite backends, and test crash/partial-failure cases.

## Upstream references checked for this scaffold

- [DSH discussion: persistence has no delete/forget API](https://github.com/deepseek-ai/deepseek-harness/discussions/4411)
- [DSH discussion: current sessions are archived but not permanently deleted](https://github.com/deepseek-ai/deepseek-harness/discussions/4441)
- [Session deletion primitive proposal and backend requirements](https://github.com/deepseek-ai/deepseek-harness/discussions/3772)
- [Official Workspace UI slot documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-workspace/README.md)
- [Official Session header slot contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/src/client/contract/slots.ts)
