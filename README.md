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
   `/pi-abort` and `/pi-model` slash commands only appear when the bot was invited with that
   scope. Re-invite it once with this URL (`<APP_ID>` is the **Application ID** from the
   Developer Portal, not the bot user id):

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

### Hub mode (bot online without a session)

`/pi-discord-remote stop` ends the *session* but keeps the Discord connection alive, so
`/pi-status` can still answer with **“no session connected”** (and the reconnect logic keeps
working). In hub mode the extension ignores every channel message — there is no session
channel, so nothing is injected into Pi. `/pi-abort` and `/pi-model` answer **“No Pi session is
connected.”** in hub mode as well — there is no remote session to stop or re-model, and the
model list is only available for a bound session.

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

Edit config with `/pi-discord-remote open-config`.

## How it works

The extension loads silently on Pi startup — no channel is created until you explicitly run the command.

- **`/pi-discord-remote start`** — bot logs in, creates a text channel named `<project>-<mon><dd>-<HHMM>`, and starts listening there only
- **Incoming message** — injected as a user prompt into the active Pi session; bot reacts ⏳ while Pi works, then posts the full response back
- **Tool calls** — each tool invocation is labeled (🔧 bash, 📄 read, ✏️ edit, etc.) with a detail line; if `toolResponses` is on, results follow as ↩️/❌ code blocks
- **`/pi-discord-remote stop`** — the session channel is deleted and the session state is cleared; the bot stays online so `/pi-status` keeps working (set `keepOnline: false` to disconnect as well)
- **`/pi-discord-remote disconnect`** (or Pi exit) — the channel is deleted and the bot disconnects completely

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
