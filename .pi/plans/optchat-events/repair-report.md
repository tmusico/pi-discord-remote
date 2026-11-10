# Repair report — OptChat `pi.events` integration

Repairs for the findings in `review.md` (verdict: **CHANGES REQUIRED** — 1 × P1, 4 × P2, 3 × P3).

Every repair has a regression test, and **every regression test was verified to fail without its
fix** (the negative control): each fix was temporarily reverted, the test was run, and it failed.
The source was restored afterwards.

| # | Finding | Repair | Files | Regression test |
|---|---------|--------|-------|-----------------|
| P1-1 | The module header contradicted the code | The header now describes the client as observation-only **except** for the control requests it may make, and names the control gate as the thing that governs them. The stale "OptChat does not publish `expectedStartedAt`" line is gone. | `extensions/optchat-events.ts` | — (documentation) |
| P2-1 | `/pi-stop` could not tell "no owner" from "no such run" | `listRuns()` now returns `null` when no owner is bound; the handler answers "no OptChat owner is bound to this session" and never asks the owner to stop anything. | `extensions/slash.ts`, `extensions/index.ts` | `R-P2-1` |
| P2-2 | `OUTCOME_UNKNOWN` was reported as a failure | A distinct `unknown` outcome with its own message: *"the stop may or may not have happened — check /pi-agents before retrying"*. The generic "could not be completed" is now reserved for other failures. | `extensions/slash.ts` | `R-P2-2` |
| P2-3 | The run cache survived an owner replacement | `bindOwner()` now clears `knownRuns` alongside the two snapshots — the fleet belongs to the owner. The new owner's snapshot republishes the tokens. | `extensions/optchat-events.ts` | `R-P2-3` |
| P2-4 | `POLICY_DENIED` fell into the generic bucket | A distinct `denied` outcome: *"that run cannot be controlled from Discord (nested and connected runs are not controllable)"*. | `extensions/slash.ts` | `R-P2-4` |
| P3-1 | The `live` flag was unreliable under the snapshot cap | `live` is now `boolean \| null`: `true` in the snapshot, `false` absent from an uncapped snapshot, `null` absent from a **capped** snapshot (the run may still be running — it just was not listed). | `extensions/optchat-events.ts`, `extensions/agents.ts` | `R-P3-1`, `R-P3-1b` |
| P3-2 | `readKnownRuns()` dropped two fields | The cache now stores `handingOff` and `currentTool`, and `readKnownRuns()` returns what it saw instead of hard-coding `false` / `null`. | `extensions/optchat-events.ts`, `extensions/index.ts` | `R-P3-2` |
| P3-3 | The result handler did not check the operation | The pending record stores the operation it was issued for, and a result whose `operation` differs is ignored. | `extensions/optchat-events.ts` | `R-P3-3` |

## Notes on two of the repairs

**P2-2 changes the meaning of `unknown`.** `stopOutcomeFromCode()` maps `OUTCOME_UNKNOWN` to
`unknown`, and `renderStopOutcome()` now renders `unknown` as the *outcome-is-unknown* message.
The generic "could not be completed" is reached only through the `default` branch of
`renderStopOutcome()` — i.e. an outcome kind the handler does not know. `PI_STOP_UNAVAILABLE` is
therefore now a last-resort message rather than the message for "it did not work".

**P3-1 changed a type.** `AgentRow.live` and `OptchatKnownRun.live` are now `boolean | null`.
Nothing reads `live` for a decision yet, so this is a type-level honesty fix; the alternative —
keeping `boolean` and lying — is what the finding was about.

## Validation after the repairs

- `timeout 300s npm test` → **429 tests**, 13 files, all pass (was 421; +8 regression tests).
- `timeout 120s npm run check` → clean.
- `timeout 180s npm run build` → clean.
- `git diff --check` → clean.
- No dependency change.
