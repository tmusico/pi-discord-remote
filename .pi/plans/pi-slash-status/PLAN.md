# PLAN — Discord `/pi-status` slash command

## Problem

`pi-discord-remote` gives no read-only way to inspect a running Pi session from Discord. The only
signals are the ⏳ reaction and the eventual reply. From a phone you cannot tell whether the agent
is idle, busy, stuck waiting on a `discord_ask_user_question` answer, running on a different model
than you assumed, or sitting in a different project than the last one.

## Goal

A guild-scoped Discord slash command **`/pi-status`** that replies **ephemerally** with:

- what the session is doing right now — idle / working / waiting-on-you / errored
- the active model + thinking level
- the project + git state the session is working in
- context usage, session identity, and Discord connection health

## Non-goals

- No other slash commands (`/abort`, `/model`, `/compact`, `/diff`, `/sessions`, …).
- No global (non-guild) command registration.
- No public / non-ephemeral status output.
- No change to how channel messages are injected into Pi.
- No multi-session support: one bot token = one gateway connection = one live session.

## Current state (as of `main`)

- `extensions/index.ts` owns the discord.js v14 client. It only handles `messageCreate` inside the
  auto-created session channel; no Discord application command is ever registered.
- `/pi-discord-remote stop` deletes the session channel **and destroys the Discord client**.
- The extension already tracks `agentBusy` (`agent_start` → true, `agent_end` → false) and whether a
  `discord_ask_user_question` answer is outstanding (`questionResolver !== null`).
- The README invite instructions omit the `applications.commands` OAuth scope, so the bot may need a
  re-invite before a slash command can appear.
- Pi exposes live state through `ctx`: `ctx.model`, `ctx.thinkingLevel`, `ctx.getContextUsage()`,
  `ctx.sessionManager.getSessionId() / getSessionName() / getEntries()`, `ctx.isIdle()`.
  A captured `ctx` **throws** after session replacement or reload (`ctx.newSession()`,
  `ctx.reload()`), so every ctx read must be guarded and must fall back to extension-tracked state.

## Decisions (user-confirmed)

| # | Decision |
|---|-----------|
| 1 | Slash commands are in scope; the bot is re-invited with the `applications.commands` scope. |
| 2 | All `/pi-status` replies are ephemeral (only the invoking user sees them). |
| 3 | The command stays registered in the guild permanently. When no Pi session is bound the bot answers "no session connected" instead of failing. |
| 4 | Scope is this command only — no other slash commands. |
| 5 | Command name is `/pi-status` (namespaced to avoid collisions with other bots in the guild). |

### Consequence of decision 3 — "hub mode"

The bot must be able to answer `/pi-status` when no session is running. Discord can only answer an
interaction from a live gateway connection, so after `/pi-discord-remote stop` the extension must
keep the gateway connected while clearing the session (channel deleted, message injection disabled).

- `stop` → delete session channel, clear session state, **stay connected** (hub mode).
- New Pi command `disconnect` → destroy the client completely.
- `session_shutdown` → destroy the client completely (unchanged).
- Config `keepOnline?: boolean` (default `true`) — set `false` to restore the old "stop = full
  disconnect" behavior.
- In hub mode the extension must ignore all channel messages (no session channel exists).
- The guild command is registered once and never deleted, so it survives session restarts.

## Target outcome

```
/pi-status  →  (ephemeral embed)

  🟢 Idle — ready for instructions
  🤖 Model    openai-codex/gpt-6.1-sol · thinking: high
  📁 Project  byow · main @ 4bea19a (3 files dirty)
  🧠 Context  42.1k / 200k tokens (21%)
  🕐 Activity last prompt 12m ago · session 8f3c… · 42 entries
  🔌 Discord  #byow-may09 · as bot#1234 · reconnect attempts 0
```

### Session state model

| State | Meaning | Source |
|-------|---------|--------|
| `no_session` | Bot connected, no Pi session bound (hub mode) | `runtime.activeChannelId === null` |
| `idle` | Session bound, agent not running | `!agentBusy` and `ctx.isIdle()` |
| `working` | Agent running | `agentBusy` / `!ctx.isIdle()`; elapsed since `agent_start`; last tool name |
| `waiting` | Agent blocked on a Discord answer | `questionResolver !== null` (highest priority) |
| `error` | Last turn aborted / reconnect failed | `isAbortLikeError` on last turn, `reconnectFailed` |

### Field sources

| Field | Source | Fallback |
|-------|--------|----------|
| model | `model_select` event (`event.model`) | `ctx.model` (guarded) |
| thinking level | `pi.getThinkingLevel()` | "unknown" |
| state | `agentBusy`, `questionResolver`, `reconnectFailed` | — |
| project / git | `cwd` captured at `start`; `git rev-parse --short HEAD` + `git status --porcelain` via `execFile` | "not a git repo" / "unknown" |
| context usage | `ctx.getContextUsage()` (guarded) | "unknown" |
| session identity | `ctx.sessionManager.getSessionId()` / `getSessionName()` (guarded) | "unknown" |
| Discord | `runtime.activeChannelId`, `runtime.sessionChannelName`, `client.user.tag` | — |
| activity | tracked `lastPromptAt`, `runStartedAt`, `lastToolName` | — |

## Implementation shape

| File | Responsibility |
|------|----------------|
| `extensions/status.ts` (new) | **Pure.** Session-state types, `buildStatusView(state)`, `formatStatusText(view)`, `buildStatusEmbed(view)` → plain embed object. No discord.js import → unit-testable. |
| `extensions/slash.ts` (new) | `/pi-status` command definition, idempotent guild registration (upsert by name, never bulk-PUT over other commands), `handlePiStatusInteraction(interaction, deps)` with allow-list gate + `deferReply` + `editReply`. |
| `extensions/index.ts` (edit) | Track session state; `client.on("interactionCreate")`; register the command on connect; hub mode on `stop`; new `disconnect` command; `keepOnline` config; clear error when the bot lacks the `applications.commands` scope. |
| `extensions/config.ts` (edit) | `keepOnline?: boolean` (+ default template entry). |
| `extensions/__tests__/status.test.ts` (new) | Pure formatter tests. |
| `extensions/__tests__/slash.test.ts` (new) | Registration payload + interaction handler tests using fake client/interaction objects (no network). |
| `README.md` (edit) | Document `/pi-status`, the `applications.commands` scope + re-invite URL, hub mode, `keepOnline`, `disconnect`. |

### Hard rules

- Registration must be **idempotent**: fetch existing guild commands, update the `pi-status` entry
  if present, create it otherwise. Never `PUT` the full command set (it would delete other commands
  registered by the same bot application).
- Never print the bot token, the system prompt, or file contents in a status reply.
- Enforce `allowedUserIds` on interactions exactly like the message handler.
- Every `ctx` access is wrapped in try/catch; a stale ctx degrades to tracked state, never an
  unhandled rejection inside a Discord interaction.
- Every reply path must resolve inside Discord's 3-second interaction window: `deferReply()` first,
  `editReply()` after the (git) lookup completes.
- `git` calls are bounded (≤2s timeout, ≤2 invocations) and never block the reply.

## Risks

| Risk | Mitigation |
|------|------------|
| Bot lacks the `applications.commands` scope → 403 "Missing Access" | Detect the error, log a clear message with the exact re-invite URL (app id + `applications.commands` scope), keep the extension working without the command. |
| Captured `ctx` invalid after `/new` or `/reload` | Guard every read; fall back to tracked state; refresh the captured ctx on `session_start`. |
| Git lookup exceeds the interaction window | `deferReply` before the lookup; 2s timeout; cached for ~5s. |
| `stop` semantics change confuses existing users | `keepOnline` config flag (default true), explicit TUI message, documented in README. |
| Command name collision in the guild | Namespaced `pi-status`; registration is per-guild. |

## Verification approach

1. `npm run check` (tsc --noEmit) — type safety.
2. `npm test` (vitest) — unit tests for the pure formatter, registration payload, and interaction
   handler (fake client/interaction, no network).
3. `npm run build` (tsc) — emits `dist/`.
4. Manual Discord check by the user: `/pi-status` in the guild while a session is running and while
   the bot is in hub mode.

## Acceptance criteria

- [ ] `/pi-status` appears in the guild's command picker and replies ephemerally.
- [ ] The reply shows state (idle / working / waiting / error / no session), model, thinking level,
      project + git, context usage, session identity, and Discord connection info.
- [ ] No session bound → the reply says "no session connected" instead of erroring.
- [ ] Users outside `allowedUserIds` get a short ephemeral refusal and no session data.
- [ ] The reply never contains the bot token, the system prompt, or raw file contents.
- [ ] Registration is idempotent and does not remove other commands of the same bot application.
- [ ] A stale `ctx` degrades gracefully instead of throwing inside the interaction handler.
- [ ] `npm run check && npm test && npm run build` all pass.

## Out of scope

Other slash commands, global command registration, public status posts, multi-session support,
any change to message injection, and any change to the auto-created channel lifecycle beyond the
hub-mode adjustment described above.
