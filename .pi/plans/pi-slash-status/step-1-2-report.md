# Step 1–2 report — pure status view model + `/pi-status` slash module

Branch: `feat/slash-status` — **no git writes performed** (no commit/push/add/branch).
Files touched (all new): `extensions/status.ts`, `extensions/slash.ts`,
`extensions/__tests__/status.test.ts`, `extensions/__tests__/slash.test.ts`.

`extensions/index.ts`, `extensions/config.ts`, `README.md`, `package.json` and
`package-lock.json` were **not** modified. (`package-lock.json` already showed as
` M` before this step — a pre-existing version bump — it was not touched here.)

---

## 1. `extensions/status.ts` — pure view model (no discord.js import)

### Exported symbols

```ts
export type SessionState = "no_session" | "idle" | "working" | "waiting" | "error";

export interface StatusState { /* see field list below */ }

export interface StatusViewField { name: string; value: string; inline: boolean }

export interface StatusView {
  state: SessionState;          // canonical state
  headline: string;             // "🟢 Idle — ready for instructions"
  hint: string | null;          // e.g. "Start a Pi session with /pi-discord-remote start …"
  fields: StatusViewField[];    // State, Model, Project, Context, Session, Activity, Discord
  color: number;                // Discord embed color (integer)
}

export interface StatusEmbedField { name: string; value: string; inline: boolean }

export interface StatusEmbed {
  title: string;
  description: string;
  fields: StatusEmbedField[];
  color: number;
}

export const UNKNOWN = "unknown";
export const EMBED_TITLE = "Pi Session Status";
export const EMBED_TITLE_MAX = 256;
export const EMBED_DESCRIPTION_MAX = 4096;
export const EMBED_FIELD_NAME_MAX = 256;
export const EMBED_FIELD_VALUE_MAX = 1024;
export const EMBED_MAX_FIELDS = 25;
export const STATE_COLORS: Record<SessionState, number>;
// no_session 0xf59e0b · idle 0x22c55e · working 0xef4444 · waiting 0xeab308 · error 0xdc2626

export function truncate(text: string, max: number): string;
export function buildStatusView(state: StatusState): StatusView;
export function buildStatusEmbed(view: StatusView): StatusEmbed;
export function formatStatusText(view: StatusView): string;
```

### `StatusState` field list as implemented (every field optional + explicitly nullable)

| field | type | notes |
|---|---|---|
| `state` | `SessionState \| null` | missing/null ⇒ `"no_session"` |
| `modelId` | `string \| null` | e.g. `"openai-codex/gpt-6.1-sol"` |
| `modelName` | `string \| null` | e.g. `"GPT-6.1 Sol"` |
| `modelProvider` | `string \| null` | e.g. `"openai-codex"` |
| `thinkingLevel` | `string \| null` | e.g. `"high"` |
| `cwd` | `string \| null` | absolute path of the project |
| `gitBranch` | `string \| null` | |
| `gitSha` | `string \| null` | short SHA |
| `gitDirtyCount` | `number \| null` | modified/untracked files |
| `contextTokens` | `number \| null` | tokens used |
| `contextWindow` | `number \| null` | window size |
| `sessionId` | `string \| null` | shortened to the first 7 chars when rendered |
| `sessionName` | `string \| null` | |
| `entryCount` | `number \| null` | |
| `channelName` | `string \| null` | rendered as `#name` |
| `channelId` | `string \| null` | fallback → `channel <id>` |
| `botTag` | `string \| null` | e.g. `"bot#1234"` |
| `reconnectAttempts` | `number \| null` | |
| `lastPromptAt` | `Date \| null` | |
| `runStartedAt` | `Date \| null` | |
| `lastToolName` | `string \| null` | |
| `errorMessage` | `string \| null` | used by the `error` state |

### Embed shape as implemented

`buildStatusEmbed(view)` returns a **plain object** (no `EmbedBuilder`), directly
usable as `channel.send({ embeds: [embed] })` / `interaction.editReply({ embeds: [embed] })`:

```jsonc
{
  "title": "Pi Session Status",
  "description": "🟢 Idle — ready for instructions",   // headline (+ hint line for no_session)
  "fields": [
    { "name": "State",    "value": "Idle",                                              "inline": false },
    { "name": "Model",    "value": "openai-codex/gpt-6.1-sol · thinking: high",          "inline": false },
    { "name": "Project",  "value": "byow · main @ 4bea19a (3 files dirty)",              "inline": false },
    { "name": "Context",  "value": "42.1k / 200k tokens (21%)",                          "inline": false },
    { "name": "Session",  "value": "8f3c1a2 · may09 · 42 entries",                      "inline": false },
    { "name": "Activity", "value": "last prompt 12m ago · last tool bash",               "inline": false },
    { "name": "Discord",  "value": "#byow-may09 · as bot#1234 · reconnect attempts 0",   "inline": false }
  ],
  "color": 2278750   // integer, 0x22c55e for "idle"
}
```

Limits enforced: ≤25 fields, field value ≤1024, field name ≤256, description ≤4096,
title ≤256 — over-long values are cut and suffixed with `…`.
A field whose values are *all* unknown is dropped entirely (never emitted empty).

### Rendering rules (as implemented)

* Headlines: `🟠 No Pi session connected` (+ hint) · `🟢 Idle — ready for instructions` ·
  `🔴 Working — 42s` (elapsed from `runStartedAt`, omitted when unknown) ·
  `⏸ Waiting for your answer to a question` · `⚠️ Error — <errorMessage>`.
* Project: `byow · main @ 4bea19a (3 files dirty)` · `byow · not a git repo` (no git info) ·
  `unknown · …` (no cwd, git info present) · field dropped when neither cwd nor git is known.
* Context: `42.1k / 200k tokens (21%)` · percentage omitted when the token count is unknown
  (`unknown / 200k tokens`) · dropped when neither number is known.
* Session: `8f3c1a2 · may09 · 42 entries` (short id = first 7 chars, name optional).
* Activity: `last prompt 12m ago · running for 42s · last tool bash` (relative times).
* Discord: `#byow-may09 · as bot#1234 · reconnect attempts 0`.
* Every rendered string is scrubbed of the literal tokens `undefined` / `NaN` / `null`
  (word-boundary match) and replaced by `unknown`.

---

## 2. `extensions/slash.ts` — command definition, registration, interaction handler

Imports the pure helpers from `./status.js` (ESM, `.js` specifier). No import from
`index.ts`; no runtime discord.js import (only *structural* types, so the real
`discord.js` `Client`/`ChatInputCommandInteraction` satisfy them — asserted by a
compile-time check in `extensions/__tests__/slash.test.ts`).

### Exported symbols

```ts
export const PI_STATUS_COMMAND = {
  name: "pi-status",
  description: "Show the live state of the connected Pi session (model, activity, context, project)", // 83 chars, one line
  type: 1,                                     // 1 = ApplicationCommandType.ChatInput
} as const;                                    // no options, no subcommands

export const PI_STATUS_COMMAND_NAME = "pi-status";

export interface PiStatusCommandEntry { id: string; name: string }

export interface PiStatusCommandManager {
  fetch(options: { guildId: string }): Promise<Iterable<unknown>>;
  create(body: unknown, guildId: string): Promise<unknown>;
  edit(id: string, body: unknown, guildId: string): Promise<unknown>;
}

export interface PiStatusClient {
  application?: { id?: string | null; commands: PiStatusCommandManager } | null;
  user?: { id?: string } | null;
}

export interface PiStatusEmbedPayload {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface PiStatusInteraction {
  user: { id: string };
  deferReply(options?: { ephemeral?: boolean }): Promise<unknown>;
  editReply(options: string | { content?: string; embeds?: PiStatusEmbedPayload[] }): Promise<unknown>;
  reply(options: string | { content?: string; ephemeral?: boolean }): Promise<unknown>;
}

export interface PiStatusInteractionDeps {
  allowedUserIds?: string[];        // empty/undefined = allow everyone
  buildState: () => StatusState;    // caller supplies the live snapshot
}

export interface PiStatusInteractionResult { ok: boolean; error?: string }
export interface PiStatusRegistrationResult  { ok: boolean; error?: string; hint?: string }

export const PI_STATUS_INVITE_PERMISSIONS = "274145945856";
export const DISCORD_OAUTH_URL = "https://discord.com/oauth2/authorize";
export const PI_STATUS_REFUSAL = "❌ You are not allowed to use this command.";
export const PI_STATUS_UNAVAILABLE = "⚠️ Status unavailable right now.";

export function buildPiStatusInviteUrl(appId: string): string;
export function isMissingCommandScopeError(err: unknown): boolean;

export function registerPiStatusCommand(
  client: PiStatusClient,
  token: string,
  guildId: string,
): Promise<PiStatusRegistrationResult>;

export function handlePiStatusInteraction(
  interaction: PiStatusInteraction,
  deps: PiStatusInteractionDeps,
): Promise<PiStatusInteractionResult>;
```

### `deps` contract (exact)

```ts
{ allowedUserIds?: string[]; buildState: () => StatusState }
```

`buildState()` is called **after** `deferReply({ ephemeral: true })`, so the caller may
do slow work (git lookup etc.) inside it.

### Behaviour

* `registerPiStatusCommand` — fetches the guild's commands, finds the one named
  `pi-status`, **edits it in place** (`commands.edit(existing.id, body, guildId)`) or
  **creates** it (`commands.create(body, guildId)`). `commands.set(...)` is never called,
  so other commands of the same bot application are never deleted.
  Returns `{ ok: true }` or `{ ok: false, error, hint? }`; everything is inside try/catch.
  The bot token is redacted (`***`) from any returned error string.
* Missing-scope detection: HTTP 403 / body containing “Missing Access” / code `50013`
  ⇒ `hint` = one line containing
  `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=274145945856`
  (`client.application.id` → `client.user.id` → literal `<APP_ID>` placeholder).
* `handlePiStatusInteraction` —
  * allow-list gate: non-empty `allowedUserIds` without `interaction.user.id`
    ⇒ `reply({ content: PI_STATUS_REFUSAL, ephemeral: true })`, **no status data**, no defer;
  * otherwise `deferReply({ ephemeral: true })` → `buildState()` → `buildStatusView` →
    `buildStatusEmbed` → `editReply({ embeds: [embed] })`;
  * internal error ⇒ `editReply({ content: PI_STATUS_UNAVAILABLE })` (still ephemeral);
    the raw error is only written to the local console, the returned result carries the
    short code `status_unavailable` / `defer_failed` / `not_allowed` — never a stack
    trace, token, system prompt or file content.

---

## 3. Validation (verbatim)

```
===== npm run check =====
> pi-discord-remote@0.2.4 check
> tsc --noEmit
(no output — clean)

===== npm test -- status slash =====
> pi-discord-remote@0.2.4 test
> vitest run status slash

 RUN  v4.1.6 /home/tony/code/personal/pi-discord-remote

 Test Files  2 passed (2)
      Tests  64 passed (64)
   Start at  08:01:21
   Duration  222ms (transform 109ms, setup 0ms, import 149ms, tests 38ms, environment 1ms)

===== npm test (full) =====
> pi-discord-remote@0.2.4 test
> vitest run

 RUN  v4.1.6 /home/tony/code/personal/pi-discord-remote

 Test Files  5 passed (5)
      Tests  114 passed (114)
   Start at  08:01:22
   Duration  358ms (transform 345ms, setup 0ms, import 441ms, tests 204ms, environment 1ms)
```

Baseline before this step was `3 passed (3) / 50 tests` → now `5 passed (5) / 114 tests`
(64 new tests, all pre-existing tests still green).

`npm run build` (`tsc`) was also executed once and succeeded (exit 0, `dist/status.js`,
`dist/slash.js` + declarations emitted). The generated `dist/` was **deleted again**
afterwards: vitest 4 also collects `dist/__tests__/*.test.js`, which doubled the test
counts (10 files / 228 tests) and would confuse later steps. `dist/` is gitignored and
was not present in the working tree before this step.

---

## 4. Deviations from the plan / task text (and why)

1. **discord.js v14 call order for the command manager.** The brief specified
   `commands.fetch(guildId)`, `commands.edit(guildId, existing.id, body)` and
   `commands.create(guildId, body)`. The installed discord.js v14.26.4
   `ApplicationCommandManager` has the *opposite* order
   (`node_modules/discord.js/src/managers/ApplicationCommandManager.js`:
   `async create(command, guildId)`, `async edit(command, data, guildId)`,
   `async fetch(id, { guildId, ... })`; typings `index.d.ts:4762-4789`).
   With the literal order from the brief, `create(guildId, body)` would post the guild
   id as the command body (HTTP 400) and `fetch(guildId)` would fetch a *global* command
   by id (HTTP 404) — the feature could never register. The implementation therefore uses
   the library's canonical order (`fetch({ guildId })`, `create(body, guildId)`,
   `edit(id, body, guildId)`). The **semantics required by the plan are unchanged**:
   fetch the guild's commands → find `pi-status` → edit in place, else create → never
   bulk-`set`.
2. **discord.js `Collection` iteration.** `@discordjs/collection` v2 does not override
   `[Symbol.iterator]`, so iterating a `Collection` yields `[key, value]` tuples
   (verified at runtime). The lookup therefore normalises both plain command objects and
   tuple entries; a regression test covers the tuple shape.
3. **"State" field content.** The emoji headline lives in the embed *description*; the
   `State` field carries a short friendly label (`Idle`, `Working`,
   `Waiting for your answer`, `Error`, `No session`) so a long error message is not
   duplicated inside the same embed.
4. **`waiting` priority.** `StatusState` has a single `state` field, so the priority of
   `waiting` over `working` has to be resolved by the caller (Step 3: pass
   `state: "waiting"` whenever a `discord_ask_user_question` answer is outstanding).
   This is documented in the `SessionState` doc comment. `buildStatusView` never shows
   the working elapsed time for the `waiting` state.
5. **Dirty-file count.** Rendered only when `gitDirtyCount > 0`
   (`(3 files dirty)` / `(1 file dirty)`); a clean tree shows no marker.
6. **Project without a cwd.** `unknown · main @ 4bea19a` when git info exists; the
   field is dropped entirely when neither cwd nor git info is known (per the
   "skip a field when every value is unknown" rule).
7. **Error details.** The raw error message is logged to the console only
   (`console.error("[pi-discord-remote] /pi-status: …")`, repo convention); the returned
   result carries a short code. This keeps Discord replies and the caller's log line
   free of tokens / prompts / file contents.
8. **`token` parameter.** Kept in the signature as required; it is only used to redact
   the token from returned error strings (the client already carries the credentials).

## 5. Notes for Step 3 (wiring)

* Call `registerPiStatusCommand(client, cfg.token, cfg.guildId)` after `ready`
  (`client.application` is only populated once the client is ready) and log
  `result.hint` on failure — the extension must keep working without the command.
* Build the `StatusState` snapshot in `index.ts` and pass it via
  `deps.buildState` — `slash.ts` never imports anything from `index.ts`.
* `handlePiStatusInteraction` must be called only for chat-input interactions whose
  command name is `pi-status`; everything else is ignored.
* The `allowedUserIds` gate in `slash.ts` mirrors the message-handler gate; keep both.
