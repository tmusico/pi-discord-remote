# PLAN — OptChat `pi.events` integration (read-only)

## Problem

`pi-discord-remote` is blind to OptChat. When the Pi session is owned by an OptChat profile, the
extension still reconstructs everything it knows from its own `pi.on(...)` hooks: a hand-rolled
`agentBusy` flag, a `lastToolName` string, and a locally-guessed state machine in `extensions/status.ts`.

That reconstruction is *approximate*, and it throws away everything OptChat already publishes
authoritatively and safely:

- the main agent's real lifecycle phase (`idle` / `working` / `responding` / `awaiting-input` / `closing`),
- the sanitized name of the tool running right now and how many tools are in flight,
- whether Pi has queued user messages,
- the profile's **background-agent fleet** — which runs exist, their state, model, depth and age.

OptChat (`pi-optchat`) publishes all of this on Pi's shared in-process event bus (`pi.events`) as a
small, versioned, capability-gated contract. Because `pi-discord-remote` is itself a Pi extension,
both extensions share **one** bus in the same process — no new transport, no second service.

## Goal

Bind OptChat's event contract **read-only** and surface what it says in Discord:

- a new **OptChat** status field (profile, phase, current tool, agent counts), present only when an
  OptChat owner is actually bound;
- a **`/pi-agents`** command that lists the profile's background-agent fleet.

The integration must be **invisible** to anyone not running OptChat: no behavior change, no new
dependency, no new Discord output.

## Non-goals

- **No live streaming.** Assistant-output subscriptions are deliberately out: the Discord side would
  need its own rate limiting, final-replacement semantics and gap reconciliation for a marginal gain
  over the single final reply this extension already posts.
- **No history reads.** `history:recent` needs OptChat's content gate and has a 60 s cursor TTL — a
  catch-up, not an archive.
- **No out-of-process bridge.** `pi.events` is local to one Pi process by design.
- **No change to how Discord messages are injected into Pi.** `pi.sendUserMessage()` stays.
- **No change to the existing `pi.on(...)` hooks.** They remain the baseline; the event contract is
  an overlay.

## Current state

- `extensions/index.ts` owns the discord.js client and registers `pi.on(...)` handlers for
  `session_start`, `agent_start`, `model_select`, `tool_result`, `message_update`,
  `tool_execution_start`, `tool_execution_end`, `message_end`, `agent_end`, `tool_call`,
  `before_agent_start` and `session_shutdown`.
- `extensions/status.ts` is the pure view model for `/pi-status`: `resolveSessionState()` derives
  `no_session | idle | working | waiting | error` from locally tracked signals.
- The extension uses **no** part of `pi.events` today.
- Pi exposes the shared bus as `pi.events` on `ExtensionAPI` (`emit(channel, data): void`,
  `on(channel, handler): () => void`) — identical on Pi 0.74 (this repo's devDependency) and Pi 1.4
  (OptChat's runtime). One `ResourceLoader` owns the bus and hands it to every extension.

## Decisions (user-confirmed)

| # | Decision |
|---|-----------|
| 1 | **Same process only.** The integration targets an OptChat owner in the *same* Pi process. Out-of-process observation is explicitly out of scope. |
| 2 | **Skip live streaming.** No assistant-output subscription, no live Discord message. |
| 3 | **Feature-detect and degrade.** With no OptChat, no open profile, or the gates off, the extension behaves exactly as before. |
| 4 | **Read-only.** This increment binds and displays. It emits no request and mutates nothing. |
| 5 | **Owner epoch is authoritative.** A new epoch means a new owner: every snapshot of the previous owner is dropped. |

### Consequence of decision 1 — when the contract exists

The contract is published **only** when `pi-optchat` is installed *and* has a profile open *in this
process*. It is absent for:

- a plain Pi session with no OptChat installed,
- `pi -p` / JSON mode,
- a session that **joined** a profile owned by another Pi process (`--optchat-connect join`) — the
  owner coordinator lives in the *other* process and never reaches this bus.

The extension must therefore detect the contract, not assume it.

### Consequence of decision 5 — owner replacement

OptChat's consent gates are both a CLI flag **and** a profile setting (`/optchat settings` →
"Events content" / "Events control"), and the effective gate is *setting OR flag*. Changing a saved
gate applies at once: OptChat rebuilds the events integration, so **the owner is replaced by a new
`ownerEpoch` and `generation`** and any output subscription is dropped.

A consumer must therefore treat an owner replacement exactly like a profile reopen: rebind to the new
epoch and re-derive the gates from the new capability advertisement. The new owner's advertisement
states the gates it was built with.

## Target outcome

```
/pi-status  →  (ephemeral embed)

  🟢 Idle — ready for instructions
  🤖 Model    openai-codex/gpt-6.1-sol · thinking: high
  📁 Project  byow · main @ 4bea19a (3 files dirty)
  🧠 Context  42.1k / 200k tokens (21%)
  🕐 Activity last prompt 12m ago · session 8f3c… · 42 entries
  🔌 OptChat  work · working · bash (+2) · 2/4 agents
  🔗 Discord  #byow-may09 · as bot#1234 · reconnect attempts 0
```

Without an OptChat owner the **OptChat** field is absent and the reply is byte-for-byte what it was
before this change.

## Implementation shape

| File | Responsibility |
|------|----------------|
| `extensions/optchat-events.ts` (new) | **Pure.** Channel constants, defensive parsers, and a read-only client that binds the owner, tracks the epoch and holds the two snapshots. No discord.js, no Pi import → unit-testable with a fake bus. |
| `extensions/index.ts` (edit) | Create the client, `start()` it eagerly (so the listeners exist before OptChat's first broadcast), `refresh()` on session start, `dispose()` on session shutdown, and feed the snapshots into `buildStatusState()`. |
| `extensions/status.ts` (edit) | New optional `optchat*` fields on `StatusState` + a `buildOptchatValue()` builder. The field is dropped entirely when every value is unknown. |
| `extensions/agents.ts` (new) | **Pure.** The `/pi-agents` view model (headline, capped rows, embed, plain text) and the `/pi-stop` run resolution. |
| `extensions/slash.ts` (edit) | `PI_AGENTS_COMMAND` + `handlePiAgentsInteraction()`, `PI_STOP_COMMAND` + `handlePiStopInteraction()`. |
| `extensions/index.ts` (edit) | Create the client, `start()` it eagerly (so the listeners exist before OptChat's first broadcast), `refresh()` on session start, `dispose()` on session shutdown, feed the snapshots into `buildStatusState()`, and route `/pi-agents`. |
| `extensions/__tests__/optchat-events.test.ts` (new) | Fake-bus tests for the parsers, the bind/rebind/close lifecycle and the degradation paths. |
| `extensions/__tests__/agents.test.ts` (new) | Pure fleet-renderer tests. |
| `extensions/__tests__/slash-agents.test.ts` (new) | Handler, allow-list, failure-path and registration tests. |
| `extensions/__tests__/status.test.ts` (edit) | The OptChat field's rendering, and that it is absent without an owner. |
| `README.md` (edit) | Document the integration, the same-process precondition, the degradation matrix and `/pi-agents`. |

## The contract this binds (OptChat side)

| Channel | Direction | Used for |
|---------|-----------|----------|
| `optchat:capabilities:v1` | owner → consumer | Owner epoch + the gates the owner was built with. |
| `optchat:owner:event:v1` | owner → consumer | `ready` / `replayed-ready` / `closing` lifecycle. |
| `optchat:main:status:v1` | owner → consumer | Main-agent phase, tool, tool count, pending flag. |
| `optchat:status:v1` | owner → consumer | Background-agent fleet + counters. |
| `optchat:status:ping:v1` | consumer → owner | Request a capabilities + fleet replay (payload ignored). |
| `optchat:main:ping:v1` | consumer → owner | Request a main-activity snapshot (payload ignored). |

## Hard rules

- **Listeners before pings.** Pi's bus does not replay: a ping answered before the listener exists is
  lost forever.
- **Filter by owner.** A main snapshot whose `ownerSessionId`/`ownerEpoch` does not match the
  current binding is ignored. The fleet snapshot carries no epoch (it predates the integrations
  contract), so it is matched at session level only. A stale phase is worse than no phase.
- **A new epoch clears everything.** The previous owner's main status and fleet snapshot are dropped.
- **Consent defaults to OFF.** A missing or malformed `content`/`control` section is read as
  *not permitted*, never as permitted.
- **Never throw out of a listener.** Pi logs whatever a listener throws, so every handler swallows
  its own errors and a malformed payload is simply ignored.
- **Never leak.** The payloads carry only bounded, sanitized data; nothing from them is echoed into
  a log line together with Discord identifiers, the bot token or file contents.
- **`pi.events` may be gone.** `events.emit`/`events.on` throw once the extension's runtime is
  invalidated (session replacement / reload). Every bus call is wrapped, so a dead bus leaves the
  client inert instead of crashing the extension.

## Risks

| Risk | Mitigation |
|------|------------|
| The owner replaces itself when a gate changes | Rebind on epoch change; drop the previous owner's snapshots. |
| OptChat opened its profile *before* this extension attached | The capabilities ping replays the advertisement; the listener is attached before the ping. |
| The extension's bus is invalidated mid-session | Every bus call is wrapped; the client degrades to "no OptChat". |
| The status reply grows a new field | The field is dropped unless an owner is bound. |
| The developer reads the gates as an external ACL | They are operator consent only; this integration authorizes nothing (it issues no requests). |

## Verification approach

1. `npm run check` (tsc --noEmit) — type safety.
2. `npm test` (vitest) — the fake-bus client tests and the status view tests. No Discord, no live Pi.
3. `npm run build` (tsc) — emits `dist/`.
4. `git diff --check` — clean.
5. Manual check by the user: run Pi with OptChat open, then `/pi-status` in the guild.

## Acceptance criteria

- [x] `/pi-status` shows an **OptChat** field when an OptChat owner is bound (profile, phase, tool,
      agent counts).
- [x] `/pi-status` is unchanged — no OptChat field — when OptChat is absent or its profile is closed.
- [x] `/pi-agents` lists the profile's background agents ephemerally, capped at 20 rows, with the
      omitted count surfaced.
- [x] `/pi-agents` distinguishes "no OptChat owner" from "the owner has no agents".
- [x] `/pi-agents` is read-only — it never starts, stops or steers anything.
- [x] The client only listens: it emits exactly the two pings and nothing else.
- [x] A snapshot from a foreign owner is ignored; a replaced owner's snapshots are dropped.
- [x] A missing or malformed consent section is read as "not permitted".
- [x] A malformed payload never throws out of a listener and never reaches a Pi log line.
- [x] The extension works unchanged with no OptChat installed (no new dependency, no behavior change).
- [x] `npm run check && npm test && npm run build` pass; `git diff --check` is clean.

## Blocked follow-ups (not in this increment)

| Follow-up | Blocked by |
|-----------|-----------|
| `/pi-history` — bounded recent-session history | Needs OptChat's content gate; 60 s cursor TTL makes it a catch-up only. |
| Live output streaming | Rejected by the user. |

## Resolved: the generation token

`/pi-stop` was originally blocked because no published value carried the run's generation token —
`agent:stop` requires `expectedStartedAt` to equal `run.started`, but `StatusAgentV1` published no
`startedAt`, `elapsed` is a formatted string, and `agent:spawn` returned only `{ runIds }`.

OptChat shipped the token (`feat/pi-events` @ `15f05e7`):

- the fleet snapshot row carries `startedAt` (epoch ms, `number | null`), advertised in
  `status.fields`;
- `agent:spawn` returns `{ runIds, runs: [{ runId, startedAt }] }`.

The guard was **not** relaxed — a mismatched or stale token still returns `STALE_RUN`. The
extension caches the token per run id, refreshes it on every snapshot (a resumed run keeps its id
but starts a new generation), and sends it back verbatim.

## Out of scope

Any Discord transport of its own, any out-of-process bridge, any change to message injection, any
change to the existing `pi.on(...)` hooks, and any OptChat-side change.
