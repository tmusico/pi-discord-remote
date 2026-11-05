# PLAN — Discord `/pi-abort` and `/pi-model` slash commands

## Problem

`pi-discord-remote` exposes exactly one Discord slash command, `/pi-status` (read-only snapshot).
Two actions that a remote user needs on a phone have no remote control at all:

- **Stopping a wedged run.** If the agent is looping, stuck in a tool, or waiting on a question,
  the only way out is walking to the terminal. There is no `/abort`.
- **Changing the model.** Switching model from Discord is impossible today; `/pi-status` only
  *reports* the active model. A user on a phone who wants a cheaper/faster model has no way to
  change it mid-session.

Both were proposed during the `/pi-status` discussion ("what else do you think?") but were
explicitly **out of scope** for that task (user decision #4 = "status only"). They are now
authorized as a separate, additive change.

## Goal

Two additional guild-scoped, **ephemeral** Discord slash commands:

| Command | Behavior |
|---------|----------|
| `/pi-abort` | Stop the current agent run. The session, the channel and the bot stay alive. |
| `/pi-model` | No argument → list the models the session can use. With `provider/model-id` → switch the active model. |

Both reuse the `/pi-status` contract: allow-list gate, ephemeral reply in **every** path
(allowed / refused / error), never leaking the bot token, the system prompt, raw provider errors or
file contents, and never injecting anything into the Pi session as a prompt.

## Non-goals

- No `/compact`, `/diff`, `/git`, `/ask`, `/sessions`, `/ping`, `/help`, `/reload` — still out of scope.
- No global (non-guild) command registration; no bulk replacement of the guild's command set.
- No new Pi command, no change to the TUI, no change to how channel messages are injected.
- `/pi-abort` never ends the session, deletes the channel, or disconnects the bot.
- No multi-session support (one bot token = one gateway connection = one live session).
- No changes to `/pi-status` behavior beyond sharing the new registration/routing plumbing.

## Current state

- Branch `feat/slash-status` (pushed: `2e93a8d`, `08d3fe9`); `main` untouched; no PR opened.
- `extensions/slash.ts` — one command definition (`PI_STATUS_COMMAND`), an idempotent
  upsert-by-name registration (`registerPiStatusCommand`), and the ephemeral interaction handler
  `handlePiStatusInteraction`.
- `extensions/status.ts` — pure view model for the status embed (no discord.js import).
- `extensions/index.ts` — owns the discord.js client, tracks `agentBusy`, the active model
  (`model_select` event), a pending `discord_ask_user_question` (`questionResolver` /
  `questionRejecter`), and registers/routes the `/pi-status` interaction.
- Pi APIs available to the extension: `ctx.abort()`, `ctx.isIdle()`, `ctx.scopedModels`,
  `ctx.modelRegistry.getAvailable() / find(provider, id) / hasConfiguredAuth(model)`,
  `pi.setModel(model) → Promise<boolean>`.
- A captured `ctx` **throws** after a session replacement or reload — every ctx read must be
  guarded and fall back to extension-tracked state (existing pattern: `readAgentIdleSafe`,
  `readContextUsageSafe`, `readSessionIdentitySafe`).

## Decisions (parent-owned, user approved "proceed")

| # | Decision |
|---|-----------|
| 1 | Command names are `/pi-abort` and `/pi-model` (same `pi-` prefix as `/pi-status`). |
| 2 | Both replies are ephemeral, exactly like `/pi-status` (including refusals and errors). |
| 3 | Both stay registered in the guild permanently, and answer "no session connected" in hub mode. |
| 4 | `/pi-abort` aborts the **run** only — the session, channel and bot connection survive. |
| 5 | `/pi-model` is read-only by default (list) and mutating only with an explicit `provider/model-id` argument. |
| 6 | Mutating commands are gated by the same `allowedUserIds` allow-list as `/pi-status`. |
| 7 | Model identity is always `provider/model-id`; a bare `model-id` is accepted only when it is unique. |
| 8 | Autocomplete on the `model` option is a P1 (nice on a phone) — never allowed to block the core list/switch path. |
| 9 | Implementation runs on a branch cut from `feat/slash-status` (`feat/slash-control`); `main` is not touched; the parent owns commit + push. |

### Consequence of decision 4 — abort semantics

`ctx.abort()` cancels the in-flight agent turn (the same effect as pressing Escape in the TUI).
It does **not** end the session. A pending `discord_ask_user_question` answer is rejected at the
same time, otherwise the turn would keep waiting for an answer that will never come.

Outcomes the handler must distinguish:

| Outcome | Meaning | User-facing reply |
|---------|---------|-------------------|
| `aborted` | A run was running and was aborted | "🛑 Aborted the current run. The session is still connected." |
| `idle` | Nothing was running | "Nothing is running — there is nothing to abort." |
| `no_session` | Hub mode (bot online, no session) | "No Pi session is connected." |
| `unsupported` | The captured ctx is gone (session replaced / reload) | "⚠️ The session is not available right now." |

### Consequence of decision 5 — model switching

`pi.setModel(model)` returns `false` when the provider has no configured credentials — that must be
reported as "no API key" and never as a generic failure. A successful switch is recorded in the
session history, so it survives a resume; it does not change the configured default model.

## Target outcome

```
/pi-abort        →  (ephemeral)
   🛑 Aborted the current run. The session is still connected.

/pi-model        →  (ephemeral embed)
   🤖 Model    openai-codex/gpt-6.1-sol · thinking: high      ← current
   📋 Available (scoped)  6 models
     ✅ anthropic/claude-sonnet-4-5  — Claude Sonnet 4.5
        openai-codex/gpt-6.1-sol   — GPT-6.1 Sol
        …

/pi-model anthropic/claude-sonnet-4-5  →  (ephemeral)
   ✅ Model switched to anthropic/claude-sonnet-4-5 — Claude Sonnet 4.5
```

## Target architecture

```
extensions/model-control.ts   (NEW — pure, no discord.js, no pi import)
  ModelLike / ModelCatalogEntry / ModelCatalog / ModelSelection types
  buildModelCatalog(models, currentId, limit) → ModelCatalog
  resolveModelSelection(catalog, query)      → exact | ambiguous | unknown
  buildModelListEmbed(catalog)               → embed payload
  formatModelListText(catalog)               → plain-text fallback

extensions/slash.ts           (EXTENDED)
  PI_ABORT_COMMAND, PI_MODEL_COMMAND definitions
  registerPiCommands(client, token, guildId, commands[]) — upsert each by name
  handlePiAbortInteraction(interaction, deps)
  handlePiModelInteraction(interaction, deps)
  handlePiModelAutocomplete(interaction, deps)

extensions/index.ts           (WIRED)
  register all three commands on connect (idempotent, per-command error reporting)
  route interactions by commandName (+ autocomplete branch)
  abortCurrentRun() → PiAbortOutcome
  listSessionModels() → ModelLike[]      (scoped models, else available models with auth)
  switchSessionModel(id) → PiModelSwitchOutcome
```

### Model catalog rules

- A model is identified by `provider/model-id`; the display name is the model's `name` when
  present, otherwise the model id.
- The candidate list is `ctx.scopedModels` when it is non-empty (the session's `--models` /
  `enabledModels` scoping), otherwise `ctx.modelRegistry.getAvailable()` filtered by
  `hasConfiguredAuth`. An empty scoped list means "no scoping → everything is usable".
- Resolution always runs against the **full** candidate list, never against the truncated
  display list.
- Sorting is deterministic: the current model first, then provider, then model id.
- Display is capped (default 20) and the reply says how many models exist in total.

### Model selection rules (`resolveModelSelection`)

| Input | Result |
|-------|--------|
| `provider/model-id` (exact, case-insensitive) | `exact` |
| `model-id` matching exactly one candidate | `exact` |
| `model-id` matching several candidates | `ambiguous` (qualified ids listed) |
| unique prefix of `provider/model-id` or `model-id` | `exact` |
| ambiguous prefix | `ambiguous` |
| nothing matches | `unknown` (+ up to 5 substring suggestions) |

## Risks

| Risk | Mitigation |
|------|------------|
| A captured `ctx` throws after a session replacement / reload | Every ctx read is guarded; failures degrade to a typed outcome (`unsupported`), never a crash |
| `/pi-model` shows a model the session cannot actually use | Prefer scoped models; otherwise filter by configured auth |
| Model list too long for one embed | Cap the display list, report the total, offer plain-text fallback |
| Aborting at the wrong moment (e.g. while a question is pending) | Reject the pending question first, then `ctx.abort()`; report which outcome happened |
| Accidental model switch by typo | Require an explicit argument; unknown input never switches anything |
| Guild command churn | Upsert by name only — never `commands.set(...)`; other bots' commands are untouched |
| Discord API limits | ≤100 char descriptions, ≤25 autocomplete choices, ephemeral replies only |

## Verification approach

- Unit tests with fake clients/interactions (no network) — the pattern already used in
  `extensions/__tests__/slash.test.ts`.
- New pure-logic tests for the catalog/resolution module.
- Handler tests for every outcome of both commands, including the refusal path and the
  "no secrets in the reply" invariant.
- `npm test`, `npm run check` (tsc --noEmit), `npm run build` (tsc) must all pass.
- `git diff --check` clean.
- Independent read-only review (fresh context) before acceptance.

## Acceptance criteria

1. `/pi-abort` is registered in the guild, is ephemeral on every path, and aborts a running turn
   without ending the session, deleting the channel or disconnecting the bot.
2. `/pi-model` lists the usable models with the current one marked, and switches the active model
   when given an exact `provider/model-id` (or an unambiguous bare `model-id`).
3. Unknown / ambiguous input never switches a model and always explains what to do next.
4. Both commands honor `allowedUserIds`; refusals are ephemeral and leak nothing.
5. No reply contains the bot token, the system prompt, a raw provider error or file contents.
6. The guild's other commands are never deleted or replaced.
7. `npm test`, `npm run check`, `npm run build` pass; `git diff --check` is clean.
8. README documents both commands.

## Out of scope

- `/compact`, `/diff`, `/git`, `/ask`, `/sessions`, `/ping`, `/help`, `/reload`.
- Global command registration, per-user command permissions beyond the existing allow-list.
- Changing the thinking level remotely (a `/pi-model` option may propose it later).
- Any deployment, publishing or version bump of the npm package.
