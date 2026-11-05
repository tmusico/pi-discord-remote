# CHECKLIST — Discord `/pi-abort` and `/pi-model` slash commands

## Objective

Ship two additional guild-scoped, ephemeral Discord slash commands — `/pi-abort` (stop the current
agent run, session survives) and `/pi-model` (list the usable models / switch the active model) —
without changing `/pi-status` behavior, without leaking secrets, and without touching the guild's
other commands.

Branch: `feat/slash-control` (cut from `feat/slash-status`). `main` untouched. Parent owns the
commit + push.

## Phase 1 — Pure model-control module

- [ ] `extensions/model-control.ts` exists, imports nothing from discord.js or pi
- [ ] `ModelLike` = `{ provider, id, name? }` (id = model id inside the provider)
- [ ] `ModelCatalogEntry` = `{ id: "provider/model-id", provider, modelId, name, current }`
- [ ] `ModelCatalog` = `{ entries, visible, truncated, currentId, total }`
- [ ] `buildModelCatalog(models, currentId, limit = 20)` — deterministic sort (current first, then
      provider, then model id), `visible` capped at `limit`, `truncated` flag set when capped
- [ ] `resolveModelSelection(catalog, query)` → `exact` | `ambiguous` | `unknown` with the rules in
      PLAN.md (exact qualified id, unique bare id, unique prefix, ambiguous, unknown + suggestions)
- [ ] Resolution runs against `entries` (full list), never against the truncated `visible` list
- [ ] `buildModelListEmbed(catalog)` → plain embed payload (title, description, fields, color)
- [ ] `formatModelListText(catalog)` → plain-text fallback
- [ ] No `undefined` / `NaN` / empty-string output; a missing name falls back to the model id
- [ ] Unit tests in `extensions/__tests__/model-control.test.ts`

## Phase 2 — Command definitions, registration, handlers

- [ ] `PI_ABORT_COMMAND` — name `pi-abort`, `type: 1`, description ≤ 100 chars
- [ ] `PI_MODEL_COMMAND` — name `pi-model`, `type: 1`, one optional string option `model`
      (`type: 3`, `required: false`, `autocomplete: true`)
- [ ] `registerPiCommands(client, token, guildId, commands[])` — upsert each command **by name**;
      the guild's other commands are never deleted or replaced (no bulk `set`)
- [ ] `registerPiStatusCommand` keeps working (existing tests must stay green) — implemented as a
      thin wrapper over the generic registration
- [ ] Registration failure (missing `applications.commands` scope) still yields the re-invite hint
- [ ] `handlePiAbortInteraction` — allow-list gate → `deferReply({ ephemeral: true })` → typed
      outcome (`aborted` | `idle` | `no_session` | `unsupported`) → ephemeral reply
- [ ] `handlePiModelInteraction` — allow-list gate → ephemeral defer → list (no argument) or
      resolve + switch (with argument); every outcome replies ephemerally
- [ ] `handlePiModelAutocomplete` — filters candidates by the typed value, ≤ 25 choices, never
      throws
- [ ] No reply contains the bot token, the system prompt, a raw provider error or file contents
- [ ] Unit tests in `extensions/__tests__/slash-control.test.ts` (fake client/interaction, no network)

## Phase 3 — Wiring in `extensions/index.ts`

- [ ] All three commands registered on connect (and after reconnect), idempotently, per-command
      error reporting; a registration failure stays non-fatal
- [ ] `interactionCreate` routes by `commandName`; the autocomplete branch is handled **before** the
      `isChatInputCommand()` check
- [ ] `abortCurrentRun()` — no session → `no_session`; ctx gone → `unsupported`; not running →
      `idle`; otherwise reject the pending Discord question **and** `ctx.abort()` → `aborted`
- [ ] `listSessionModels()` — `ctx.scopedModels` when non-empty, else
      `ctx.modelRegistry.getAvailable()` filtered by `hasConfiguredAuth`; every read guarded
- [ ] `switchSessionModel(id)` — resolve the model object, `pi.setModel(model)`; `false` → `no_auth`;
      exception → `failed` (raw error stays in the local log)
- [ ] A successful switch is picked up by the existing `model_select` tracking, so `/pi-status`
      shows the new model
- [ ] `/pi-abort` never ends the session, deletes the channel or disconnects the bot
- [ ] Exported pure helpers are unit-testable (pattern of `readAgentIdleSafe` etc.)

## Phase 4 — Autocomplete, docs, validation

- [ ] Autocomplete wired end-to-end (option definition → registration → `isAutocomplete()` branch)
- [ ] README documents `/pi-abort` and `/pi-model` (behavior, outcomes, allow-list, hub mode)
- [ ] `npm test` — all tests pass
- [ ] `npm run check` — tsc --noEmit clean
- [ ] `npm run build` — tsc clean
- [ ] `git diff --check` — clean
- [ ] `git status` — only the intended files changed

## Phase 5 — Independent review & acceptance

- [ ] Fresh read-only review of the whole diff (new module, slash.ts, index.ts, tests, README)
- [ ] Reviewer findings triaged; every P0/P1 blocker repaired and re-reviewed
- [ ] Parent re-runs the full validation after the last repair
- [ ] Parent decides on commit + push (no push without the user's go-ahead)

## Validation checklist

- [ ] `timeout 300s npm test`
- [ ] `timeout 120s npm run check`
- [ ] `timeout 180s npm run build`
- [ ] `git diff --check`
- [ ] No new runtime dependency added (discord.js only)

## Rollback notes

- The branch is additive: reverting the branch drops the two commands and leaves `/pi-status`
  untouched. Commands already registered in the guild stay registered until they are deleted in the
  Discord client — they then answer with the "no session connected" / "unknown command" path, so a
  rollback should also delete the two guild commands (documented in the README).

## Done definition

- [ ] All phase checkboxes above are ticked.
- [ ] `npm test`, `npm run check`, `npm run build` pass on the branch tip.
- [ ] Independent review accepted with no open P0/P1 findings.
- [ ] Parent has validated the diff and reported the outcome; the commit/push decision is the
      parent's (and the user's) to make.
