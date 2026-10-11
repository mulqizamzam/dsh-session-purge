# DSH Session Purge

## Overview

A DSH plugin with two halves: a Node host half that registers one HTTP endpoint and
one model-facing guidance tool, and a browser client half that adds a
human-confirmed **Delete session** action to the session header and to the sidebar
session menu. It is for people running a DSH profile who want permanent session
deletion to be impossible without a human ticking a checkbox in the UI.

Every headline feature is traceable to a file:

| Feature | Where |
|---|---|
| 🗑 button in the session header | `src/client/index.tsx`, slot `conversation.session.header.utilities` |
| `Delete session` entry in the session "…" menu | `src/client/index.tsx`, slot `sidebar.workspaces.session.menu.item` |
| Irreversible-action dialog with a checkbox | `src/client/index.tsx`, component `ConfirmOverlay` |
| `session_purge` guidance tool for the model | `src/index.ts` |
| `POST /api/session-purge/delete` endpoint | `src/index.ts` |
| Capability-detected bridge to host services | `src/runtime-adapter.ts` |
| Ordered, fail-closed cleanup | `src/purge-core.ts`, covered by `test/purge-core.test.ts` |

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
  index.ts              # host half: session_purge tool + POST endpoint, single and batch (start here)
  purge-core.ts         # ordered cleanup, pure and host-independent
  runtime-adapter.ts    # capability-detected bridge; every missing method fails closed
  client/
    index.tsx           # slot injections, locale dictionaries (en, zh), confirm dialog, selection manager
    controller.ts       # UI state: single + multi-select, batch POST, in-place list refresh
test/
  purge-core.test.ts    # ordering, failure-path and batch tests (16 tests)
  controller.test.ts    # client state machine tests (15 tests)
  api-route.test.ts     # route, origin gate, capability and batch tests (35 tests)
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
vitest's defaults pick up the three files under `test/`.

Three layers:

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

What success looks like (observed):

```text
 ✓ test/purge-core.test.ts (16 tests) 19ms
 ✓ test/controller.test.ts (15 tests) 67ms
 ✓ test/api-route.test.ts (35 tests) 545ms

 Test Files  3 passed (3)
       Tests  66 passed (66)
```

Exit code 0 on pass (observed). A failing assertion is reported per test by vitest
and the process exits non-zero; that path was not reproduced in this checkout,
because the suite passes.

Only the browser slot, the client bundle loading inside the host's module table,
and the live host transport remain untested here; they need a running profile.

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
  be the literal `true`, ids must be canonical UUIDs. Authentication and transport
  trust are applied by the host's connection boundary before this handler runs;
  verify both in your own host composition before exposing it to an untrusted
  network.
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
- [ ] `npm test` reported `7 passed (7)`
- [ ] `npm run build` wrote `lib/index.js` and `lib/client.js`
- [ ] `dsh plugin --profile <name> add link:.` completed
- [ ] `dsh --profile <name> --dump-config` shows the `session-purge` row
- [ ] The profile's host was restarted
- [ ] The 🗑 action appears and, on an unintegrated host, reports
      `runtime-capability-missing` instead of deleting anything
