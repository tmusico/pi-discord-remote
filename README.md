# pi-discord-remote

> Control your [Pi](https://pi.dev) coding-agent session from Discord.

![pi-discord-remote demo](demo.gif)

Each time you run `/pi-discord-remote start`, the extension automatically creates a **new Discord text channel** named after your current project + date (e.g. `kaleidoscope-may09`). Messages sent in that channel are injected into Pi as user prompts; Pi's responses are posted back. When you stop, the channel is deleted — keeping your server clean within Discord's channel limit.

## Install

```bash
pi install npm:pi-discord-remote
```

## Bot setup

1. Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications)
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content**
3. Invite the bot to your server with these permissions:
   - Read Messages / View Channels
   - Send Messages
   - Add Reactions
   - **Manage Channels** ← required for auto-create/delete
4. Invite the bot with the **`applications.commands`** scope as well — the `/pi-status`,
   `/pi-abort`, `/pi-model`, `/pi-agents` and `/pi-stop` slash commands only appear when the bot
   was invited with that scope. Re-invite it once with this URL (`<APP_ID>` is the **Application
   ID** from the Developer Portal, not the bot user id):

   ```
   https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=274145945856
   ```

   The command is registered in the guild the bot was invited to — it does not appear in other
   servers.

## Usage

```
/pi-discord-remote setup        — configure token, server ID, optional category
/pi-discord-remote start        — create channel + connect
/pi-discord-remote stop         — end the session (channel deleted), bot stays online
/pi-discord-remote disconnect   — end the session and log out completely
/pi-discord-remote status       — show connection state
/pi-discord-remote open-config  — edit config JSON in Pi's editor
```

### `/pi-status` (Discord slash command)

A read-only status snapshot of the running Pi session, posted **ephemerally** — only the
person who ran the command sees the reply. It shows what the session is doing right now
(idle / working / waiting for your answer / error / no session), the active model and thinking
level, the project directory with its git branch and dirty-file count, context-window usage,
the session identity and the Discord connection health.

Type `/pi-status` in the guild (any channel) — the bot answers with an embed. It never
injects anything into the Pi session and never prints the bot token, the system prompt or
file contents. A failed or aborted turn is reported as a generic label (`aborted`,
`turn failed`) — the provider's raw error text stays in the local log.

When the session is owned by an [OptChat](https://github.com/tony-musico/pi-optchat) profile,
the reply gains one extra **OptChat** field — see
[OptChat integration](#optchat-integration-read-only).

### `/pi-abort` (Discord slash command)

Stops the **running agent turn** — the same effect as pressing Escape in the Pi TUI. The Pi
session, the Discord channel and the bot connection all stay alive, so the session can be used
again right after the abort. The reply is **ephemeral** and says exactly what happened:

| Reply | Meaning |
|-------|---------|
| 🛑 Aborted the current run. The session is still connected. | A turn was running and has been stopped |
| Nothing is running — there is nothing to abort. | The session is idle |
| No Pi session is connected. | Hub mode — the bot is online, but no session is bound |
| ⚠️ The session is not available right now. | The session was replaced or reloaded |

A pending `discord_ask_user_question` is rejected first, so a turn that waits for an answer
cannot hang after the abort.

### `/pi-model` (Discord slash command)

Lists the models the session can use — or switches to one. The reply is **ephemeral**.

- `/pi-model` (no argument) — an embed that lists the usable models (up to 20 entries and
  Discord's embed budget; entries that do not fit are left out). The current model is marked
  with ✅ and the total count is stated when the list does not fit.
- `/pi-model anthropic/claude-sonnet-4-5` — switches the session to that model. A bare model id
  (`claude-sonnet-4-5`) is accepted when it is unique; the option autocompletes with the
  qualified `provider/model-id` values.

The candidate list is the session's own model scope when it has one (`--models` /
`enabledModels`), otherwise every model of the registry that has an API key configured — in that
fallback a model without credentials is never offered. An explicitly scoped model is kept as it
is, so selecting one without credentials reports the missing API key instead of staying hidden.
The scope API is feature-detected: on an older Pi that does not expose it, the list is **not**
scope-filtered and the reply says so (“scope API unavailable — showing all authenticated
models”).

| Reply | Meaning |
|-------|---------|
| ✅ Model switched to provider/model-id — Name (this session) | The switch worked (it is recorded in the session history, so it survives a resume) |
| ❌ Unknown model. | The id matched nothing — nothing was switched (up to 5 similar ids are suggested) |
| ⚠️ That model id matches several models: … | The id was ambiguous — use the full `provider/model-id` |
| ⚠️ No API key configured for provider '…' — the model was not switched. | The provider has no credentials |
| ⚠️ Could not switch the model. | The switch failed (provider details are suppressed — only a generic error category is logged locally) |
| No Pi session is connected. | Hub mode — the bot is online, but no session is bound |

The typed id is never echoed back — only the canonical `provider/model-id` values of the
session's own models are shown, so a pasted secret can never end up in a reply.

The switch applies to the **running session**. Whether it also changes the *configured* default
model depends on the Pi version:

- **Pi ≥ 1.5** — the configured default model is **not** changed. The session only persists the
  global default when the switch is explicitly persisted, and the slash command does not do
  that.
- **Older Pi versions (< 1.5)** — the same call persisted the change unconditionally, so the
  configured default model may become the selected one.

The reply always states “(this session)” so the scope of the change is never ambiguous.

Both new commands honour the same `allowedUserIds` allow-list as `/pi-status`: a user outside
the list gets a short refusal and nothing else.

### `/pi-agents` (Discord slash command)

Lists the **background agents** of the [OptChat](https://github.com/tony-musico/pi-optchat)
profile that owns this session — the subagents OptChat is running, their state, model, age, the
tool running right now and their depth.

The reply is **ephemeral** — only the person who ran the command sees it. The command is
**read-only**: it lists what OptChat published and never starts, stops or steers anything.

```
🔌 Pi Background Agents
2 active · 1 paused · 3 total
profile: work
  running      `abcdef01` · running · openai-codex/gpt-6.1-sol · 3m 20s · 🔧 bash · depth 1
  paused       `fedcba98` · paused · 1m · depth 2
```

| Reply | Meaning |
|-------|---------|
| The agent list | The OptChat profile's background agents |
| ℹ️ No OptChat owner is bound to this session. | OptChat is not running in this same Pi process (see [OptChat integration](#optchat-integration-read-only)) |
| ℹ️ No background agents in the "work" profile. | The owner is bound, but the profile has no subagents |
| ℹ️ The agent list is not available yet — try again in a moment. | The owner just bound; its snapshot has not arrived yet |
| ⚠️ The agent list is unavailable right now. | The snapshot could not be read (provider details stay in the local log) |

At most 20 runs are listed; a longer fleet is truncated and the reply says so. The fleet snapshot
itself never carries task text, titles, paths, transcripts, tool arguments or tool output.

### `/pi-stop` (Discord slash command)

Stops **one background agent** of the OptChat profile that owns this session.

```
/pi-stop abcdef01
```

The `run` option takes a run id — the short prefix `/pi-agents` shows is enough. The reply is
**ephemeral**.

The run is named by its **generation token**: the extension sends back the `startedAt` it saw for
that run, and OptChat refuses a mismatch with `STALE_RUN`. So a run that was resumed in the
meantime is never stopped by mistake.

This needs OptChat's **agent-control gate**: turn on *Events control* in `/optchat settings`, or
start Pi with `--optchat-events-control`. Without it the reply says so.

| Reply | Meaning |
|-------|---------|
| 🛑 Stop requested for the run. | OptChat accepted the stop |
| ⚠️ That run changed generation — run /pi-agents again and retry with the current id. | The run was resumed since the list was read — nothing was stopped |
| That run is no longer running. | The run had already finished |
| ❌ No background agent matches that run id. | The run id matched nothing |
| ❌ That run id matches several agents — use a longer prefix. | The prefix was ambiguous |
| ⚠️ OptChat's agent-control gate is off. | The control gate is off — nothing was sent |
| ℹ️ No OptChat owner is bound to this session. | OptChat is not running in this same Pi process |
| ⚠️ That run cannot be controlled from Discord … | The run is nested or connected — only top-level runs are controllable |
| ⚠️ The outcome is unknown — the stop may or may not have happened. | No result arrived in time — check /pi-agents before retrying |
| ⚠️ The stop could not be completed. | The request failed for another reason |

A run the extension never saw while it was running has no published generation token, so it
cannot be targeted — the reply says so rather than guessing.

### Hub mode (bot online without a session)

`/pi-discord-remote stop` ends the *session* but keeps the Discord connection alive, so
`/pi-status` can still answer with **“no session connected”** (and the reconnect logic keeps
working). In hub mode the extension ignores every channel message — there is no session
channel, so nothing is injected into Pi. `/pi-abort` and `/pi-model` answer **“No Pi session is
connected.”** in hub mode as well — there is no remote session to stop or re-model, and the
model list is only available for a bound session. `/pi-agents` and `/pi-stop` still answer in hub
mode: the agent list comes from the OptChat owner, not from the Discord session.

- `/pi-discord-remote disconnect` — log out completely (destroys the Discord client).
- `/pi-discord-remote start` while in hub mode — reconnects and creates a fresh session channel.
- `keepOnline: false` in `config.json` — restores the old behaviour where `stop` also
  disconnects.

### Setup prompts

| Field | Where to find it |
|-------|-----------------|
| Bot token | Discord Developer Portal → Bot → Token |
| Guild (Server) ID | Right-click server → Copy Server ID (needs Developer Mode) |
| Category ID | Right-click a category → Copy Category ID (optional — channels go to server root otherwise) |
| Allowed user IDs | Right-click a user → Copy User ID (leave empty to allow everyone) |
| Tool responses | Send tool outputs (results/errors) to Discord alongside tool-call labels? (y/n, default: no) |

Config is stored at `~/.pi/agent/pi-discord-remote/config.json`.

### Environment variables (alternative to config file)

For CI or headless setups, you can skip `setup` entirely and set these env vars:

| Variable | Description |
|----------|-------------|
| `DISCORD_TOKEN` | Bot token (overrides config file) |
| `DISCORD_GUILD_ID` | Guild (server) ID |
| `DISCORD_CATEGORY_ID` | Optional category ID |

## Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `token` | string | — | Discord bot token |
| `guildId` | string | — | Discord guild (server) ID |
| `categoryId` | string | — | Optional category for auto-created channels |
| `allowedUserIds` | string[] | `[]` | Allow-list of Discord user IDs (empty = everyone) |
| `reactions` | boolean | `true` | React with ⏳ while processing |
| `toolResponses` | boolean | `false` | Also post tool outputs/results alongside tool-call labels (truncated to ≤400 chars) |
| `keepOnline` | boolean | `true` | Keep the Discord connection alive after `/pi-discord-remote stop` (hub mode, so `/pi-status` still works). `false` = old behaviour (stop also disconnects) |
| `inboundImages` | boolean | `true` | Read image attachments on Discord messages and hand them to the model (images only; resized to ≤2048 px / ≤2 MB, ≤4 per message) |

Edit config with `/pi-discord-remote open-config`.

## How it works

The extension loads silently on Pi startup — no channel is created until you explicitly run the command.

- **`/pi-discord-remote start`** — bot logs in, creates a text channel named `<project>-<mon><dd>-<HHMM>`, and starts listening there only
- **Incoming message** — injected as a user prompt into the active Pi session; bot reacts ⏳ while Pi works, then posts the full response back
- **Tool calls** — each tool invocation is labeled (🔧 bash, 📄 read, ✏️ edit, etc.) with a detail line; if `toolResponses` is on, results follow as ↩️/❌ code blocks
- **`/pi-discord-remote stop`** — the session channel is deleted and the session state is cleared; the bot stays online so `/pi-status` keeps working (set `keepOnline: false` to disconnect as well)
- **`/pi-discord-remote disconnect`** (or Pi exit) — the channel is deleted and the bot disconnects completely

### OptChat integration (read-only)

If [OptChat](https://github.com/tony-musico/pi-optchat) is installed in the **same Pi process**
and has a profile open, `pi-discord-remote` binds OptChat's in-process event contract
(`pi.events`) and adds one **OptChat** field to `/pi-status`:

```
🔌 OptChat  work · working · bash (+2) · 2/4 agents
```

It shows the OptChat profile's name, the main agent's phase
(`idle` / `working` / `responding` / `awaiting-input` / `closing`), the tool that is running right
now, and how many background agents the profile has. The full per-run list is available through
the [`/pi-agents`](#pi-agents-discord-slash-command) command, and one of them can be stopped with
[`/pi-stop`](#pi-stop-discord-slash-command).

The integration is **read-only by default**: it listens and displays. `/pi-stop` is the one
mutation, and it needs OptChat's agent-control gate.

**When it applies.** `pi.events` is local to one Pi process, so the contract is only published when
OptChat is installed *and* owns the profile **in this very process**. It is **not** available for:

- a plain Pi session with no OptChat installed,
- a one-shot run (`pi -p`) or JSON mode,
- a session that *joined* a profile owned by another Pi (`--optchat-connect join`) — the owner lives
  in the other process.

**Degradation.** The extension is unchanged when the contract is absent:

| Situation | Behaviour |
|-----------|-----------|
| OptChat not installed | No OptChat field. Everything else works as before. |
| OptChat installed, no profile open | No OptChat field. |
| OptChat installed, profile open | The OptChat field appears. |
| OptChat's profile is closed or switched | The field disappears again — a stale value is never shown. |

OptChat's consent gates (*Events content* / *Events control* in `/optchat settings`, or the
`--optchat-events-content` / `--optchat-events-control` flags) are **not** needed for this: the
fields above are metadata only. Changing a gate makes OptChat rebuild its integration, which
replaces the owner with a new one — `pi-discord-remote` rebinds to the new owner and drops the
previous owner's data.

Live streaming of assistant output and history reads are deliberately **not** implemented here. The
background-agent list (`/pi-agents`) and the agent-control command (`/pi-stop`) are the two
Discord-facing additions.

### Reading images from Discord

The other direction works on its own: **an image you attach to a Discord message is handed to
the model**, alongside your text.

```
[you]      what is broken here?   📎 screenshot.png
[agent]    The stack trace shows …                        ← it saw the screenshot
```

- The image is resized to **≤2048 px** and **≤2 MB** before it goes into the prompt.
- Your text is passed through **verbatim**. A message with no text at all gets a structural
  `[1 image attachment]` marker, so the turn still fires.
- At most **4 images** are read per message; an attachment larger than **10 MB** is skipped
  without being downloaded.
- Only **images** are supported — Pi's user message takes image content, not other file types.
- When something is skipped, the bot says so in the channel, e.g.
  `⚠️ Skipped attachment: screenshot.png (too large (12.0 MB, limit 10.0 MB))` — otherwise the
  agent would just report that it cannot see the image.

Set `"inboundImages": false` in the config to turn it off.

### Optional image skill tool

Image forwarding is **not automatic** in `pi-discord-remote`.

If you want to send an image, use the explicit `discord_send_image` tool (opt-in):
- optional `channelId` (recommended for deterministic targeting)
- source by local `path`
- or source by `url`
- or source by `base64` (+ optional `mediaType`)

Exactly one source should be provided per call. If omitted, the tool falls back to the latest `agent_browser` image artifact path.

`/pi-discord-remote status` now shows the active **Channel ID** so you can pass it directly to `discord_send_image`.

The tool returns explicit send errors (for example `unknown_channel:<id>` or timeout/HTTP errors) instead of silently forwarding images.

### `ask_user_question` → Discord

Pi's TUI-only `ask_user_question` dialog (from `@juicesharp/rpiv-ask-user-question`) is invisible over Discord remote. While a Discord **session** is active, pi-discord-remote:

1. **Blocks** the original `ask_user_question` via `tool_call` event interception — the TUI dialog never appears
2. **Registers** `discord_ask_user_question` — a drop-in replacement that formats questions as Discord messages and collects answers from the channel
3. **Hints** the LLM via `before_agent_start` to prefer `discord_ask_user_question` when a Discord session is active

When no Discord session is active (not connected, or hub mode after `/pi-discord-remote stop`), the original `ask_user_question` (TUI dialog) works normally as a fallback. No need to uninstall `@juicesharp/rpiv-ask-user-question` — the two extensions coexist gracefully.

## License

MIT
