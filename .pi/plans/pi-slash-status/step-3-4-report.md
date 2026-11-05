# Step 3–4 report — wiring `/pi-status` into the extension + README

Branch: `feat/slash-status` — **no git writes performed** (no commit/push/add/checkout/stash/branch).
`package.json` / `package-lock.json` untouched (`package-lock.json` was already ` M` before this step).

Files changed by this step:

| File | Change |
|------|--------|
| `extensions/index.ts` | modified — state tracking, `/pi-status` wiring, hub mode, `disconnect` command, `keepOnline` |
| `extensions/config.ts` | modified — `keepOnline?: boolean` + default template |
| `extensions/slash.ts` | modified (**2 lines + 1 doc block**) — `buildState` may now be async (see §4) |
| `extensions/__tests__/status-tracking.test.ts` | **new** — 26 tests for the pure helpers |
| `extensions/__tests__/config.test.ts` | extended — 2 new tests for `keepOnline` (existing tests untouched) |
| `extensions/__tests__/slash.test.ts` | extended — 1 new test for the async snapshot provider |
| `README.md` | modified — `/pi-status`, OAuth scope + re-invite URL, hub mode, `keepOnline` |

`extensions/status.ts` was **not** modified. `extensions/__tests__/status.test.ts` was not modified.

---

## 1. Behaviour changes (exact)

### 1.1 `/pi-discord-remote stop` — now "end the session", not "disconnect"

Old: delete channel → `client.destroy()` → `activeConfig = null` → "Disconnected from Discord."

New:

- Always: `isShuttingDown = true`, `sessionActive = false`, reconnect timer cleared,
  `reconnectAttempt = 0`, `reconnectFailed = false`, a pending `discord_ask_user_question`
  is **rejected** (`cancelPendingQuestion()` → the agent turn is not left hanging),
  the session channel is deleted, and the session state is cleared
  (`pendingReplyChannelId`, `pendingReplyUserId`, `collectedAssistantText`, `agentBusy`,
  `runStartedAt`, `lastToolName`, `lastError`).
- **`keepOnline !== false` (default) → hub mode:** the Discord client stays connected,
  `activeConfig` / `connectNotify` / `connectSetStatus` are kept (so the allow-list and the
  reconnect logic still work), `isShuttingDown` is reset to `false`,
  the TUI status becomes `🟠 Discord: online (no session)` and the notification reads:
  *"Session ended — channel deleted. The bot stays online so /pi-status keeps working.
  Run /pi-discord-remote disconnect to log out completely."*
- **`keepOnline === false` → old behaviour:** full teardown (`client.destroy()`,
  `activeConfig = null`, `runtime.* = null`, `connectNotify/connectSetStatus = null`).

### 1.2 `/pi-discord-remote disconnect` — new command (full teardown)

Same teardown as today's `stop`: `isShuttingDown = true`, `sessionActive = false`, reconnect
timer cleared, `reconnectAttempt/reconnectFailed` reset, pending question rejected, channel
deleted, session state cleared, `client.destroy()`, `client = null`, `activeConfig = null`,
`runtime.activeChannelId/sessionChannelName = null`, `connectNotify/connectSetStatus = null`.
Notification: *"Disconnected from Discord. Channel deleted."*

### 1.3 `/pi-discord-remote start` in hub mode

`start` while the bot is online **without** a session (hub mode) now tears the idle
connection down and connects again with a fresh session channel (notification
*"Reconnecting with a new session channel…"*). Without this, `start` would have been
permanently blocked by the pre-existing *"Already connected to Discord."* guard.
`start` while a session **is** active still answers *"Already connected to Discord."*

### 1.4 `session_shutdown` — unchanged behaviour, extended cleanup

The client is still destroyed exactly as before. The only addition: the new session-scoped
tracking values are cleared (`clearSessionState()`), and `sessionActive = false`.
The `reason === "reload"` early return is untouched.

### 1.5 Hub mode: no message is ever injected

`buildMessageHandler` is unchanged except for a comment: it still returns early on
`message.channelId !== runtime.activeChannelId`. In hub mode `runtime.activeChannelId === null`,
so the comparison is true for every real channel id → **no message is injected**, and the
`questionResolver` branch (which sits *after* that check) can never fire without an active
session.

Two agent-facing handlers were switched from `client?.isReady()` to the new
`hasActiveSession()` (= `client?.isReady() && runtime.activeChannelId`):

- `tool_call` interception of `ask_user_question`
- `before_agent_start` system-prompt hint

**Why (deviation, see §5):** in hub mode the bot stays connected, so the old check kept
blocking the TUI `ask_user_question` dialog and kept telling the LLM to use
`discord_ask_user_question` — which cannot work without a session channel (it would return
`no_ui` and the LLM would have no way to ask the user). With `hasActiveSession()` the TUI
dialog works again in hub mode, exactly like when Discord is not connected at all.

### 1.6 New state tracking (module/extension level)

| Variable | Set by | Cleared by |
|----------|--------|------------|
| `activeModel` | `model_select` (`event.model.provider/id/name`), seeded from `ctx.model` on `session_start` | — (replaced on the next model switch) |
| `runStartedAt` | `agent_start` | `agent_end`, `clearSessionState()` |
| `lastToolName` | `tool_execution_start` (`event.toolName`) | `tool_execution_end` |
| `lastPromptAt` | `buildMessageHandler`, right before `pi.sendUserMessage()` | — (kept after `stop`, it is history) |
| `lastError` | `agent_end` (only when the run failed / was aborted) | next successful `agent_end`, `clearSessionState()` |
| `sessionCwd` | `startClient` (the `cwd` of the connected session), fallback `ctx.cwd` on `session_start` | — |
| `capturedCtx` | `session_start`, refreshed on every `agent_start` | — |
| `gitCache` | git lookup, 5 s TTL | reset on `start` |

### 1.7 `/pi-status` wiring

- **Registration** — after the client is `ready`, `await registerPiStatusCommand(client, cfg.token, cfg.guildId)`
  is called in `startClient` **and** in the reconnect path `attemptReconnect` (idempotent upsert,
  never a bulk replace of the guild command set). On failure the error is logged with
  `console.error` **and** surfaced via `ctx.ui.notify` (warning) + `ctx.ui.setStatus`
  (`⚠️ Discord: /pi-status unavailable`), including the re-invite hint returned by
  `registerPiStatusCommand`. **Non-fatal** — the extension keeps working without the command.
- **Interaction handling** — `client.on("interactionCreate", …)` is attached in **one** place
  (`attachInteractionHandler(client)`), called from both `startClient` and `attemptReconnect`.
  Only chat-input interactions named `pi-status` are routed to
  `handlePiStatusInteraction(interaction, { allowedUserIds: activeConfig?.allowedUserIds, buildState: buildStatusState })`.
  Every other interaction is ignored (no reply, nothing injected into the Pi session).
- **Snapshot** — `buildStatusState(): Promise<StatusState>` assembles: state (pure precedence
  helper), model id/name/provider, thinking level (`pi.getThinkingLevel()`), `cwd`, git
  branch/SHA/dirty count, context usage (`ctx.getContextUsage()`), session id/name/entry count
  (`ctx.sessionManager`), Discord channel name/id, bot tag (`client.user?.tag`),
  reconnect attempts, last prompt / run start / last tool / error message.
- **Every `ctx` access is wrapped** (`safeCall` helper). A captured ctx throws after
  `ctx.newSession()` / `ctx.reload()`; a stale ctx degrades to the tracked values.
  `ctx.isIdle()` is read defensively and only refines the `working` state
  (`agentBusy || ctx.isIdle() === false`).
- **`buildStatusState()` never throws** — the whole body is in a `try/catch`; on failure it
  returns the minimal `{ state, errorMessage }` snapshot.
- **Git lookup** — `execFile("git", …)` with `cwd`, hard timeout **2000 ms**, three cheap calls
  in parallel (`rev-parse --abbrev-ref HEAD`, `rev-parse --short HEAD`, `status --porcelain`),
  result cached for **5 s** (keyed by cwd). Any failure (not a repo, git missing, timeout)
  yields `null` values — it never throws.

### 1.8 TUI `/pi-discord-remote status`

The existing Discord-connection lines are kept verbatim and two lines were added, built from
the **same** `buildStatusState()` snapshot as `/pi-status`:

```
   Session: 🟢 Idle — ready for instructions
   Model: openai-codex/gpt-6.1-sol · thinking: high
```

### 1.9 Help text

`/pi-discord-remote` help now lists `disconnect` and the new `stop` semantics:

```
/pi-discord-remote setup       — configure bot token, guild, category
/pi-discord-remote start       — create channel + connect
/pi-discord-remote stop        — delete channel, stay online for /pi-status
/pi-discord-remote disconnect  — delete channel + disconnect completely
/pi-discord-remote status      — show connection state
/pi-discord-remote open-config — edit config JSON
```

### 1.10 `extensions/config.ts`

- `Config.keepOnline?: boolean` — *"Keep the Discord connection alive after `/pi-discord-remote stop`
  (hub mode) … Default: true."*
- `defaultConfigTemplate()` now contains `"keepOnline": true`.
- The env-var fallback config (`loadConfig`) also sets `keepOnline: true`.
- The interactive `setup` command writes `keepOnline: true`.

---

## 2. Exported helpers added (for testing)

All in `extensions/index.ts` (module level, pure, no Discord dependency):

```ts
export interface SessionStateInput {
  hasSession: boolean;        // a session channel is bound
  questionPending: boolean;   // a discord_ask_user_question answer is outstanding
  reconnectFailed: boolean;   // the reconnect gave up
  lastError: string | null;   // short message of the last failed turn
  agentBusy: boolean;         // the agent is running a turn
}
export function resolveSessionState(input: SessionStateInput): SessionState;
// precedence: waiting > error > working > idle > no_session

export interface GitStatusInfo {
  branch: string | null;
  sha: string | null;
  dirtyCount: number | null;  // null = unknown, 0 = clean tree
}
export function countDirtyFiles(porcelain: string | null | undefined): number | null;
export function parseGitStatusInfo(raw: {
  branch?: string | null;      // raw `git rev-parse --abbrev-ref HEAD` output
  sha?: string | null;         // raw `git rev-parse --short HEAD` output
  porcelain?: string | null;   // raw `git status --porcelain` output
}): GitStatusInfo;

export function describeTurnFailure(event: unknown): string | null;
// → short (≤200 chars) message when the last run failed/aborted, else null
```

`buildStatusState()` itself is **not** exported (it is closure state inside the extension
factory) — it is exercised indirectly through `handlePiStatusInteraction`.

---

## 3. Tests

`extensions/__tests__/status-tracking.test.ts` (new, 26 tests):

- `resolveSessionState` — every state and every precedence pair
  (waiting > error > working > idle > no_session).
- `countDirtyFiles` — `null`/`undefined` → `null`, clean tree → `0`, modified/deleted/untracked
  counted, a rename counted as one file, blank lines ignored.
- `parseGitStatusInfo` — raw `rev-parse` / `status --porcelain` output → `{branch, sha, dirtyCount}`,
  git failure → all `null`, empty output → `null`/`0`, multi-line output → first line only.
- `describeTurnFailure` — normal run → `null`, aborted → `"aborted"`, error → provider message,
  abort-like message detection, 200-char truncation, non-assistant messages ignored.

Extended (existing tests untouched):

- `extensions/__tests__/config.test.ts` — new `describe("keepOnline")`: the default template
  contains `keepOnline: true`; `keepOnline` is optional on `Config`.
- `extensions/__tests__/slash.test.ts` — new test: an **async** `buildState` is awaited and
  rendered (`deferReply` → `editReply`).

No test touches the discord.js client (as required).

---

## 4. ⚠️ Change to `extensions/slash.ts` (report prominently)

`extensions/slash.ts` was modified — **2 code lines + 1 doc comment**. The exported names are
unchanged (`PI_STATUS_COMMAND`, `registerPiStatusCommand`, `handlePiStatusInteraction`, …) and
the change is backwards compatible (existing sync callers and all pre-existing tests still pass).

```diff
 export interface PiStatusInteractionDeps {
   allowedUserIds?: string[];
-  buildState: () => StatusState;
+  buildState: () => StatusState | Promise<StatusState>;
 }
…
-    const view = buildStatusView(deps.buildState());
+    const view = buildStatusView(await deps.buildState());
```

**Why (genuine defect):** the plan requires *"deferReply() first, editReply() after the (git)
lookup completes"* and *"git calls are bounded (≤2 s timeout) and cached for ~5 s so repeated
`/pi-status` calls do not re-hit git"*. With the strictly synchronous `buildState` contract the
caller could **not** perform the bounded, cached `execFile` git lookup inside the deferred
interaction window — it could only return a stale/pre-cached value, or block the event loop
with `spawnSync`. The widening is the minimal fix: `await` works with both sync and async
providers, so every existing caller and test is unaffected.

---

## 5. Deviations from the plan / task text (and why)

1. **`buildState` may be async** (see §4) — required to run the bounded git lookup after
   `deferReply()`.
2. **`hasActiveSession()` instead of `client?.isReady()`** in the `tool_call` interception and
   the `before_agent_start` hint — otherwise hub mode breaks the TUI `ask_user_question` flow
   (the LLM would be told to use a Discord tool that cannot work). Documented in the README.
3. **`start` in hub mode reconnects** (fresh login + new channel) instead of reusing the idle
   connection — otherwise `start` would be permanently blocked by the pre-existing
   *"Already connected to Discord."* guard. Reusing the connection would have required
   extracting the channel-creation block out of the `ready` handler (bigger diff, more risk).
4. **`lastToolName` is cleared on `tool_execution_end`** (as instructed) — it therefore shows
   the tool that is *currently* executing, not the last one that ran.
5. **`clearSessionState()` also clears `lastToolName`** (one value beyond the list in the
   task) — it is run-scoped state, so a stopped session must not inherit it.
6. **A pending `discord_ask_user_question` is rejected on `stop` / `disconnect`** — otherwise
   the agent turn would hang forever waiting for an answer that can no longer arrive.
7. **Connect-race guard (`sessionActive`)** — in hub mode `stop` no longer destroys the
   client, so a `ready` event arriving after the stop would have created a channel for a
   session that was already ended. The `ready` handler now checks `sessionActive`.
8. **Re-registration after a reconnect** — `attemptReconnect` also calls
   `registerStatusCommand` (idempotent) so the command still exists if it was deleted.
9. **Reconnect label** — `runtime.sessionChannelName ?? runtime.activeChannelId ?? "hub (no session)"`
   instead of `"unknown"` so the reconnect notice is meaningful in hub mode.
10. **`discord_send_image` in hub mode** — untouched: it may still send to a *configured*
    `channelId` if one is set (the tool is an explicit LLM call, not an inbound message).
    Inbound channel messages are always ignored in hub mode.

---

## 6. Validation (verbatim)

```
===== npm run check =====
> pi-discord-remote@0.2.4 check
> tsc --noEmit
(no output — clean)

===== npm test =====
> pi-discord-remote@0.2.4 test
> vitest run

 RUN  v4.1.6 /home/tony/code/personal/pi-discord-remote

 Test Files  6 passed (6)
      Tests  143 passed (143)
   Start at  08:09:45
   Duration  673ms (transform 458ms, setup 0ms, import 1.13s, tests 217ms, environment 1ms)

===== npm run build =====
> pi-discord-remote@0.2.4 build
> tsc
(exit 0)

===== git diff --check =====
(no output — clean, exit 0)
```

Test counts: **114 before → 143 after** (29 new: 26 in `status-tracking.test.ts`,
1 in `slash.test.ts`, 2 in `config.test.ts`). **All pre-existing tests are green and
unmodified.**

`dist/` was produced by `npm run build` and **deleted again** afterwards (it was not in the
working tree before this step; leaving it would double the vitest test count because vitest
also collects `dist/__tests__/*.test.js`).

⚠️ **Pre-existing test hazard (not introduced by this step):** the test suite writes to the
*real* config path `~/.pi/agent/pi-discord-remote/config.json` and several pre-existing
tests delete that file (`saveConfig writes valid JSON`, `loadConfig reads a previously saved
config`). The **new** `keepOnline` test added in this step backs the file up and restores it
afterwards, so it does not destroy a user config. The older tests still do — worth fixing
separately.

---

## 7. README diff summary

`README.md` (+48 / −7 lines):

- **Bot setup** — new step 4: the bot must be invited with the **`applications.commands`**
  scope; ready-to-use re-invite URL
  `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=274145945856`
  (`<APP_ID>` = *Application ID*, not the bot user id) + the note that the command only
  appears in the guild the bot was invited to.
- **Usage** — `stop` reworded to *"end the session (channel deleted), bot stays online"*, new
  `disconnect` line.
- **New section `/pi-status` (Discord slash command)** — one-line description of the content
  (state / model / thinking level / project + git / context / session / Discord health),
  the **ephemeral** note (only the invoking user sees the reply), and the guarantee that
  nothing is injected into the session and no token/prompt/file content is printed.
- **New section "Hub mode (bot online without a session)"** — `stop` keeps the connection so
  `/pi-status` can answer *"no session connected"*, all channel messages are ignored,
  `disconnect` logs out completely, `keepOnline: false` restores the old behaviour,
  `start` in hub mode reconnects with a new channel.
- **Config reference table** — new row `keepOnline | boolean | true | …`.
- **How it works** — `stop` / `disconnect` bullets updated.
- **`ask_user_question` section** — "When Discord is connected" → "While a Discord **session**
  is active", and the fallback sentence now also names hub mode.

---

## 8. What the parent / user must verify manually in Discord

1. **Re-invite the bot** with `scope=bot applications.commands` (URL in the README) — the
   command only appears in the guild the bot was invited to. If the bot was invited without
   the scope, `/pi-discord-remote start` now logs a clear error (TUI + console) including the
   re-invite URL, and the extension keeps working.
2. `/pi-status` while a session is running → embed with state, model, thinking level,
   project + git branch/SHA/dirty count, context usage, session id/name/entries, Discord info.
3. `/pi-status` while the agent waits for a `discord_ask_user_question` answer → state
   `waiting`.
4. `/pi-status` after an aborted turn → state `error` with a short reason; after the next
   successful turn the error clears.
5. `/pi-status` after `/pi-discord-remote stop` → `🟠 No Pi session connected` (bot still online).
6. Send a message in **any** channel while in hub mode → nothing is injected into Pi, no reply.
7. `/pi-discord-remote start` while in hub mode → new session channel is created and works.
8. `/pi-discord-remote disconnect` → the bot goes fully offline (no more `/pi-status` replies).
9. `keepOnline: false` in `config.json` → `stop` disconnects completely (old behaviour).
10. A user **not** in `allowedUserIds` runs `/pi-status` → short ephemeral refusal, no status data.
11. `/pi-discord-remote status` in the TUI shows the same snapshot (session + model lines).
