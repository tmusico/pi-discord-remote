# CHECKLIST — OptChat `pi.events` integration (read-only)

## Objective

Bind OptChat's in-process `pi.events` contract in `pi-discord-remote` and surface the owner's
main-agent phase and background-agent fleet in `/pi-status` — read-only, with no behavior change for
users who do not run OptChat.

Source: `.pi/plans/optchat-events/PLAN.md`.

**Status (2026-11-06):** Increment 1 complete — the pure client, the wiring and the status field are
implemented and validated. Two follow-ups are queued below (one of them blocked on the OptChat side).
Nothing committed or pushed; the commit decision is the user's.

## Phase 1 — Pure event client

- [x] `extensions/optchat-events.ts` exists and imports neither discord.js nor Pi
- [x] The six channel constants are literal and versioned
- [x] `parseOptchatCapabilities()` — reads the owner epoch; **consent defaults to off**
- [x] `parseOptchatOwnerEvent()` — accepts `ready` / `replayed-ready` / `closing` only
- [x] `parseOptchatMainStatus()` — rejects an unknown phase or a missing owner
- [x] `parseOptchatAgentSnapshot()` — skips malformed rows, defaults the counters to zero
- [x] Every parser returns null on garbage and never throws
- [x] `createOptchatEventsClient()` — binds the owner, holds the two snapshots, exposes `getState()`
- [x] `start()` attaches all four listeners **before** it pings
- [x] `start()` is idempotent; `refresh()` re-pings without re-subscribing
- [x] `dispose()` detaches every listener, clears the state and tolerates a double call
- [x] No bus, a bus whose `on()` throws, and a malformed payload all leave the client inert

## Phase 2 — Owner lifecycle correctness

- [x] The owner is bound from the capability advertisement **and** from an owner event
- [x] A `closing` event for the bound owner drops the binding and the gates
- [x] A `closing` event for a *different* owner is ignored
- [x] A main status from a foreign owner / epoch is ignored
- [x] A fleet snapshot from another owner **session** is ignored (it carries no epoch, so it can
      only be matched at session level)
- [x] A **new epoch** clears the previous owner's main status and fleet snapshot
- [x] An owner replacement (OptChat rebuilt the integration after a gate change) rebinds and
      re-derives the gates from the new advertisement
- [x] The client emits **only** the two pings — it never issues a request

## Phase 3 — Wiring in `extensions/index.ts`

- [x] The client is created eagerly so the listeners exist before OptChat's first broadcast
- [x] `session_start` → `refresh()` (catch up with an owner that was already open)
- [x] `session_shutdown` → `dispose()`
- [x] `buildStatusState()` feeds the phase, tool, tool count, pending flag, profile and agent counts
- [x] The existing `pi.on(...)` hooks are untouched — they remain the baseline

## Phase 4 — Status view

- [x] `StatusState` gains the optional `optchat*` fields
- [x] `buildOptchatValue()` renders profile · phase · tool · agents · pending
- [x] The **OptChat** field is dropped entirely when every value is unknown
- [x] The rendered value never contains `undefined`, `NaN` or `null`
- [x] The tool count only shows the *extra* tools (`bash (+2)` for three observed tools)

## Phase 5 — Tests, docs, validation

- [x] `extensions/__tests__/optchat-events.test.ts` — 39 fake-bus tests
- [x] `extensions/__tests__/status.test.ts` — the OptChat field's rendering and its absence
- [x] README documents the integration, the same-process precondition and the degradation matrix
- [x] `timeout 300s npm test` — 430 tests pass (13 files)
- [x] `timeout 120s npm run check` — clean
- [x] `timeout 180s npm run build` — clean
- [x] `git diff --check` — clean
- [x] No new runtime dependency (discord.js only)

## Phase 6 — `/pi-agents` command (done)

- [x] `extensions/agents.ts` — the pure fleet view model (no discord.js, no Pi import)
- [x] `buildAgentFleetView()` — headline from the counters, rows capped at 20, `omitted` surfaced
- [x] `buildAgentsEmptyMessage()` — distinguishes "no OptChat owner" from "the owner has no agents"
      and from "the snapshot has not arrived yet"
- [x] `formatAgentRow()` — renders only the known parts; a missing value is left out, never
      rendered as a placeholder
- [x] The run id is shortened with a plain slice (no ellipsis) so it stays copy-pasteable
- [x] `buildAgentFleetEmbed()` — respects Discord's field/description limits; color reflects
      whether a run is active
- [x] `PI_AGENTS_COMMAND` — `name: "pi-agents"`, `type: 1`, one-line description ≤ 100 chars
- [x] `handlePiAgentsInteraction()` — allow-list gate → ephemeral defer → ephemeral reply; every
      path (refusal, success, failure) is ephemeral
- [x] Registered with the existing per-command upsert — the guild's other commands are never
      touched, and no bulk replace ever happens
- [x] Routed in `routePiInteraction` after the autocomplete branch
- [x] Works in hub mode: the fleet comes from the OptChat owner, not from the Discord session
- [x] Unit tests in `extensions/__tests__/agents.test.ts` (22) and
      `extensions/__tests__/slash-agents.test.ts` (13); the routing test covers `/pi-agents`
- [x] README documents the command, its replies and the hub-mode behaviour

## Phase 7 — `/pi-stop` command (done)

- [x] The fleet snapshot's `startedAt` (the generation token) is parsed and validated as a whole
      positive millisecond
- [x] The token is cached per run id — refreshed on **every** snapshot (a resumed run keeps its id
      but starts a new generation) and kept for a run that left the snapshot
- [x] The cache is bounded (64 runs, least-recently-seen evicted first)
- [x] `stopAgent()` emits the contract's request envelope on `optchat:agent:request:v1` and
      resolves on the terminal result from `optchat:agent:result:v1`
- [x] The request payload carries **only** `runId` and `expectedStartedAt` — the contract rejects
      a request that carries a forbidden semantic key
- [x] The emitted envelope was verified against OptChat's own `parseEventRequest()` — it parses
- [x] A result is matched on the client id, the request id **and** the owner identity the request
      was addressed to
- [x] `accepted` is **not** terminal — the request stays pending until `rejected` or `completed`
- [x] The control gate is checked before the request is sent — nothing is emitted when it is off
- [x] A request that never gets a result resolves as `OUTCOME_UNKNOWN`; a disposed client settles
      every pending request
- [x] `resolveRunSelection()` — exact id, unique prefix, ambiguous, unknown (with suggestions), and
      a run whose token is not published
- [x] `PI_STOP_COMMAND` + `handlePiStopInteraction()` — allow-list gate → ephemeral defer →
      ephemeral reply, with every contract error code mapped to a fixed message
- [x] `extensions/__tests__/optchat-events.test.ts` (54), `agents.test.ts` (40),
      `slash-agents.test.ts` (24); the routing test covers `/pi-stop`
- [x] README documents the command, its replies and the control gate

## Phase 8 — Review, repair, final review (done)

- [x] `review.md` — read-only review of the whole diff → **CHANGES REQUIRED** (1 × P1, 4 × P2, 3 × P3);
      every finding was reproduced before it was reported
- [x] `repair-report.md` — all eight findings repaired, each with a regression test
- [x] **Negative controls**: each fix was reverted and its regression test was confirmed to
      **fail** (8 for 8), then the source was restored
- [x] The repair's own risk was checked: a capability *replay* must not wipe the run cache
      (`R-P2-3b`)
- [x] `final-review.md` — re-read of the whole diff → **ACCEPT**, no open P0/P1/P2

## Phase 9 — Follow-ups (queued, not started)

- [ ] `/pi-history` — bounded recent-session history. Needs OptChat's content gate; the 60 s cursor
      TTL makes it a catch-up, not an archive.
- [ ] The commit + push decision is the user's.

## Validation checklist

- [x] `timeout 300s npm test`
- [x] `timeout 120s npm run check`
- [x] `timeout 180s npm run build`
- [x] `git diff --check`
- [x] No new runtime dependency added (discord.js only)
- [ ] Manual check: Pi with an OptChat profile open → `/pi-status` shows the OptChat field

## Rollback notes

- The change is additive and inert without OptChat: revert the five touched files and the extension
  is byte-for-byte what it was. No Discord command is registered, so there is nothing to unregister in
  the guild and no guild state to clean up.

## Done definition

- [x] All Phase 1–5 checkboxes are ticked.
- [x] `npm test`, `npm run check`, `npm run build` pass and `git diff --check` is clean.
- [x] The commit/push decision is the user's (and the parent's).
