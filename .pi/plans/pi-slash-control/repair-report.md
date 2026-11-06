# Repair report — `/pi-abort` + `/pi-model` (review findings R1–R6)

Branch: `feat/slash-control` · Repo: `/home/tony/code/personal/pi-discord-remote`
Scope: repair pass only — no commit, no push, no version bump, no new dependency.

> Note: `.pi/plans/pi-slash-control/review.md` does **not** exist in the working tree (the
> directory only holds `CHECKLIST.md`, `EXECUTION_PLAN.md`, `PLAN.md`, `step-1-2-report.md` and
> `step-3-4-report.md`). The repair was executed against the six findings quoted in the task
> brief and against `PLAN.md` (the design contract).

---

## R1 (P1) — Secret hygiene in the new error/log paths

### What changed

**`extensions/slash.ts`**

- The registration paths no longer return a dump of the error. `registerPiCommands()` now
  returns a **fixed, safe error code** on every failure path:
  - `REGISTRATION_FAILED_CODE = "discord_command_registration_failed"` (new export) for a
    failed fetch/create/edit,
  - `REGISTRATION_NOT_READY_CODE = "discord_application_not_ready"` (new export) when the
    Discord application is not ready yet.
- `describeError()` (which serialized `err.message`, `err.body` and a JSON body) was **deleted**;
  `redact()` (which only patched the token out of a leaked message) was **deleted** as well.
- `isMissingCommandScopeError()` was rewritten to be *narrow*: it only looks at the error's
  `code` (50013), `status` (403) and the literal `missing access` marker of the message. The
  message is inspected for that decision only — it is never propagated.
- The actionable hint (the OAuth re-invite URL, which carries the application id only) is
  **kept** on every failure path.
- The `token` parameter of `registerPiCommands()` / `registerPiStatusCommand()` is kept for
  call-site symmetry but is no longer used (there is nothing left to redact); the doc comment
  says so.

**`extensions/index.ts`**

- The two catch-all logs of the new code paths now log a fixed category plus at most the
  error's *name*:
  - `console.error("[pi-discord-remote] Slash interaction failed:", describeErrorName(err))`
  - `console.error("[pi-discord-remote] Could not register the Pi slash commands:", describeErrorName(err))`
- `describeErrorName()` was moved to module level and exported (`extensions/index.ts`), so the
  runtime seams can use it too. It returns `err.name` for an `Error`, `"Error"` for a string and
  `"unknown_error"` otherwise — never the message, the stack, the body or the raw object.
- The per-command registration log keeps the fixed code and the hint
  (`Could not register /pi-model: discord_command_registration_failed — <re-invite URL>`), both
  of which are secret-free.

### Tests

- `extensions/__tests__/slash-control.test.ts`
  - **new** `registration secret hygiene > never logs or returns a secret carried by the registration error`
    — spies on `console.error`, registers with an error whose message carries the bot token and
    whose body carries the system prompt; asserts `result.error === REGISTRATION_FAILED_CODE`,
    that neither the error nor the hint contains a secret, and that **no captured log argument**
    contains a secret.
  - **new** `registration secret hygiene > never leaks the secret of a per-command registration failure`.
  - **changed** `registerPiCommands > keeps registering the other commands when one of them fails`
    — `result.error` now expects the safe code (and asserts it does not contain `"network down"`);
    the surrounding expectations are untouched.
- `extensions/__tests__/slash.test.ts`
  - **changed** `registerPiStatusCommand > returns a failure result when the request fails` —
    `result.error` now expects `REGISTRATION_FAILED_CODE` and asserts it does not contain
    `"network down"`; the surrounding expectations are untouched.

---

## R2 (P1) — Session model scope must be feature-detected, never assumed

### What changed

**`extensions/model-control.ts`**

- New export `ModelScopeKind = "scoped" | "unscoped" | "unavailable"`.
- New export `MODEL_SCOPE_NOTE_UNAVAILABLE = "scope API unavailable — showing all authenticated models"`.
- `ModelCatalog` gained an **optional** `note?: string` (backward compatible) and
  `buildModelCatalog()` an optional 4th parameter `note` (backward compatible — the first three
  parameters are unchanged).

**`extensions/index.ts`**

- New `readScopedModelsProperty(ctx)`: `undefined` means *the property does not exist* (older
  Pi), an array (even an empty one) means *the API exists*.
- New `readRawModelScope(ctx)` → `{ kind, models }` — the single source of truth for the three
  cases:
  1. `scoped` — the scope API exists and the scope is non-empty → exactly the scoped models,
  2. `unscoped` — the scope API exists but the scope is empty (Pi's "no scoping configured") →
     `ctx.modelRegistry.getAvailable()` filtered by `hasConfiguredAuth`,
  3. `unavailable` — the scope API does not exist → the same fallback, but the list is **not**
     scope-filtered.
- New exported `readModelScopeSafe(ctx): ModelScope` → `{ kind, models, note? }`; the note is
  set in case 3 (and only when there is at least one model to show).
- `readRawModelsSafe()` / `readModelsSafe()` are now implemented on top of
  `readRawModelScope()` — no duplicated scope logic.

**`extensions/slash.ts`**

- `PiModelAutocompleteDeps` (and therefore `PiModelInteractionDeps`) gained an **optional**
  `scopeNote?: () => string | null`; the handler renders the note inside the embed description
  (and inside the plain-text fallback).

**Runtime wiring** — `listSessionModels()` now returns `readModelScopeSafe(ctx).models` and the
new `modelScopeNote()` supplies the note to `handlePiModelInteraction`.

### Tests

`extensions/__tests__/index-wiring.test.ts` — **new** describe `readModelScopeSafe`:

- `uses exactly the scoped models when the scope is not empty` (case 1 — `kind === "scoped"`,
  only the scoped models, no note),
- `falls back to the authenticated models when the scope is empty` (case 2 — `kind === "unscoped"`,
  the registry models, no note),
- `falls back to the authenticated models when the scope API is missing (older Pi)` (case 3 —
  `kind === "unavailable"`, the registry models **and** `note === MODEL_SCOPE_NOTE_UNAVAILABLE`),
- `never offers a model without a configured auth in the fallback`,
- `reports no note when the session has no model at all`,
- `degrades to an empty list for a stale ctx`.

The "older Pi" ctx used by the tests has **no** `scopedModels` property at all
(`makeLegacyCtx`).

`extensions/__tests__/slash-control.test.ts` — **new** describe `model scope note`:

- `states that the list is not scope-filtered` (the note appears in the reply),
- `adds no note when the session has a scope`.

---

## R3 (P1) — Accurate documentation of what a model switch persists

### What changed

- **`README.md`** — the absolute claim *"The switch only changes the model of the running session
  — it does not change the configured default model."* was replaced by the version-aware
  wording:
  - the switch applies to the **running session**,
  - **Pi ≥ 1.5**: the configured default model is **not** changed (the global default is only
    persisted when the switch is explicitly persisted — the slash command does not do that),
  - **older Pi versions (< 1.5)**: the same call persisted the change unconditionally, so the
    configured default model *may* become the selected one.
  - The reply table row now reads `✅ Model switched to provider/model-id — Name (this session)`.
  - The candidate-list paragraph documents the feature-detected scope API and the
    "scope API unavailable" note.
- **`extensions/slash.ts`** — the switched-model reply is now
  `✅ Model switched to <provider/model-id> — <name> (this session)`.
- **`extensions/index.ts`** — a short comment sits next to the `pi.setModel(...)` call recording
  the version dependency (`options.persist === true` on Pi ≥ 1.5).

### Tests

- `extensions/__tests__/slash-control.test.ts` — **changed** `handlePiModelInteraction > switches
  to an exact qualified id`: the expected reply is now
  `"✅ Model switched to anthropic/claude-sonnet-4-5 — Claude Sonnet 4.5 (this session)"`.

---

## R4 (P2) — Discord embed aggregate character budget

### What changed

**`extensions/model-control.ts`** (backward compatible extensions only)

- New exports `EMBED_TOTAL_MAX = 6000` and `MESSAGE_MAX = 2000`.
- `buildModelListEmbed()` now enforces the **aggregate** budget (title + description + every
  field name and value ≤ 6000):
  - the budget is reserved with the longest possible description,
  - a field value that does not fit is truncated,
  - an entry that does not fit at all is dropped (the current model is always first),
  - a final guard drops trailing entries if the resulting description is still too long.
- `formatModelListText()` is now bounded by Discord's 2000-character plain-message limit: the
  entries that do not fit are dropped and replaced by an `… and N more models` marker; the
  current model always stays in the header.
- New export `buildModelListReply(catalog): { embed?, content? }` — the embed is used when it can
  carry at least one entry, otherwise the length-bounded plain-text rendering is used.

**`extensions/slash.ts`** — `handlePiModelInteraction()` uses `buildModelListReply()` (embed when
it fits, plain text otherwise).

### Tests

`extensions/__tests__/model-control.test.ts` — **new** describe `Discord character budgets`:

- `keeps the embed within the aggregate budget` (25 models with ~120-char ids and ~400-char
  names → the aggregate stays ≤ 6000 and the entries that do not fit are dropped),
- `still lists the current model when the list does not fit`,
- `bounds the plain-text fallback to Discord's message limit` (≤ 2000 chars, current model kept,
  `… and N more models` marker),
- `falls back to the plain text when the embed cannot carry the list`,
- `uses the embed when the list fits`.

`extensions/__tests__/slash-control.test.ts` — **new** `handlePiModelInteraction > keeps the reply
within Discord's embed budget` (end-to-end through the handler).

---

## R5 (P2) — The runtime paths must be regression-tested through real seams

### What changed

**`extensions/index.ts`** — three injectable seams were extracted and the runtime **uses them**
(no duplicated logic):

| Seam | Signature | Behaviour |
|------|-----------|-----------|
| `abortSessionRun` | `(deps: { hasSession, isBusy, ctx, cancelQuestion }) => PiAbortOutcome` | `ctx.abort()` is called **only** for the `aborted` outcome; `cancelQuestion()` always runs **before** `ctx.abort()` |
| `performModelSwitch` | `(deps: { hasSession?, setModel, candidates, qualifiedId }) => Promise<PiModelSwitchOutcome>` | `setModel` is called **only** for an exactly resolved id; `false` → `no_auth`; a thrown error → `failed` (the raw error never reaches the return value) |
| `routePiInteraction` | `(interaction, handlers) => Promise<void>` | dispatches the **autocomplete branch before** the chat-input branch; unknown commands are ignored |

The runtime now calls them:

- `abortCurrentRun()` → `abortSessionRun({ hasSession: hasActiveSession, isBusy: () => agentBusy, ctx: capturedCtx, cancelQuestion: cancelPendingQuestion })`,
- `switchSessionModel(id)` → `performModelSwitch({ hasSession, setModel: pi.setModel, candidates: readRawModelsSafe(ctx), qualifiedId: id })`,
- `attachInteractionHandler()` → `routePiInteraction(interaction, { modelAutocomplete, status, abort, model })`.

### Tests

`extensions/__tests__/index-wiring.test.ts` — **new** describes:

- `abortSessionRun`: `rejects the pending question before it aborts the run` (call order
  `["cancelQuestion", "abort"]`), `never aborts when nothing is running`, `never aborts without a
  session`, `never aborts when the captured ctx is gone`, `logs only the error name when the abort
  itself fails` (console.error spy — the secret never appears in the log).
- `performModelSwitch`: `switches to an exactly resolved id`, `never switches for an unknown id`,
  `reports a missing API key when the switch answers false`, `reports a failed switch without
  leaking the raw provider error`, `never switches in hub mode`.
- `routePiInteraction`: `dispatches the autocomplete branch before the chat-input branch` (a fake
  that claims *both* — only the autocomplete handler runs), `ignores the autocomplete of an
  unknown command`, `dispatches every known chat-input command`, `ignores an unknown command`,
  `ignores an interaction that is neither autocomplete nor chat input`.

---

## R6 (P3) — README wording about failed switches

### What changed

- **`README.md`** — the row
  `| ⚠️ Could not switch the model. | The switch failed (the raw provider error stays in the local log) |`
  now reads
  `| ⚠️ Could not switch the model. | The switch failed (provider details are suppressed — only a generic error category is logged locally) |`.

---

## Validation

```
$ timeout 300s npm test
> pi-discord-remote@0.2.4 test
> vitest run

 RUN  v4.1.6 /home/tony/code/personal/pi-discord-remote

 Test Files  10 passed (10)
      Tests  293 passed (293)
   Start at  15:55:18
   Duration  809ms (transform 1.44s, setup 0ms, import 3.09s, tests 401ms, environment 2ms)

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

## Files changed

| File | Change |
|------|--------|
| `extensions/model-control.ts` | aggregate/character budgets, `buildModelListReply`, scope note + `ModelScopeKind`, optional catalog `note` |
| `extensions/slash.ts` | fixed safe registration error codes, narrow missing-scope probe, scope-note dep, `buildModelListReply` usage, "(this session)" reply |
| `extensions/index.ts` | feature-detected model scope, `describeErrorName` (module level), the three runtime seams + rewiring, leak-free catch-all logs, `pi.setModel` version comment |
| `README.md` | R3 (version-aware persistence wording, "(this session)") + R6 (suppressed provider details) + scope note |
| `extensions/__tests__/slash.test.ts` | updated the `"network down"` assertion to the safe code |
| `extensions/__tests__/slash-control.test.ts` | R1 secret-hygiene tests, R2 scope-note tests, R3 reply wording, R4 embed-budget test, updated the `"network down"` assertion |
| `extensions/__tests__/index-wiring.test.ts` | R2 scope-detection tests, R5 seam tests |
| `extensions/__tests__/model-control.test.ts` | R4 budget tests |
