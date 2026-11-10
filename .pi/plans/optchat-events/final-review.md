# Final review — OptChat `pi.events` integration

Read-only re-review of the diff after the repair round (`review.md` → `repair-report.md`).

**Verdict: ACCEPT** — no open P0/P1/P2 findings. One P3 remains, recorded below as a known
limitation rather than a defect.

---

## Findings from `review.md` — all closed

| # | Finding | Status | How it was verified |
|---|---------|--------|---------------------|
| P1-1 | The module header contradicted the code | **Closed** | The header now names the client as observation-only *except* for the control requests it may make, and names the control gate as the thing that governs them. The stale "`expectedStartedAt` … does not publish yet" line is gone. |
| P2-1 | `/pi-stop` could not tell "no owner" from "no such run" | **Closed** | `listRuns()` returns `null` with no owner → the reply is "no OptChat owner is bound to this session" and nothing is sent. `R-P2-1`. |
| P2-2 | `OUTCOME_UNKNOWN` was reported as a failure | **Closed** | Its own outcome and message: *"the stop may or may not have happened — check /pi-agents before retrying"*. The generic message is now the last-resort branch. `R-P2-2`. |
| P2-3 | The run cache survived an owner replacement | **Closed** | `bindOwner()` clears `knownRuns` with the snapshots. `R-P2-3`. |
| P2-4 | `POLICY_DENIED` fell into the generic bucket | **Closed** | Its own outcome: nested and connected runs are not controllable. `R-P2-4`. |
| P3-1 | The `live` flag was unreliable under the snapshot cap | **Closed** | `live` is `boolean \| null`; `null` means "absent from a capped snapshot — may still be running". `R-P3-1`, `R-P3-1b`. |
| P3-2 | `readKnownRuns()` dropped two fields | **Closed** | The cache stores `handingOff` and `currentTool`; the function returns what it saw. `R-P3-2`. |
| P3-3 | The result handler did not check the operation | **Closed** | The pending record carries the operation; a mismatched result is ignored. `R-P3-3`. |

**Negative controls:** every regression test was run against a temporarily reverted fix and
**failed** — 7 for 7, plus `R-P2-3b`. The fixes are not merely asserted by the tests that were
written alongside them.

---

## One risk the repair introduced — checked, not assumed

Clearing the run cache on an owner change (P2-3) could have broken the **normal** path: a
capability *replay* — which `refresh()` triggers on every session start — is not an owner
replacement, and wiping the cache there would silently drop every `/pi-stop` target after a
session start.

`bindOwner()` early-returns when the epoch is unchanged, so a replay does not clear. Verified
directly: `R-P2-3b` publishes the capability advertisement and a `replayed-ready` owner event for
the *same* epoch after a snapshot, and the cached run and its token survive.

---

## Re-verification of the whole diff

| Area | Result |
|------|--------|
| **Request envelope** | Unchanged by the repairs; still parses against OptChat's own `parseEventRequest()` (`parse ok: true`). |
| **Result envelope** | Unchanged; still matches OptChat's `eventRequestResult()` output shape. |
| **Owner binding** | Foreign snapshots ignored; replaced owner's snapshots dropped; a `closing` for another owner does not unbind. A replay for the same epoch does not drop the cache. |
| **Consent defaults** | A missing or malformed consent section is read as *not permitted*. The control gate is checked **before** the request is emitted — with the gate off nothing reaches the bus. |
| **Terminal vs accepted** | `accepted` is not terminal; the request stays pending. |
| **Result filtering** | Client id, request id, owner identity **and** operation must all match. |
| **No hanging promises** | No result → `OUTCOME_UNKNOWN`; a disposed client settles every pending request. |
| **Leak hygiene** | Only fixed codes and fixed messages cross the Discord boundary. The run id, the model, the tool and the token are never echoed back. |
| **Degradation** | No OptChat → `/pi-status` has no OptChat field, `/pi-agents` says "no OptChat owner", `/pi-stop` says "no OptChat owner" and sends nothing. |
| **Scope** | No dependency change; no change to message injection; no change to the existing `pi.on(...)` hooks; no Discord command beyond the three the plan names. |

## Validation

- `timeout 300s npm test` → **430 tests**, 13 files, all pass.
- `timeout 120s npm run check` → clean.
- `timeout 180s npm run build` → clean.
- `git diff --check` → clean.
- 17 files changed (6 modified, 11 new): 2 source modules, 4 test files, 6 plan documents, plus
  `README.md`, `extensions/status.ts`, `extensions/slash.ts` and `extensions/index.ts`.
- No dependency change (`package.json` / `package-lock.json` untouched).

## Known limitation (not a defect)

The `/pi-stop` target is named by the **generation token**, so a run this extension never saw
while it was running cannot be targeted — there is no published token for it. The reply says so
("that run's generation token is not published") rather than guessing. This is the contract's
design, not a gap in the implementation.

## Not done (deliberately)

- `/pi-history` — needs OptChat's content gate; the 60 s cursor TTL makes it a catch-up, not an
  archive.
- Live output streaming — rejected by the user.

## Done definition

- [x] Every finding in `review.md` is closed, with a regression test and a verified negative
      control.
- [x] The full validation is green on the branch tip.
- [x] The plan artifacts (`PLAN.md`, `CHECKLIST.md`, `EXECUTION_PLAN.md`) match the code.
- [ ] The commit + push decision is the user's.
