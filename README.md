# DSH Session Purge

## Overview

A DSH plugin with two halves: a Node host half that registers four HTTP endpoints
(two destructive, two read-only) and one model-facing guidance tool, and a browser
client half that adds a human-confirmed **Delete session** action to the session
header and to the sidebar session menu. It is for people running a DSH profile who
want permanent session deletion to be impossible without a human ticking a checkbox
in the UI.

Every headline feature is traceable to a file:

| Feature | Where |
|---|---|
| 🗑 button in the session header | `src/client/index.tsx`, slot `conversation.session.header.utilities` |
| `Delete session` entry in the session "…" menu | `src/client/index.tsx`, slot `sidebar.workspaces.session.menu.item` |
| Irreversible-action dialog with a checkbox | `src/client/index.tsx`, component `ConfirmOverlay` |
| Impact panel in the dialog (size, age, blocked sessions) | `src/client/index.tsx`, component `ImpactPanel` |
| 🧹 `Retention` entry and the policy surface | `src/client/index.tsx`, components `FooterRetentionButton` and `PolicyOverlay` |
| `session_purge` guidance tool for the model | `src/index.ts` |
| `POST /api/session-purge/delete` endpoint | `src/index.ts` |
| `POST /api/session-purge/preview` endpoint (read-only) | `src/index.ts` |
| `POST /api/session-purge/policy/preview` endpoint (read-only) | `src/index.ts` |
| `POST /api/session-purge/policy/apply` endpoint | `src/index.ts` |
| Capability-detected bridge to host services | `src/runtime-adapter.ts` |
| Ordered, fail-closed cleanup | `src/purge-core.ts`, covered by `test/purge-core.test.ts` |
| Read-only impact report | `src/preview-core.ts`, covered by `test/preview.test.ts` |
| Retention policy selection | `src/policy-core.ts`, covered by `test/policy.test.ts` |

This is not turnkey on stock upstream DSH. The published persistence contract does
not provide `sessionPersistence.delete()`, and this plugin fails closed when a
required capability is missing instead of deleting anything anyway. The required
host capabilities are listed in `integration/README.md`.

## Cleanup contract

The core (`src/purge-core.ts`) runs these steps in this order:

1. Stop and drain the live agent.
2. Flush the session log.
3. Detach the live session to prevent a disposal-time rewrite.
4. Delete the log through the persistence provider.
5. Confirm that the log is absent.
6. Purge the projection cache.
7. Release workspace membership only after log absence is established.

If log absence cannot be confirmed, cache and workspace cleanup are not attempted.
If cache cleanup fails after the log is gone, workspace cleanup is still attempted
and the response reports partial failure. Only a canonical UUID is passed to host
services; the on-disk `session-` naming form is normalized at the boundary
(`normalizeSessionId`), so a second delete against a display-form id is never issued.

## Impact preview (read-only)

Before the operator commits, the dialog asks the host what a deletion would remove.
That question travels to `POST /api/session-purge/preview`, a read-only route that
shares the delete route's origin and content-type fences but calls no removal
primitive — it never deletes, not even for a batch.

Request body. No `confirm` is needed, because nothing destructive happens here:

```json
{ "sessionId": "<uuid>" }
```

```json
{ "sessionIds": ["<uuid>", "<uuid>"] }
```

Response:

```json
{
  "ok": true,
  "results": [
    {
      "id": "2de8b71d-bd3b-4f4d-8d1d-5dceac76f934",
      "exists": true,
      "createdAt": 1760000000000,
      "ageDays": 5,
      "sizeBytes": 4096,
      "liveAgent": "idle",
      "attached": false,
      "deletable": true,
      "blockedReason": ""
    }
  ],
  "totalBytes": 4096
}
```

- `createdAt` is epoch milliseconds and `ageDays` is derived from it;
  `sizeBytes` is the physical artifact size the host's `sessionPersistence.stat()`
  reports. `totalBytes` is `null` when no size could be read — never `0`, which
  would claim the sessions hold nothing. A host that does not expose `stat()`
  answers HTTP 501 with `runtime-capability-missing`, and the delete path is
  unaffected.
- `liveAgent` is `idle`, `live`, or `unknown`. `unknown` means the host exposes
  no agent registry at all — exactly the host on which the delete route answers
  501 — so the preview says that instead of calling the session deletable.
- `blockedReason` is `''` when nothing blocks the deletion, and otherwise one of
  `invalid-session-id` (a malformed id), `session-live` (a live agent the host
  can neither dispose nor stop), `agent-registry-unavailable` (the host exposes
  no agent registry) or `stat-failed` (the host could not read this log). A
  session with no stored log is not a blocker: `exists: false` says it, and
  deleting an absent log is a successful no-op. A malformed or unreadable id is
  reported per item instead of failing the whole request, so one unusable id
  cannot hide the others.
- The panel is advisory. When the preview cannot be read, the dialog still
  deletes — only the consent checkbox gates the destructive button. After a
  partial batch failure the panel is read again for the pending remainder, so it
  never describes sessions that are already gone.

## Retention policy (preview, then apply)

The plugin had two ways to remove a session — one session, or a hand-picked
batch. The third way removes what a **rule** selects: the sessions that fall
outside the operator's limits. It is the surface for a store that grew on its
own.

The policy has three limits, and they are independent budgets:

| Limit | Meaning |
|---|---|
| `maxAgeDays` | Sessions older than this many days are removed. |
| `maxCount` | At most this many sessions are kept; the older ones are removed. |
| `maxTotalBytes` | At most this many bytes are kept; the older ones are removed. |

At least one limit must be set. A session is removed when it breaks **any one**
of the budgets, so the selection is their union.

### Preview the policy

`POST /api/session-purge/policy/preview` answers what a policy would remove.
It is read-only: it calls no removal primitive, and it needs no `confirm`.

```json
{
  "policy": { "maxAgeDays": 30, "maxCount": 50, "maxTotalBytes": 104857600 },
  "excludeSessionIds": ["<uuid>"]
}
```

```json
{
  "ok": true,
  "policy": { "maxAgeDays": 30, "maxCount": 50, "maxTotalBytes": 104857600 },
  "totalSessions": 128,
  "selectedCount": 12,
  "totalSelected": 12,
  "keptCount": 116,
  "bytesToFree": 4821304,
  "bytesThisRun": 4821304,
  "bytesKept": 91200432,
  "selected": [
    {
      "id": "2de8b71d-bd3b-4f4d-8d1d-5dceac76f934",
      "exists": true,
      "createdAt": 1760000000000,
      "ageDays": 31.2,
      "sizeBytes": 300144,
      "liveAgent": "idle",
      "attached": false,
      "deletable": true,
      "blockedReason": ""
    }
  ],
  "excludedIds": ["2de8b71d-bd3b-4f4d-8d1d-5dceac76f934"],
  "truncated": false
}
```

- The selection is **deterministic**. The host's `list()` promises no order, so
  the policy sorts by creation time (newest first) and breaks ties on the id.
  Two runs over the same store always select the same sessions.
- The age is the same rounded age the impact panel shows, so a session that
  reads as `30.0` days old is inside a 30-day limit.
- The byte budget is **positional**: the newest sessions are kept while their
  known sizes fit under the cap, and every session past that point whose size
  is known is selected. A session whose size the host did not report is kept
  **wherever it sits** — its size cannot be shown to break the budget, and this
  tool only removes what it can show is over the limit. (The host's contract
  makes `sizeBytes` optional, and the JSONL backend reports none for a session
  that was created but not yet materialized.)
- The budgets are evaluated over *all* stored sessions, including the excluded
  ones: an excluded session still occupies a count slot and still holds bytes.
  Excluding it may only keep it, never move the cut.
- `selectedCount` is what one run removes (at most 500 sessions); `totalSelected`
  is what the policy flags in total. When they differ, `truncated` is `true` and
  the operator runs it again for the rest.
- `bytesToFree` is what the **policy** targets and `bytesThisRun` is what the
  listed sessions hold — the part one run actually removes. The two differ only
  when the run is capped, and the surface shows both, so a headline of
  "5423 of 5436 sessions · 195.1 MB" is the real blast radius rather than the
  500 sessions one run happens to list.
- A host that cannot list its stored sessions answers HTTP 501 with
  `runtime-capability-missing`. The delete and preview routes are unaffected.

### Apply the policy

`POST /api/session-purge/policy/apply` runs the ordinary purge pipeline over
the selected sessions. It is destructive, so it needs `confirm: true`.

```json
{ "sessionIds": ["<uuid>", "<uuid>"], "confirm": true }
```

```json
{ "policy": { "maxAgeDays": 30 }, "confirm": true }
```

Sending `sessionIds` is what the UI does: the run then removes exactly the
sessions the preview named. Sending only `policy` lets the host select them
again. Either way the host re-reads its own state before removing anything, so
a session that became live in between is reported instead of deleted.

```json
{
  "ok": true,
  "total": 12,
  "succeeded": 11,
  "failed": 0,
  "blocked": 1,
  "excluded": 0,
  "bytesFreed": 4500000,
  "results": [ { "ok": true, "id": "<uuid>", "log": true, "cache": true, "ledger": true, "stage": "complete", "error": "" } ],
  "blockedResults": [ { "id": "<uuid>", "reason": "session-live" } ]
}
```

- `excludeSessionIds` is honoured on **both** paths: the policy path hands it to
  the selection, and the explicit-ids path filters it out, so a request that
  names an excluded session still cannot remove it. `excluded` reports how many
  were left alone on request.
- `bytesFreed` counts the sessions whose **log** is gone, so a session whose
  cleanup failed after its log was deleted still counts: its space is freed.

- `blocked` counts the sessions something stood in the way of (a live agent the
  host can neither dispose nor stop). They are not removed and not counted as
  failures.
- The status code follows the delete route's order: `400` for a malformed
  request, `409` for a blocked session, `501` for a host that cannot delete at
  all, `500` for a genuine per-item failure, `200` for a clean run.
- The client requires an explicit consent checkbox, and the button stays
  disabled until the preview exists — and typing a new limit drops the preview,
  so a run can never act on a selection the operator never saw. A **new preview
  also takes the consent back**, because it is a new selection.
- The client enforces the host's own minimums before sending: at least 1 day,
  at least 1 session, at least 1 MB. A zero budget would select every
  known-sized session, which the host accepts for API callers but which is not
  something to type by accident.

### The retention surface in the client

The sidebar foot carries a second entry next to the manual selection button:
🧹 **Retention**. It opens the policy surface with the three limits, a
**Preview policy** button and an **Apply policy** button. The preview lists the
sessions it would remove — id, age and size — so the operator consents to
*these* sessions, not to a number. The headline names every session the policy
flags, and the line below it says how many of them this one run removes.

The session the operator is currently viewing is excluded from every policy
request: it is left out of the preview, it travels with the run as
`excludeSessionIds`, and switching conversation drops the preview and its
consent.

## Compatibility notes (verified against DSH `0.2.0-rc.2`)

Four changes in this package exist because the rc.2 runtime rejected or misloaded
the original scaffold. They are kept so a retarget stays honest about why the code
looks like this:

| Why it is there | What breaks without it | Verified by |
|---|---|---|
| `additionalProperties: false` in the tool `output.schema` (`src/index.ts`) | rc.2 `defineTool` throws `.additionalProperties must be explicitly true or false` while registering the tool, so the whole entry fails to load | that string in `@deepseek-ai/dsh-tools` (`lib/types/schema.js`), plus `npm run type-check` failing with TS2322 before the fix |
| Client bundle built as one classic script wrapped in `window.__ModuleLoader__.load({ id, factory })` (`tsdown.config.ts`) | The web module table executes plugin client bundles as classic scripts. ESM output is a syntax error there, and bundling React ships a second React copy | `lib/client.js` before/after: 77.81 kB with bundled React down to 9.52 kB with `require("react")` |
| Row wrapped in `- insert:` (`cordis.patch.yml`) | A bundle patch is an operation list, not an entry list. A bare row is read as a non-insert patch, prints `patch: entry "session-purge" not found`, and mounts nothing | that exact warning appeared in `dsh --profile <name> --dump-config` before the fix |
| Type-only import of `@deepseek-ai/dsh-client-ui-session/client` (`src/client/index.tsx`) | That package merges `SessionStandardProps`, which declares `sessionId: SessionId`, into the slot props. Without it the header slot has no session id | TS2339 before the fix |
| Optional host services captured through `ctx.inject([name], ...)` instead of static `inject` or direct property reads (`src/index.ts`, `src/runtime-adapter.ts`) | Two measured failure modes on cordis 4.0.1: a static inject for a service the host never provides leaves the fiber epoch INACTIVE, so `apply` never runs and the plugin dies silently; a direct property read of an undeclared service throws a plain `Error('cannot get property "<name>" without inject')`, which the purge sanitizer flattened into `unexpected-error: operation failed; ...` for every delete attempt | Reproduction against a real cordis Context with the host-shaped services: HTTP 500 at stage `stop-agent` before the fix, HTTP 501 at stage `delete-log` after it; both are locked by `test/api-route.test.ts` |

`package.json` pins eleven `@deepseek-ai/*` packages as devDependencies. The host
delivers those packages at run time, but a `link:`-installed plugin resolves its own
imports from its own directory, so the copies are also what `npm run type-check`,
`npm run build`, and the host's `import` resolve against. The pins in this checkout
record the runtime it was verified against. Update them when you retarget, and check
what your host actually runs (see Prerequisites).

## Prerequisites

| Requirement | How to check | Notes |
|---|---|---|
| A DSH host and a profile you control | `dsh --help` prints the usage line | Profiles live under `$DSH_HOME/profiles/<name>` (from the same help text) |
| Node.js | `node --version` | `package.json` declares **no `engines` field**, so no hard minimum is pinned. This checkout was built and tested on `v24.19.0`. |
| npm | `npm --version` | This checkout carries `package-lock.json`, which settles npm as its package manager. Verified with `11.17.0`. |
| Network access to an npm registry that publishes `@deepseek-ai/*` | `npm view @deepseek-ai/dsh-tools version` | Verified against `registry.npmjs.org` while preparing this package (run here with the selector `@0.2.0-rc.2`) |
| Your host's DSH runtime version | `pnpm why @deepseek-ai/dsh-tools` inside `$DSH_HOME/profiles/<name>` | `0.2.0-rc.2` in the checkout this README was written for. The plugin's peers are all `"*"`, so the host's version gate passes anywhere and cannot tell you whether the host is compatible. |
| Account, API key, or paid service | n/a | **None.** The plugin reads no environment variables: |

```bash
grep -rn "process\.env\|import\.meta\.env" src/     # returns nothing
```

The host entry declares `inject = ['tools', 'connection']` (`src/index.ts`), so the
profile must provide those two services. The client half additionally needs a web
surface: `package.json` declares `dsh.client.platform: "web"`.

## Installation

Start from the repository's own remote:

```bash
git clone https://github.com/mulqizamzam/dsh-session-purge
cd dsh-session-purge
npm install
npm run type-check   # first proof the install worked: no output, exit 0
npm test
npm run build        # produces lib/index.js and lib/client.js
ls lib               # expect: client.js  index.js
```

There is no environment setup step: the package declares no environment variables
and no config files to copy.

## Configuration

None. The row mounts with `config: {}` (`cordis.patch.yml`) and `apply(ctx)` reads
no configuration, so there is nothing to set before the first run.

To turn the plugin off without uninstalling it, add an id-targeted row to the
profile's own `cordis.patch.yml` (a later patch layer overrides a bundle row by id):

```yaml
- id: session-purge
  disabled: true
```

## Database / External Services

None. The package owns no database, migration, or seed. It operates on the host's
existing session store through services it only inspects (`src/runtime-adapter.ts`),
and it deletes nothing until the host itself exposes a deletion primitive.

## Running the Project

This is a plugin, not a service. "Running" means booting the profile it is installed
into.

```bash
dsh <profile-name>              # boots that profile (help: dsh [--profile] <name>)
dsh --profile <name> --dump-config   # compose the profile tree and exit
```

A successful start for this plugin means: `dsh --profile <name> --dump-config`
exits 0 and the composed tree contains

```yaml
# == dsh-session-purge
- id: session-purge
  name: dsh-session-purge
  config: {}
```

No port belongs to this package. The GUI URL is owned by the host's configuration,
not by this repository; check your own host's profile.

## First Use / Quick Start

One worked example, from install to the expected outcome.

**UI path** (after the profile restarts with the plugin installed):

1. Boot the profile and open the host GUI.
2. Click 🗑 in the session header (accessible name `Delete session`), or open the
   session's "…" menu and click `Delete session`.
3. The dialog reads `Delete this session permanently?` and requires the checkbox
   `I understand this is permanent and cannot be undone.` before the
   `Delete permanently` button becomes active (`src/client/index.tsx`).
4. What happens next depends on the host's capabilities, and the dialog names
   the missing one. The four host primitives this plugin consumes
   (`sessionPersistence.delete`, `sessionProjectionCache.purge`,
   `workspaceRegistry.releaseSession`, `sessions.detach`) were added to the
   harness checkout this plugin was verified against (2026-10-10; see
   `integration/README.md`), so a session that is attached to the store —
   including one the running host has opened — deletes end to end once the
   profile restarts on that build: flush, detach (which publishes the disposal
   that closes the write handle), delete, verify absence. One fail-closed case
   remains by design: a session with a live agent answers `session-live` (stop
   it first). On a host without the primitives the answer is
   `runtime-capability-missing` naming the first missing service, and **no file
   is deleted**. The dialog must never show `unexpected-error: operation
   failed: ...`; if it does, the host log line tagged
   `session-purge: unexpected failure at <stage>` names the cause.
5. On an integrated host the list refreshes in place, the dialog closes, and the
   session is gone after the seven steps of the cleanup contract.

**Multi-select path.** The sidebar foot (beside Settings) carries a
`Select sessions` button (accessible name `Select sessions`):

1. Click it; the selection manager lists every session with a persisted log,
   with checkboxes, a running badge, and `Select all` / `Clear` actions.
2. Blank New Session rows (nothing persisted yet) and the session currently
   being viewed are excluded — the latter by rule, because deleting the very
   session that issued the batch would abort the client that reports the
   outcome. It stays deletable through its own single-session dialog.
3. `Delete N selected` opens one confirmation listing the chosen sessions
   (first six, then `…and N more.`) behind the same consent checkbox.
4. The host deletes the sessions one at a time. The dialog reports
   `K of N deleted; M failed.` with the per-session reason and **stays open
   with only the failed sessions** armed, so `Delete permanently` retries
   exactly those and never re-sends an id that already succeeded.
5. On success the selection is cleared, the manager closes, and the list
   refreshes in place.

**Retention path.** The sidebar foot carries a second entry next to
`Select sessions`: 🧹 `Retention` (accessible name `Retention`):

1. Click it; the policy surface opens with three limits — keep sessions newer
   than (days), keep at most (sessions), keep at most (MB). At least one must be
   set.
2. `Preview policy` asks the host what the policy would remove and shows the
   selection with the bytes it would free. Nothing is removed yet.
3. `Apply policy` stays disabled until the operator ticks the consent checkbox.
   Typing a new limit drops the preview, so the button can never act on a
   selection that was computed from different limits.
4. The host removes the named sessions one at a time and reports what happened:
   how many were removed, how many failed, how many were skipped because
   something still holds them, and how many bytes were freed.

**Request contract.** The handler itself was invoked directly and returned exactly
this (a unit-level run that bypasses the host's transport):

```
POST /api/session-purge/delete
content-type: application/json

{"sessionId":"<uuid>","confirm":true}
```

For several sessions, the same path accepts the batch form, answered with the
per-item results in request order:

```
{"sessionIds":["<uuid>","session-<uuid>"],"confirm":true}

{"ok":true,"total":2,"succeeded":2,"failed":0,
 "results":[{"ok":true,"id":"…","log":true,"cache":true,"ledger":true,"stage":"complete","error":""}, …]}
```

A batch is processed strictly sequentially (each purge mutates the same host
primitives the next one verifies), a failing item does not stop the rest, and
`ok` is true only when every item succeeded. At most 200 ids per request.

| Condition | HTTP | Body |
|---|---|---|
| `origin` whose host differs from the request's `host` authority | 403 | `{"ok":false,"error":"cross-origin-request-rejected"}` |
| `origin` that is not a parsable URL | 403 | `{"ok":false,"error":"invalid-origin"}` |
| `host` header absent or unparsable (nothing to bind against) | 403 | `{"ok":false,"error":"cross-origin-request-rejected"}` |
| content-type not JSON | 415 | `{"ok":false,"error":"application-json-required"}` |
| `confirm` missing or not `true` | 400 | `{"ok":false,"error":"sessionId-and-confirm-true-required"}` |
| `sessionIds` missing, empty, over 200 entries, or with a non-string entry | 400 | `... "error":"sessionIds-must-be-1..200-strings"` |
| `sessionIds` present with `confirm` not `true` | 400 | `... "error":"sessionIds-and-confirm-true-required"` |
| malformed id | 400 | `... "error":"invalid-session-id: sessionId must be a UUID, optionally prefixed with \"session-\"."` |
| valid id, host lacks capabilities | 501 | `... "stage":"stop-agent"` with a `runtime-capability-missing` message |
| a batch where some item stayed live / lease-held | 409 | `... "ok":false, "failed":N` plus per-item `results` |
| a batch where some item failed otherwise | 500 | `... "ok":false, "failed":N` plus per-item `results` |

A browser always attaches `Origin` to a POST, and a same-origin one compares equal
on host, so the GUI's own delete request is admitted. Through the running host,
the connection transport applies its own trust and authentication policy before
this handler runs, so an unauthenticated client sees the host's rejection first.
Measured against the live host with curl: no `Origin` → 401, `Origin:
http://127.0.0.1:13080` → 401 (fence passed, auth failed), foreign `Origin` →
403 "forbidden" from the host fence.

**Model path.** Calling the `session_purge` tool never deletes anything:

```json
{"ok":false,"stage":"validate","error":"human-confirmation-required: the agent-facing tool cannot authorize permanent deletion. Use the Delete session button and confirm in the dialog."}
```

## Project Structure

```text
src/
  index.ts              # host half: session_purge tool + delete, preview and policy endpoints (start here)
  purge-core.ts         # ordered cleanup, pure and host-independent
  preview-core.ts       # read-only impact report, pure and host-independent
  policy-core.ts        # retention policy selection, pure and host-independent
  runtime-adapter.ts    # capability-detected bridge; every missing method fails closed
  client/
    index.tsx           # slot injections, locale dictionaries (en, zh), confirm dialog, impact panel, selection manager, policy surface
    controller.ts       # UI state: single + multi-select, impact preview, batch POST, retention policy, in-place list refresh
test/
  purge-core.test.ts    # ordering, failure-path and batch tests (16 tests)
  controller.test.ts    # client state machine tests (32 tests)
  api-route.test.ts     # route, origin gate, capability, model-tool refusal and batch tests (36 tests)
  client-ui.test.ts     # jsdom mount of the real components, real events (32 tests)
  preview.test.ts       # read-only preview route: impact, fences, isolation, and that it mutates nothing (19 tests)
  policy.test.ts        # policy validation and deterministic selection (32 tests)
  policy-route.test.ts  # policy preview/apply routes: fences, selection, blocks, exclusions, and that the preview mutates nothing (23 tests)
integration/
  README.md             # host capabilities required for real deletion
cordis.patch.yml        # how the profile mounts this package (one insert row)
tsdown.config.ts        # host ESM build + client CJS/__ModuleLoader__ build
tsconfig.json           # strict, noEmit, jsx react-jsx
lib/                    # build output: index.js (host), client.js (browser) - generated
```

Newcomers edit `src/` first, then `cordis.patch.yml` only when the mount itself must
change. `lib/` is generated: change `src/` and rebuild rather than editing it.

`package.json` carries a `dsh.client.entry` field that the host's manifest parser
ignores (`DshClientManifest` accepts only `platform`, `inject`, `immediately`,
`external`); the client bundle path comes from `exports["./client"]`, which does
point at the real file.

## Common Commands

Development, copied verbatim from `package.json` `scripts`:

```bash
npm run type-check   # "tsc --noEmit"
npm test             # "vitest run"
npm run build        # "tsdown"
```

Profile operations (the `dsh plugin` command forwards its arguments to pnpm, so the
verbs are pnpm's):

```bash
dsh plugin --profile <name> add link:.     # install while inside this directory
dsh plugin --profile <name> remove dsh-session-purge
```

## Testing

Runner: vitest, invoked as `npm test`. There is no `vitest.config.*` file, so
vitest's defaults pick up the seven files under `test/`.

Seven layers:

- `test/purge-core.test.ts` drives `purgeSession` and `purgeSessions` against a
  fake `SessionPurgeRuntime` and asserts ordering, failure paths, signal
  propagation, the abort classification, and what the raw-error observer
  receives.
- `test/api-route.test.ts` loads the plugin through a **real cordis Context**
  (a host fiber provides `tools`/`connection` plus host-shaped services; the
  plugin fiber then runs `apply`, exactly as the host loads plugins). A
  plain-object ctx fixture used to hide the inject bug this package shipped
  with, because its property reads never threw; the topology fixture cannot.
  The host shapes mirror the measured `0.2.0-rc.2` services, so the capability
  detection is asserted against what this host actually exposes.
- `test/controller.test.ts` drives the client `SessionPurgeController` against a
  stubbed `fetch`: the dialog invariants (no open while busy, retry of only the
  failed remainder, current-session exclusion, selection-rows resolution, and
  that a truncated results array cannot drop an item from the retry set).
- `test/client-ui.test.ts` runs the plugin's client `apply()` against a minimal
  slots/locale surface and mounts the real components in jsdom (`react-dom/client`
  with real events): slot registrations and dictionary coverage, the footer
  button's snapshot of the live list (blank rows excluded), the manager's
  checkbox rows with the current session disabled, select-all/clear/delete via
  real clicks, the consent gate, the batch submit with its exact POST body,
  per-item failure rendering, and the retry of only the failed remainder.
- `test/preview.test.ts` drives the read-only preview route through a real cordis
  Context like the delete suite: the impact record (size, age, live agent, blocked
  reason), the origin and content-type fences, the 501 when the host cannot report
  stored metadata, the per-item isolation of one unreadable log, the one-decimal
  age rounding, and two agreements with the delete route — that a preview agrees
  with a 501 delete on a host without the agent registry, and that a preview of a
  deletable batch calls **no** mutating primitive (`delete`, `closeSession`,
  `flush`, `purge`, `releaseSession` are all recorded and all stay empty).
- `test/policy.test.ts` drives the policy core without a host: the validation of
  every limit (an empty policy, a non-numeric limit, a fractional count, a
  negative limit are all refused), the age / count / byte budgets and their
  union, the positional byte cut, the session with an unknown size that is kept
  because it cannot be shown to break the budget — including one that sits past
  the cut, the excluded session that still occupies a count slot, the
  oldest-first ordering, and that the same store always decides the same way.
- `test/policy-route.test.ts` drives the two policy routes through a real cordis
  Context: the route registration, the origin and content-type fences, the
  selection the policy names with its byte total, the 400 for an unusable limit,
  the 501 for a host that cannot list, that the preview mutates nothing (every
  primitive the cleanup pipeline uses is recorded, not only the delete), and the
  apply — that it removes exactly the sessions the preview named, that it skips a
  session a live agent holds and reports why, that the rest of the batch is
  still removed, that an excluded session is left alone even when the request
  names it, and that the bytes of a session whose cleanup failed after its log
  was deleted still count as freed.

What success looks like (observed):

```text
 ✓ test/purge-core.test.ts (16 tests) 43ms
 ✓ test/controller.test.ts (32 tests) 35ms
 ✓ test/preview.test.ts (19 tests) 379ms
 ✓ test/policy-route.test.ts (23 tests) 197ms
 ✓ test/policy.test.ts (32 tests) 60ms
 ✓ test/api-route.test.ts (36 tests) 342ms
 ✓ test/client-ui.test.ts (32 tests) 466ms

 Test Files  7 passed (7)
      Tests  190 passed (190)
```

Exit code 0 on pass (observed). A failing assertion is reported per test by vitest
and the process exits non-zero; that path was not reproduced in this checkout,
because the suite passes.

What remains untested here needs a running profile: the client bundle loading
inside the host's browser module table, the real slot seats in the assembled
shell, and the live host transport. Everything above those — route, batch
orchestration, controller state machine, and component behavior — is covered
headlessly.

npm 11 may print `npm warn allow-scripts ... esbuild@0.28.2 (postinstall: node install.js)`
during `npm install`. Observed in this checkout, and the test suite still passed.

## Troubleshooting

Each entry is a real error string from this package or from the host code that
loads it.

| Symptom / message | Likely cause | Check | Fix |
|---|---|---|---|
| `patch: entry "session-purge" not found` in `--dump-config` | `cordis.patch.yml` rows are not wrapped in `- insert:` | `cat cordis.patch.yml` | Wrap the rows under `- insert:` as shown in that file |
| ``client-modules: client bundle not found; run `pnpm run build` before launch`` with `package: dsh-session-purge` | `lib/client.js` was never built | `ls lib` | `npm run build`, then restart the profile |
| `.additionalProperties must be explicitly true or false`, or `npm run type-check` failing with TS2322 | The tool output object schema lost its `additionalProperties` | `npm run type-check` | Restore `additionalProperties: false` in `src/index.ts` |
| `Missing ctx.connection.fetch.register; session-purge endpoint was not registered.` | The host's `connection` service exists but has no `fetch.register` (an older or different composition) | `dsh --profile <name> --dump-config` and your host version | Verify the host exposes `connection.fetch.register`; this repository only registers through it |
| The `Select sessions` button never appears, while `Delete session` does | The footer entry renders through the `sidebar.footer.action` seat and crashed on `useSessions()` — this host's selector hook throws when called without a selector (the no-argument overload exists in the published type but not at runtime). Measured live; the shipped `CordisPanel` footer occupant always passes one. | `src/client/index.tsx` calls `useSessions(state => state)` (identity selector) | Already fixed; if it recurs, pass a selector |
| The 🗑 button never appears | Profile not restarted since install, client bundle missing, or a profile without a web surface | `dsh --profile <name> --dump-config` for the row, `ls lib/client.js` for the bundle | Build, restart; the buttons only exist in the `web` platform half |
| `require("...") missed the module table` in the browser console | The client bundle asked for something outside the platform seed words | Compare `CLIENT_SEED_EXTERNALS` in `tsdown.config.ts` with `getStaticModules()` in your host's `packages/client/web/src/seed.ts` | Keep the two lists identical, rebuild |
| Dialog shows `runtime-capability-missing: ...` | The host does not expose the required services | Read the message: it names the service and method | Expected on stock hosts. Implement `integration/README.md`, or accept that deletion stays disabled |
| Dialog shows `unexpected-error: operation failed; inspect host logs for details.` at HTTP 500 | A plain (non-`SessionPurgeError`) exception reached the sanitizer; the real cause is one line above in the host log, tagged `session-purge: unexpected failure at <stage>` | The host log for the `session-purge: unexpected failure` line | The label is honest only with the log line: the route logs the raw error before answering. On a correctly wired host this string must not appear for the plain "host has no delete primitive" case — that answers `runtime-capability-missing` instead |
| Response `409` with `session-live` / `session-still-live` | A live agent exists but the host exposes no safe stop capability, or the registry still lists it after `stop()` | Message text from `src/runtime-adapter.ts` | Stop the session first, or add the host-owned disposal bridge |
| `npm warn allow-scripts` about `esbuild` | npm's script allow-list gate skipped esbuild's postinstall | Warning printed by `npm install` | Informational in this checkout (tests still ran); use `npm approve-scripts` if your setup needs esbuild's own install step |

## Development Guide

Development happens on `main` of `https://github.com/mulqizamzam/dsh-session-purge`
in short-lived commits: build, test, commit. The loop that is verifiable from the
files:

```bash
npm run type-check   # before anything else: it catches rc.2 API drift
npm test             # ordering and failure paths
npm run build        # regenerates lib/ from src/
dsh --profile <name> --dump-config   # row still composes
# restart the profile to pick up lib/ changes
```

Client half: after changing `src/client/`, the build must still emit exactly one
classic script wrapped in `window.__ModuleLoader__.load({ id: "dsh-session-purge", ... })`
with only seed words externalized. `tsdown.config.ts` owns both, so the banner,
footer, and `external` list are part of the contract, not decoration.

## Deployment

The supported path is a `link:` install, which symlinks the profile back to this
directory, so a later rebuild takes effect on the next restart without reinstalling.
That is the simplest option for a newcomer because there is no package copy to drift
out of sync with `src/`.

```bash
cd dsh-session-purge
npm install && npm run type-check && npm test && npm run build
dsh plugin --profile <name> add link:.     # anchors link:. to this directory
dsh --profile <name> --dump-config         # expect the session-purge row
cd "$DSH_HOME/profiles/<name>"
node --input-type=module -e "const m = await import('dsh-session-purge'); console.log(Object.keys(m).join(','))"
# restart the profile's host
```

The last command prints `apply,inject,name`, which proves the host-side module
resolves the way the loader will resolve it (observed here).

Notes:

- `file:.` also works as an argument shape for the same command, but it was not run
  while preparing this README, so only `link:.` is verified.
- Removing uses the same pass-through: `dsh plugin --profile <name> remove dsh-session-purge`.
  Removal was not executed here.
- Only profiles with `tools`, `connection`, and a web surface get the full feature
  set. In a profile that provides neither service, the entry simply stays inactive
  instead of loading (cordis fiber semantics, as documented in
  `dsh-session-readcache`'s `lib/index.js`).

## Security Notes

- **No secrets in this package.** No environment variables are read, no credentials
  or tokens appear in any file (checked against `src/`, `test/`, `package.json`).
- **The model cannot authorize deletion.** The `session_purge` tool returns
  `human-confirmation-required` unconditionally; only the UI route wired to the
  checkbox plus the confirm button may call the cleanup core (`src/index.ts`).
- **Endpoint guards:** an `origin` whose host differs from the request's `host`
  authority is rejected with 403, non-JSON body rejected with 415, `confirm` must
  be the literal `true`, ids must be canonical UUIDs. The read-only preview route
  shares the origin and content-type fences but requires no `confirm`, because it
  deletes nothing. Authentication and transport trust are applied by the host's
  connection boundary before this handler runs; verify both in your own host
  composition before exposing it to an untrusted network.
- **The `origin` guard compares the Host authority, never `request.url`.** The host
  bridges `/api` requests through `packages/client/connection/src/http-bridge.ts`,
  which rebuilds every URL against the synthetic base `http://dsh.internal`, so a
  browser's `Origin` can never equal `request.url`'s origin. Comparing the two is
  what rejected every real browser delete with `cross-origin-request-rejected`,
  while leaving a non-browser client without an `Origin` header as the only caller
  that could pass. The guard now compares `new URL(origin).host` against the
  normalized `Host` authority, the same pair the host's own `/api` trust fence
  binds (`packages/client/connection/src/api-request-trust.ts`), and deliberately
  does not compare the scheme, so a TLS-terminating proxy still works.
  `test/api-route.test.ts` locks this: same-origin admitted end to end, and
  foreign-origin, wrong-port, unparsable-origin, and missing-Host all rejected
  with nothing deleted.
- **Never replace the capability checks with direct file deletion.** Persistence can
  hold in-memory indexes and recreate a removed artifact; see `integration/README.md`.
- **The preview route is a metadata-read surface.** It needs no `confirm` because it
  deletes nothing, and like the delete route it admits a request that carries no
  `Origin` header, so a local non-browser process can ask which sessions exist,
  how large they are, how old they are, and whether a live agent holds them. That
  is a smaller exposure than the delete route it sits beside, but it is a new one;
  keep the route behind the same host boundary as the delete route.
- **The policy preview is the same kind of surface, one level up.** It reads the
  host's whole inventory of stored sessions, so a local non-browser process can
  learn how many sessions there are and which ones a limit would select. It
  deletes nothing and needs no `confirm`, but it answers with the shape of the
  operator's own policy.
- **The policy apply is the most destructive route in the package.** It removes
  sessions that nobody picked by hand, so it is fenced twice: the request needs
  `confirm: true`, and the client needs the operator's consent checkbox on top of
  a preview that still matches the limits on screen. Changing a limit drops the
  preview, and the button stays disabled until it is given again.
- **The origin fence is CSRF protection, not authentication.** A request with no
  `Origin` header is admitted, so any local process can remove up to 500
  sessions with `{ "sessionIds": [...], "confirm": true }`. This is the same
  posture as the existing delete route (200 ids), and the human-consent promise
  lives in the client checkbox — the server's `confirm: true` is written by the
  client itself. Keep these routes behind the host's own boundary, and do not
  expose the port to an untrusted network.
- **`.gitignore` keeps the dangerous and the generated out of the repository**:
  `node_modules/`, `lib/` (needed on disk for a `link:` install, but regenerated by
  `npm run build`), the `*:Zone.Identifier` sidecars that arrived with a
  Windows-origin copy, `.env*`, and `*.log`. Commit source, tests, config, and the
  lockfile only.

## FAQ

**Will it delete my session log right now?**
No. Without the host capabilities in `integration/README.md`, the endpoint answers
HTTP 501 with `runtime-capability-missing` and touches nothing.

**Can I ask the agent to delete a session for me?**
No, by design. `confirm: true` from the model is data, not proof of consent.

**What does the dialog show before I confirm?**
What the deletion would remove: the stored size, how old the session is, and any
session the host would refuse to delete right now (a live agent the host can
neither dispose nor stop, an unreadable log, a host without an agent registry).
A session with no stored log is reported as such — deleting it removes nothing and
succeeds. The panel is informational: if the host cannot answer, the dialog still
deletes, and only the consent checkbox gates the destructive button.

**Does the preview delete anything?**
No. `POST /api/session-purge/preview` reads stored-session metadata and calls no
removal primitive. `test/preview.test.ts` asserts that a preview of a deletable
batch leaves `sessionPersistence.delete` uncalled.

**What does the retention policy remove?**
The sessions that break one of the three limits: older than `maxAgeDays`, beyond
the `maxCount` newest, or beyond the byte budget. The selection is deterministic
and it is shown before anything happens — the 🧹 **Retention** entry in the
sidebar foot opens the limits, the preview names the sessions and the bytes, and
only **Apply policy** removes them. The session you are viewing is never
selected.

**Will the policy delete a session that is still running?**
No. The host's live-agent rules are the same ones the manual delete obeys, so a
session a live agent holds is reported as skipped instead of removed.

**Can I undo a policy run?**
No. Like every other deletion in this plugin it is one-way, and the dialog says
so.

**Where do the buttons come from?**
Slot injections in `src/client/index.tsx`. They exist only where the host runs the
`web` platform half of the client module system.

**Why are `@deepseek-ai/*` pinned in devDependencies when the host supplies them?**
Because a `link:` plugin resolves its own imports from its own directory, so those
copies back `type-check`, `build`, and the host-side `import`. Pin them to your
host's runtime version and re-check whenever the host moves.

**How do I keep the data?**
The plugin stores nothing of its own: no state files, no database, no config.

**Which host version does it need?**
The peers are `"*"`, so the host's version gate accepts it anywhere. That gate
cannot prove compatibility, so check your runtime yourself with
`pnpm why @deepseek-ai/dsh-tools` in the profile directory.

## Final Checklist

- [ ] `dsh --help` works, and you know your profile name under `$DSH_HOME/profiles/`
- [ ] `node --version` and `npm --version` work on this machine
- [ ] You cloned this repository and `cd` into it
- [ ] `npm install` completed against a registry that publishes `@deepseek-ai/*`
- [ ] `npm run type-check` exited 0 with no output
- [ ] `npm test` reported `190 passed (190)`
- [ ] `npm run build` wrote `lib/index.js` and `lib/client.js`
- [ ] `dsh plugin --profile <name> add link:.` completed
- [ ] `dsh --profile <name> --dump-config` shows the `session-purge` row
- [ ] The profile's host was restarted
- [ ] The 🗑 action appears and, on an unintegrated host, reports
      `runtime-capability-missing` instead of deleting anything
