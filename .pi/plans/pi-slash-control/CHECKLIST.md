# CHECKLIST — Discord `/pi-abort` and `/pi-model` slash commands

## Objective

Ship two additional guild-scoped, ephemeral Discord slash commands — `/pi-abort` (stop the current
agent run, session survives) and `/pi-model` (list the usable models / switch the active model) —
without changing `/pi-status` behavior, without leaking secrets, and without touching the guild's
other commands.

Branch: `feat/slash-control` (cut from `feat/slash-status`). `main` untouched. Parent owns the
commit + push.

**Status (2026-11-05):** implementation complete, three independent review rounds done
(`review.md` → CHANGES REQUIRED, `repair-review.md` → 2 new findings, `final-review.md` →
**ACCEPT**), all findings repaired (`repair-report.md`, `repair-report-2.md`). Final validation:
306 tests, typecheck, build and diff check clean. Nothing committed, pushed or published.

## Phase 1 — Pure model-control module

- [x] `extensions/model-control.ts` exists, imports nothing from discord.js or pi
- [x] `ModelLike` = `{ provider, id, name? }` (id = model id inside the provider)
- [x] `ModelCatalogEntry` = `{ id: "provider/model-id", provider, modelId, name, current }`
- [x] `ModelCatalog` = `{ entries, visible, truncated, currentId, total }`
- [x] `buildModelCatalog(models, currentId, limit = 20)` — deterministic sort (current first, then
      provider, then model id), `visible` capped at `limit`, `truncated` flag set when capped
- [x] `resolveModelSelection(catalog, query)` → `exact` | `ambiguous` | `unknown` with the rules in
      PLAN.md (exact qualified id, unique bare id, unique prefix, ambiguous, unknown + suggestions)
- [x] Resolution runs against `entries` (full list), never against the truncated `visible` list
- [x] `buildModelListEmbed(catalog)` → plain embed payload (title, description, fields, color)
- [x] `formatModelListText(catalog)` → plain-text fallback
- [x] No `undefined` / `NaN` / empty-string output; a missing name falls back to the model id
- [x] Unit tests in `extensions/__tests__/model-control.test.ts`

## Phase 2 — Command definitions, registration, handlers

- [x] `PI_ABORT_COMMAND` — name `pi-abort`, `type: 1`, description ≤ 100 chars
- [x] `PI_MODEL_COMMAND` — name `pi-model`, `type: 1`, one optional string option `model`
      (`type: 3`, `required: false`, `autocomplete: true`)
- [x] `registerPiCommands(client, token, guildId, commands[])` — upsert each command **by name**;
      the guild's other commands are never deleted or replaced (no bulk `set`)
- [x] `registerPiStatusCommand` keeps working (existing tests must stay green) — implemented as a
      thin wrapper over the generic registration
- [x] Registration failure (missing `applications.commands` scope) still yields the re-invite hint
- [x] `handlePiAbortInteraction` — allow-list gate → `deferReply({ ephemeral: true })` → typed
      outcome (`aborted` | `idle` | `no_session` | `unsupported`) → ephemeral reply
- [x] `handlePiModelInteraction` — allow-list gate → ephemeral defer → list (no argument) or
      resolve + switch (with argument); every outcome replies ephemerally
- [x] `handlePiModelAutocomplete` — filters candidates by the typed value, ≤ 25 choices, never
      throws
- [x] No reply contains the bot token, the system prompt, a raw provider error or file contents
      (the typed model id is **not** echoed back either — see `repair-report-2.md`, N2)
- [x] Unit tests in `extensions/__tests__/slash-control.test.ts` (fake client/interaction, no network)

## Phase 3 — Wiring in `extensions/index.ts`

- [x] All three commands registered on connect (and after reconnect), idempotently, per-command
      error reporting; a registration failure stays non-fatal
- [x] `interactionCreate` routes by `commandName`; the autocomplete branch is handled **before** the
      `isChatInputCommand()` check
- [x] `abortCurrentRun()` — no session → `no_session`; ctx gone → `unsupported`; not running →
      `idle`; otherwise reject the pending Discord question **and** `ctx.abort()` → `aborted`
- [x] `listSessionModels()` — `ctx.scopedModels` when non-empty, else
      `ctx.modelRegistry.getAvailable()` filtered by `hasConfiguredAuth`; every read guarded
- [x] `switchSessionModel(id)` — resolve the model object, `pi.setModel(model)`; `false` → `no_auth`;
      exception → `failed` (raw error stays in the local log)
- [x] A successful switch is picked up by the existing `model_select` tracking, so `/pi-status`
      shows the new model
- [x] `/pi-abort` never ends the session, deletes the channel or disconnects the bot
- [x] Exported pure helpers are unit-testable (pattern of `readAgentIdleSafe` etc.)

## Phase 4 — Autocomplete, docs, validation

- [x] Autocomplete wired end-to-end (option definition → registration → `isAutocomplete()` branch)
- [x] README documents `/pi-abort` and `/pi-model` (behavior, outcomes, allow-list, hub mode)
- [x] `npm test` — all tests pass (306)
- [x] `npm run check` — tsc --noEmit clean
- [x] `npm run build` — tsc clean
- [x] `git diff --check` — clean
- [x] `git status` — only the intended files changed

## Phase 5 — Independent review & acceptance

- [x] Fresh read-only review of the whole diff (new module, slash.ts, index.ts, tests, README)
      → `review.md`, verdict **CHANGES REQUIRED** (3 × P1, 3 × P2)
- [x] Reviewer findings triaged; every P0/P1 blocker repaired and re-reviewed
      → all findings repaired (`repair-report-2.md`); the negative controls prove each regression
      fails without its fix; the re-review (`repair-review.md`) confirmed N1–N6 closed and raised
      2 new findings (N7, N8), which were repaired too; the final review (`final-review.md`)
      returned **ACCEPT** with no remaining findings
- [x] Parent re-runs the full validation after the last repair (306 tests, typecheck, build,
      diff check — all clean)
- [ ] Parent decides on commit + push (no push without the user's go-ahead)

## Validation checklist

- [x] `timeout 300s npm test`
- [x] `timeout 120s npm run check`
- [x] `timeout 180s npm run build`
- [x] `git diff --check`
- [x] No new runtime dependency added (discord.js only)

## Rollback notes

- The branch is additive: reverting the branch drops the two commands and leaves `/pi-status`
  untouched. Commands already registered in the guild stay registered until they are deleted in
  the Discord client — they then answer with the "no session connected" / "unknown command" path, so a
  rollback should also delete the two guild commands (documented in the README).

## Done definition

- [x] All phase checkboxes above are ticked (except the commit/push decision).
- [x] `npm test`, `npm run check`, `npm run build` pass on the branch tip.
- [x] Independent review accepted with no open P0/P1 findings (`final-review.md` → ACCEPT).
- [x] Parent has validated the diff and reported the outcome; the commit/push decision is the
      parent's (and the user's) to make.
