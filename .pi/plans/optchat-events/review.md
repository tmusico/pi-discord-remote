# Review — OptChat `pi.events` integration

Read-only review of the whole diff (`.pi/plans/optchat-events/`), on branch `feat/slash-control`.

**Scope reviewed:** `extensions/optchat-events.ts` (new), `extensions/agents.ts` (new),
`extensions/status.ts`, `extensions/slash.ts`, `extensions/index.ts`, the four test files, the
README and the plan artifacts.

**Verdict: CHANGES REQUIRED** — 1 × P1, 4 × P2, 3 × P3.

Every finding below was **reproduced**, not inferred: each one was confirmed by running the code
or by parsing the contract against the real OptChat source.

---

## What was verified as correct

| Area | Result |
|------|--------|
| **Request envelope** | The exact object `stopAgent()` emits was run through OptChat's own `parseEventRequest()`: `parse ok: true`, `operation: agent:stop`, payload `{runId, expectedStartedAt}` intact. The payload carries only the two contract fields, so it cannot trip the forbidden-key check (`cwd`, `parent`, `parentId`, …). |
| **Request channel** | `events-controls.ts:640` subscribes to `AGENT_REQUEST_EVENT` = `optchat:agent:request:v1` — the same channel this client emits on. |
| **Result envelope** | Generated with OptChat's `eventRequestResult()`; the shape matches what `handleAgentResult()` parses (`version/clientId/requestId/ownerSessionId/ownerEpoch/phase/outcome{status,code,value}`). |
| **Owner binding** | A snapshot from a foreign owner is ignored; a replaced owner's snapshots are dropped; a `closing` for another owner does not unbind the current one. All three covered by tests. |
| **Terminal vs accepted** | `accepted` is not treated as terminal — the request stays pending. Covered by a test that asserts the promise has *not* settled after an `accepted` result. |
| **Result filtering** | A result is matched on client id, request id **and** the owner identity the request was addressed to. A result for another consumer, request or owner is ignored. |
| **Consent defaults** | A missing or malformed `content`/`control` section is read as *not permitted*. The control gate is checked **before** anything is emitted — with the gate off, no request reaches the bus. |
| **Listener hygiene** | Every listener swallows its own errors, so a malformed payload never becomes a Pi log line. |
| **Degradation** | With no OptChat the extension behaves exactly as before: the `/pi-status` OptChat field is dropped, `/pi-agents` says "no OptChat owner", and no request is emitted. |
| **No hanging promises** | A request with no result resolves `OUTCOME_UNKNOWN`; a disposed client settles every pending request. |
| **Leak hygiene** | No reply carries the bot token, a provider error, a path or a raw exception. Only fixed error codes and fixed messages cross the Discord boundary. |

---

## Findings

### P1-1 — The module header contradicts the code

**File:** `extensions/optchat-events.ts`, lines 3–39

The header still says:

> "Read-only client for the OptChat `pi.events` contract."
> "Agent controls (`agent:stop` / `steer` / `resume`), which additionally need `expectedStartedAt` —
> a value OptChat does not publish yet."
> "Everything in this module is observation-only: it never emits a request, so it cannot mutate
> anything."

All three statements are now false. `stopAgent()` emits `agent:stop`; OptChat publishes `startedAt`
(`feat/pi-events` @ `15f05e7`); and the module *can* mutate.

**Why it matters:** this is the file a maintainer opens first. A header that says "cannot mutate"
means nobody looks for the control-gate check, the request path or the idempotency key. The one
place in this diff that can stop a running agent is documented as unable to.

**Fix:** rewrite the header — it is the *OptChat event client*, it is observation-only **except**
for the control requests it is allowed to make, and the control gate governs those.

---

### P2-1 — `/pi-stop` cannot tell "no OptChat owner" from "no such run"

**Files:** `extensions/slash.ts` (`handlePiStopInteraction`), `extensions/index.ts` (`readKnownRuns`)

**Reproduced:** with no OptChat owner bound, `/pi-stop abcdef01` replies

> `❌ No background agent matches that run id.`

`readKnownRuns()` returns the (empty) cache, so the selection resolves to `unknown` and the
handler never reaches the owner check.

**Why it matters:** the user is told their run id is wrong, when in fact there is no OptChat at
all. The command they just learned about looks broken. `/pi-agents` already distinguishes the two
cases; `/pi-stop` must too.

**Fix:** make the run list distinguish "no owner" from "no runs" — e.g. `listRuns()` returns
`null` when no owner is bound — and answer "no OptChat owner is bound to this session".

---

### P2-2 — `OUTCOME_UNKNOWN` is reported as a failure

**File:** `extensions/slash.ts` (`stopOutcomeFromCode`)

**Reproduced:** a stop whose result never arrives resolves `OUTCOME_UNKNOWN` and the reply is

> `⚠️ The stop could not be completed.`

`OUTCOME_UNKNOWN` is the one outcome that explicitly means *"the outcome is unknown"* — the stop
may well have worked. The current message asserts the opposite, and it is the message the user
will act on ("retry").

**Why it matters:** the contract's whole point is that a timed-out mutation may still have
happened. Collapsing that into "could not be completed" loses the distinction the contract was
built to preserve, and invites a double-stop.

**Fix:** a distinct outcome and message — "the stop may or may not have happened; check
`/pi-agents`".

---

### P2-3 — The run cache survives an owner replacement

**File:** `extensions/optchat-events.ts` (`bindOwner` / `rememberRuns`)

**Reproduced:**

```
before replacement: [{"runId":"run-old", ... "live":true}]
after  replacement: [{"runId":"run-old", ... "live":true}]     ← still there
agentSnapshot after replacement: null                            ← correctly cleared
after  new snapshot: [{"runId":"run-old","live":false}, {"runId":"run-new","live":true}]
```

`bindOwner()` clears `mainStatus` and `agentSnapshot` — both owner-scoped — but not `knownRuns`,
which is equally owner-scoped. After an owner replacement (OptChat rebuilds the integration when a
gate changes), runs belonging to the **previous** profile remain selectable as `/pi-stop` targets.

**Why it matters:** the failure mode is safe (the stale token yields `STALE_RUN`), but the user is
offered a run from a profile that no longer owns the session. The owner change already clears the
sibling state; the cache is the odd one out.

**Fix:** clear `knownRuns` in `bindOwner()`, exactly as the snapshots are cleared. The new owner's
snapshot republishes the tokens (the token is part of the snapshot's change key).

---

### P2-4 — `POLICY_DENIED` falls into the generic bucket

**File:** `extensions/slash.ts` (`stopOutcomeFromCode`)

**Reproduced:** `POLICY_DENIED` → `⚠️ The stop could not be completed.`

`POLICY_DENIED` is what the owner returns for a **nested, connected or otherwise untargetable**
run. That is a specific, non-rare condition with a specific fix (target a top-level run), and it
is being reported as a generic failure.

**Fix:** its own outcome — "that run cannot be targeted (nested or connected runs are not
controllable)".

---

### P3-1 — The cache's `live` flag is unreliable under the snapshot cap

**File:** `extensions/optchat-events.ts` (`rememberRuns`)

`live` is derived from "is the run in this snapshot", but the fleet snapshot is capped (OptChat
publishes at most 64 agents and reports the rest as `omitted`). A run that is running but was
omitted from a capped snapshot is marked `live: false`.

No decision reads `live` today, so nothing breaks — but the flag is misleading, and the first
caller that trusts it will be wrong.

**Fix:** either drop `live`, or set it from `counts`/the omission state honestly.

---

### P3-2 — `readKnownRuns()` drops two fields

**File:** `extensions/index.ts`

The cache does not store `handingOff` or `currentTool`, so `readKnownRuns()` hard-codes
`handingOff: false` and `currentTool: null`. Harmless for `/pi-stop` (which only needs the id and
the token), but it means the function returns a row that is not what it saw.

**Fix:** store both in the cache, or narrow the type so the function cannot pretend.

---

### P3-3 — The result handler does not check the operation

**File:** `extensions/optchat-events.ts` (`handleAgentResult`)

A result is matched on client id, request id and owner identity, but not on `operation`. A result
published for a different operation that happened to carry the same `requestId` would be consumed.

Not reachable in practice — the request id is unique per request and only this client knows it —
but the check costs nothing and the contract's result envelope carries the field for exactly this.

**Fix:** require `record.operation === "agent:stop"` (or the operation the request was issued
for).

---

## Verdict

**CHANGES REQUIRED.** P1-1 must be fixed before merge: the module that can stop a running agent
is documented as unable to mutate anything.

P2-1 … P2-4 are correctness-of-reporting defects on the new mutation path. Each one was
reproduced, and each one puts a *wrong* statement in front of the user at the moment they are
deciding whether to retry. They are small, mechanical fixes and should land in the same repair
round.

P3-1 … P3-3 are quality findings; P3-1 and P3-2 can wait for a caller, but P3-3 is one line.

---

## Baseline at review time

- `timeout 300s npm test` → 421 tests, 13 files, all pass.
- `timeout 120s npm run check` → clean.
- `timeout 180s npm run build` → clean.
- `git diff --check` → clean.
- No dependency change (`package.json` / `package-lock.json` untouched).
- 14 files changed: 6 modified (`README.md`, `extensions/index.ts`, `extensions/slash.ts`,
  `extensions/status.ts`, 2 test files), 8 new.
