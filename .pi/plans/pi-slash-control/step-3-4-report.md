# Step 3–4 report — wiring, autocomplete polish, docs, validation

Branch: `feat/slash-control` (base `feat/slash-status`). No commit, no push, no version bump,
no new dependency. Steps 1–2 were not re-done — `extensions/model-control.ts` and the public
API of `extensions/slash.ts` are **unchanged**.

## Files changed

| File | Status | Lines |
|------|--------|-------|
| `extensions/index.ts` | **modified** | +412 / −27 |
| `extensions/__tests__/index-wiring.test.ts` | **new** | 445 |
| `README.md` | **modified** | +52 / −5 |

`extensions/slash.ts` and `extensions/model-control.ts` were **not** touched in this step
(`extensions/slash.ts` still shows in `git diff --stat` because of Step 2's uncommitted work).

## What was wired (Step 3)

### Registration (all three commands, idempotent)

`registerStatusCommand()` was generalized into `registerSlashCommands()`:

* it calls the new `registerPiCommands(client, token, guildId, commands[])` with
  `[PI_STATUS_COMMAND, PI_ABORT_COMMAND, PI_MODEL_COMMAND]` (new module-level constant
  `PI_SLASH_COMMANDS`),
* **per-command** error reporting is kept: every failed command is logged
  (`Could not register /pi-abort: …`) and surfaced as a warning notification in the existing
  `/pi-status` warning style (`⚠️ Could not register /<name>: <detail>`),
* a failure stays **non-fatal** — the extension keeps working; only the status line changes
  (`⚠️ Discord: /pi-abort unavailable`),
* both call sites were updated: the initial connect (`startClient`) and the reconnect path
  (`attemptReconnect`),
* `registerPiStatusCommand()` in `extensions/slash.ts` was left untouched (it is still exported
  and still covered by the Step 2 tests).

### Interaction routing

`attachInteractionHandler()` (one place, shared by connect + reconnect) now:

1. handles the **autocomplete branch first** — `interaction.isAutocomplete?.()` and
   `interaction.commandName === "pi-model"` → `handlePiModelAutocomplete`,
2. then dispatches the chat-input commands by `commandName` →
   `handlePiStatusInteraction` / `handlePiAbortInteraction` / `handlePiModelInteraction`,
3. **ignores** every unknown command (never answered, never injected into the session).

The TypeScript narrowing of `interaction.commandName` after `isAutocomplete?.()` was verified by
`tsc --noEmit` (the union type has no `commandName` outside the narrowed branches).

### Session-side helpers (runtime, inside the extension)

| Function | Behaviour |
|----------|-----------|
| `abortCurrentRun()` | `no_session` (no Discord session) → `unsupported` (captured ctx missing/stale) → `idle` (nothing running) → otherwise reject the pending Discord question, then `ctx.abort()` in a try/catch → `aborted`. It never ends the session, deletes the channel or disconnects the bot. |
| `listSessionModels()` | The session's candidate list (scoped models first, otherwise the registry's available models filtered by `hasConfiguredAuth`). |
| `currentModelId()` | The **qualified** id `provider/model-id` of the active model — the live `ctx.model` first, the `model_select`-tracked `activeModel` as fallback. |
| `switchSessionModel(id)` | Resolves the model object from the candidate list, then `await pi.setModel(model)`: `false` → `{kind:"no_auth"}`, a thrown error → `{kind:"failed"}` (the raw error only reaches the local log), success → `{kind:"switched"}` (picked up by the existing `model_select` tracking, so `/pi-status` shows the new model). |

### Exported, unit-testable helpers (new, `extensions/index.ts`)

```ts
export function toModelLike(model: unknown): ModelLike | null
export function qualifiedModelId(model: unknown): string | null
export function readScopedModelsSafe(ctx: unknown): unknown[]
export function readAvailableModelsSafe(ctx: unknown): unknown[]
export function readRawModelsSafe(ctx: unknown): unknown[]
export function readModelsSafe(ctx: unknown): ModelLike[]
export function readCurrentModelSafe(ctx: unknown): ModelLike | null
export function resolveCurrentModelId(live, tracked): string | null
export function findModelByQualifiedId(models: unknown[], qualifiedId: string): unknown | null
export function isContextUsable(ctx: unknown): boolean
export function resolveAbortOutcome(input: AbortStateInput): PiAbortOutcome
export interface AbortStateInput { hasSession; ctxUsable; agentBusy; agentIdle }
```

Every ctx access is guarded with the existing `safeCall` pattern — a stale ctx (one that throws
after a session replacement or a reload) degrades to an empty list / `null`, never a throw.

### Tests — `extensions/__tests__/index-wiring.test.ts` (30 tests)

* guarded ctx reads: a throwing ctx degrades (`[]` / `null`) and never throws; a missing ctx too;
  `isContextUsable()` detects the stale ctx,
* scoped models are preferred over the registry's available models; an empty scope falls back to
  the available models,
* the available models are filtered by `hasConfiguredAuth` (a model without credentials is never
  offered),
* qualified-id formatting (`provider/model-id`), `null` for a model without provider/id, the live
  model wins over the tracked one,
* abort outcome mapping: `no_session` / `unsupported` / `idle` / `aborted` + the precedence
  (no_session > unsupported > idle/aborted),
* end-to-end: the `/pi-model` option shape reaches the registration body, the autocomplete answers
  with ≤ 25 filtered choices (each ≤ 100 chars), the model list embed marks the current model,
  states the total count (40 models available — showing 20) and respects the embed limits
  (title ≤ 256, description ≤ 4096, ≤ 25 fields).

## Autocomplete end-to-end check (Step 4)

| Hop | Result |
|-----|--------|
| Option shape in `PI_MODEL_COMMAND` | `{ name: "model", type: 3, required: false, autocomplete: true }` ✓ |
| Registration body | `buildCommandBody()` copies the options into the create/edit body ✓ (asserted by a test) |
| `isAutocomplete()` branch | handled **before** `isChatInputCommand()` in `attachInteractionHandler()` ✓ |
| ≤ 25 choices | `handlePiModelAutocomplete` caps at `PI_MODEL_AUTOCOMPLETE_MAX = 25` ✓ (asserted) |

Nothing had to be fixed — the path was already complete after Step 2.

## Docs (Step 4)

`README.md` gained a `### /pi-abort` and a `### /pi-model` section (behaviour, **every** reply
outcome in a table, the allow-list gate, the hub-mode behaviour and the note that `/pi-abort`
keeps the session alive). The bot-setup bullet now names all three slash commands, and the
hub-mode paragraph mentions the new commands. No unrelated section was rewritten.

## Validation (exact output)

```
$ timeout 300s npm test
> pi-discord-remote@0.2.4 test
> vitest run

 RUN  v4.1.6 /home/tony/code/personal/pi-discord-remote

 Test Files  10 passed (10)
      Tests  262 passed (262)
   Start at  15:44:24
   Duration  784ms (transform 1.15s, setup 0ms, import 2.79s, tests 391ms, environment 2ms)

$ timeout 120s npm run check
> pi-discord-remote@0.2.4 check
> tsc --noEmit
(no output — clean)

$ timeout 180s npm run build
> pi-discord-remote@0.2.4 build
> tsc
(no output — clean)

$ git diff --check
(no output — clean)
```

## Diff stat

```
$ git diff --stat
 README.md           |  57 ++++-
 extensions/index.ts | 439 +++++++++++++++++++++++++++++--
 extensions/slash.ts | 725 +++++++++++++++++++++++++++++++++++++++++++++++++---
 3 files changed, 1151 insertions(+), 70 deletions(-)
```

Untracked files (Step 1–2 + this step):

```
?? .pi/plans/pi-slash-control/step-1-2-report.md
?? extensions/__tests__/index-wiring.test.ts
?? extensions/__tests__/model-control.test.ts
?? extensions/__tests__/slash-control.test.ts
?? extensions/model-control.ts
```

(`extensions/slash.ts` is in the diff stat because of **Step 2's** uncommitted work — this step
did not touch it.)

## Decisions taken inside the plan's latitude

1. **Hub mode.** `hasActiveSession()` gates the *mutating* paths only: `/pi-abort` answers
   “No Pi session is connected.” and a `/pi-model` switch answers the same. The *read-only*
   model list stays available in hub mode (it shows the same model the `/pi-status` snapshot
   already shows). The alternative — an empty list in hub mode — was rejected because the Step 2
   handler resolves the query against the catalog *before* switching: with an empty catalog a
   switch in hub mode would have answered “❌ Unknown model …” (misleading) instead of “No Pi
   session is connected.”.
2. **`ctx.abort()` throwing** still yields `{kind:"aborted"}` — the plan fixes the mapping
   (“`ctx.abort()` inside try/catch → aborted”); the error only reaches the local log (name only,
   never the message).
3. **The pending question is rejected before the abort** (`cancelPendingQuestion()`), as the plan
   requires — otherwise the turn would keep waiting for an answer that never comes.
4. **The abort never touches the session state**: no `clearSessionState()`, no channel deletion,
   no client teardown, no `activeConfig` reset.
5. **The model list is not auth-filtered twice**: `readAvailableModelsSafe()` filters with
   `hasConfiguredAuth` exactly as the plan states; the scoped models are taken as-is (the session
   already scoped them).
6. **Log hygiene**: the new code logs only the error *name* (`describeErrorName()`), never the
   message — a log line can never carry the token, the system prompt, a raw provider error or
   file contents. (The pre-existing `/pi-status` logging was left untouched.)
7. **`resolveAbortOutcome()` is a pure function** so the outcome mapping is unit-tested without a
   live Discord client or a live Pi session (the same pattern as `resolveSessionState`).
8. **Unknown commands are never answered** — the extension ignores them silently.

## Open questions / residual risks

* **Embed total size.** Discord also caps an embed at 6000 characters *in total*. The Step 1
  module caps the title (≤256), the description (≤4096), the field count (≤25) and each field
  value (≤1024), but not the 6000-character total. With realistic model names the payload is
  ~1.5–2 k characters (20 fields × ~80 chars), so it never comes close — but a registry with
  pathologically long model names could exceed it and Discord would reject the embed. Fixing it
  would require a change in `extensions/model-control.ts` (Step 1's module, read-only for this
  step) → flagged, not changed.
* **`ctx.scopedModels` is not part of the public `ExtensionContext` type** in the installed
  `@earendil-works/pi-coding-agent` (it lives on `AgentSession`). The accessor is written
  defensively, so the scope is used when the runtime exposes it and the registry's available
  models are used otherwise — exactly the plan's fallback rule.
* **The `interactionCreate` routing itself is not unit-tested** (it lives inside the extension
  factory and needs a live Discord client). The handlers it dispatches to are covered by the
  Step 2 tests and by the new end-to-end tests; the routing was verified by reading the code and
  by `tsc`.
* The `model_select` event is what makes `/pi-status` show the new model after a switch; that
  tracking already existed and was not changed.
