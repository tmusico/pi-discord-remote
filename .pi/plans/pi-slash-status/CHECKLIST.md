# CHECKLIST — Discord `/pi-status` slash command

## Objective

Ship a guild-scoped, ephemeral `/pi-status` slash command that reports the live state of the
connected Pi session (state, model, thinking level, project/git, context usage, session identity,
Discord health), answers "no session connected" when no session is bound, and never leaks secrets.

## Phase 1 — Pure status view model

- [x] `extensions/status.ts` exists with no discord.js import
- [x] Session-state union type: `no_session | idle | working | waiting | error`
- [x] `buildStatusView(state)` maps raw state → view model (pure)
- [x] `buildStatusEmbed(view)` returns a plain embed object (title, description, fields, color)
- [x] `formatStatusText(view)` returns a plain-text fallback
- [x] Unknown / missing values render as `unknown`, never `undefined` / `NaN` / crash
- [x] Unit tests in `extensions/__tests__/status.test.ts` cover every state + missing-field case

## Phase 2 — Command definition, registration, interaction handler

- [x] Command name is exactly `pi-status`, guild-scoped, description present
- [x] Registration is idempotent: fetch existing guild commands, update `pi-status` if present,
      create otherwise; never bulk-`PUT` the whole command set
- [x] Registration errors are caught; a missing `applications.commands` scope produces a clear
      message with the re-invite URL
- [x] `handlePiStatusInteraction` gates on `allowedUserIds`
- [x] Handler calls `deferReply({ ephemeral: true })` before any slow work, then `editReply`
- [x] Handler replies ephemerally in every path (allowed, refused, error)
- [x] Handler never emits the bot token, system prompt, or raw file contents
- [x] Tests in `extensions/__tests__/slash.test.ts` use fake client/interaction objects (no network)

## Phase 3 — Wiring in `extensions/index.ts`

- [x] `client.on("interactionCreate", ...)` routes `pi-status` to the handler
- [x] `model_select` event tracks the active model (fallback for stale `ctx`)
- [x] `agent_start` / `agent_end` track run state + elapsed time + last tool name
- [x] Outstanding `discord_ask_user_question` answer ⇒ `waiting` state
- [x] `lastPromptAt` tracked on inbound Discord messages
- [x] Command registered on connect (after `ready`); failure is non-fatal
- [x] `stop` → delete channel, clear session state, stay connected (hub mode) when `keepOnline`
- [x] Hub mode ignores all channel messages (no active session channel)
- [x] New `disconnect` Pi command fully destroys the client
- [x] `session_shutdown` still destroys the client
- [x] `keepOnline?: boolean` added to `Config` + default config template

## Phase 4 — Docs and final validation

- [x] README documents `/pi-status`, the `applications.commands` scope + re-invite URL,
      hub mode, `keepOnline`, and `disconnect`
- [x] README keeps existing setup instructions accurate
- [x] `npm run check` passes
- [x] `npm test` passes (all pre-existing tests still green)
- [x] `npm run build` passes
- [x] `git diff --check` clean

## Validation checklist

- [x] `timeout 180s npm run check`
- [x] `timeout 180s npm test`
- [x] `timeout 180s npm run build`
- [x] `git diff --check`
- [ ] Manual: `/pi-status` in the guild (user-owned step; bot must be re-invited with
      `applications.commands` if the command does not appear)

## Rollout order

1. Merge implementation + tests + docs to the branch.
2. User re-invites the bot with `scope=bot applications.commands` (one-time).
3. User runs `/pi-discord-remote start`, then `/pi-status` in the guild.

## Rollback notes

- Reverting the commit removes the command handler; the guild command may linger as an
  unresponsive entry until the bot is re-invited or the command is deleted manually
  (`client.application.commands.delete(guildId, id)`).
- Set `keepOnline: false` in the config to restore the pre-change `stop` behavior immediately.

## Done definition

- [x] All Phase 1–4 boxes checked
- [x] Independent review accepted the change with no blocking findings
- [ ] No commit/push performed without explicit user approval
