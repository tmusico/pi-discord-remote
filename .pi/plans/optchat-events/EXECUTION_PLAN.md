# EXECUTION PLAN — OptChat `pi.events` integration (read-only)

Source: `.pi/plans/optchat-events/PLAN.md` + `CHECKLIST.md`.

**Status:** Increment 1 (Phases 1–5 of the CHECKLIST) is **done**. This document describes the
remaining slices: the queued follow-ups and the review. It is written for a fresh subagent that has
**not** seen the earlier work.

## Execution rules

- **One writer per working tree.** The steps below are sequential.
- The parent (the session that owns this repo) owns acceptance, the commit and the push.
  Implementors never commit, push, publish or bump the package version.
- The branch is `feat/slash-control` (the current branch). `main` is never touched.
- Every step must run its targeted validation and report the exact command + result.
- **Stop conditions** (report and stop, do not improvise):
  - a design question the plan does not answer that changes user-visible behavior;
  - a need for a new runtime dependency;
  - a need for an OptChat-side change that is not already listed in the plan's "Blocked follow-ups";
  - validation that fails twice for the same reason without a diagnosis.
- Do not "improve" unrelated code. Keep the diff scoped to the plan.
- Prefer pure, exported helpers (the house pattern: `resolveSessionState`, `buildStatusView`,
  `parseOptchatMainStatus` …) so behavior is testable without a live Discord client or a live Pi.

## Model guidance

| Role | Model | Why |
|------|-------|-----|
| Implementor | `minimax/MiniMax-M3` | contained implementation work; cheapest capable model |
| Reviewer | `kimi-coding/k3.1-pro` | independent read-only review, cheaper than the Terra reviewer |
| Escalation | none | if a step needs deeper reasoning, stop and report instead of escalating |

## Step 0 — Orientation (micro-worker)

- **Agent / model:** micro-worker — `minimax/MiniMax-M3`
- **Turn budget:** ≤ 5 turns.
- **Goal:** confirm the starting state before writing any code.
- **Actions:**
  1. Read `.pi/plans/optchat-events/PLAN.md` (all of it) and `CHECKLIST.md`.
  2. Read `extensions/optchat-events.ts` — the pure client that already exists.
  3. Read `extensions/status.ts` (`StatusState`, `buildOptchatValue`, `buildStatusView`) and the
     `optchat*` block of `extensions/index.ts` (`buildStatusState`).
  4. Run `timeout 120s npm run check` and `timeout 300s npm test` and report the totals.
- **Deliverable:** a short report: the current test total, the exact exported API of
  `extensions/optchat-events.ts`, and any drift between the plan and the code.
- **Files in scope:** read-only.
- **Handoff:** the API surface, the test count, and any drift. No transcript.

## Step 1 — `/pi-agents` command (implementor)

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Turn budget:** ≤ 20 turns.
- **Goal:** a guild-scoped, ephemeral Discord command that lists the OptChat profile's background
  agents.
- **Actions:**
  1. Follow the house pattern of `/pi-status` and `/pi-model` in `extensions/slash.ts`:
     - a `PI_AGENTS_COMMAND` definition (`name: "pi-agents"`, `type: 1`, description ≤ 100 chars);
     - add it to the `PI_SLASH_COMMANDS` array in `extensions/index.ts` — registration is per
       command and **upsert by name**, so the guild's other commands are never touched;
     - a `handlePiAgentsInteraction(interaction, deps)` handler: allow-list gate → `deferReply({
       ephemeral: true })` → ephemeral reply;
     - route it in `routePiInteraction` **after** the autocomplete branch.
  2. Build the reply from `optchatEvents.getState().agentSnapshot`:
     - no snapshot → "No OptChat owner is bound to this session."
     - a snapshot with zero agents → "No background agents in this profile."
     - otherwise one row per agent: run id (truncated), state, model, elapsed, current tool, depth.
  3. Add the pure row-rendering to `extensions/status.ts` (or a new pure module next to it) so it is
     unit-testable without Discord — follow `buildStatusView`'s house style.
  4. Cap the rows (≤ 20) and say so when the fleet snapshot omitted runs
     (`counts.omitted > 0`).
  5. Write `extensions/__tests__/slash-agents.test.ts` (fake client/interaction, no network) and
     extend the status tests for the row renderer.
- **Deliverable:** `extensions/slash.ts` (edit), `extensions/index.ts` (edit), the pure renderer
  (edit or new module), `extensions/__tests__/slash-agents.test.ts` (new).
- **Files in scope:** the four above plus `extensions/status.ts`. Do **not** touch
  `extensions/optchat-events.ts` (read-only for this step) or the README.
- **Validation:** `timeout 180s npx vitest run extensions/__tests__/slash-agents.test.ts` and
  `timeout 120s npm run check`.
- **Handoff:** changed files, the exported API, validation output, open questions.

## Step 2 — README + plan-artifact sync (implementor)

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Turn budget:** ≤ 10 turns.
- **Goal:** the docs match the shipped behavior.
- **Actions:**
  1. Add a README section: what the OptChat integration shows, the **same-process precondition**
     (OptChat installed *and* a profile open in this process — not for `pi -p`/JSON, not for a
     session that *joined* another Pi's profile), and the degradation matrix.
  2. Document `/pi-agents` (behavior, allow-list, hub mode) in the same style as `/pi-status`.
  3. Tick the Step-1 boxes in `.pi/plans/optchat-events/CHECKLIST.md`.
- **Deliverable:** `README.md` (edit), `.pi/plans/optchat-events/CHECKLIST.md` (edit).
- **Validation:** `timeout 120s npm run check`.
- **Handoff:** changed files, the new README section's outline.

## Step 3 — Independent review (reviewer)

- **Agent / model:** reviewer — `kimi-coding/k3.1-pro`, **read-only**.
- **Turn budget:** ≤ 15 turns.
- **Goal:** an independent verdict on the whole diff.
- **Actions:**
  1. Read the full diff against the branch base, plus `.pi/plans/optchat-events/PLAN.md`.
  2. Check specifically:
     - **owner correctness** — a foreign snapshot is ignored; a replaced owner's snapshots are
       dropped; a `closing` for another owner does not unbind the current one;
     - **consent defaults** — a missing or malformed `content`/`control` section is read as *not
       permitted*;
     - **error hygiene** — no listener throws into Pi; no payload, path, token or Discord id is
       logged; the fixed error codes are the only thing surfaced;
     - **degradation** — with no OptChat the extension behaves exactly as before; the OptChat status
       field is dropped when there is no owner;
     - **lifecycle** — the listeners are attached before the pings; `dispose()` is called on session
       shutdown; a reload re-creates the client;
     - **scope** — no new dependency, no Discord command registered beyond the plan, no change to
       message injection.
  3. Run `timeout 300s npm test`, `timeout 120s npm run check`, `timeout 180s npm run build` and
     `git diff --check`.
  4. Write `.pi/plans/optchat-events/review.md` with a verdict of **ACCEPT**, **ACCEPT WITH
     FINDINGS** or **CHANGES REQUIRED**, and every finding as P0/P1/P2 with a concrete fix.
- **Deliverable:** `.pi/plans/optchat-events/review.md`.
- **Files in scope:** read-only — the reviewer edits nothing.
- **Handoff:** the verdict and the findings list.

## Step 4 — Repair (implementor), only if the review demands it

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Turn budget:** ≤ 15 turns.
- **Goal:** close every P0/P1 finding.
- **Actions:**
  1. Fix only the findings listed in `review.md`.
  2. Add a regression test per finding — a test that fails without the fix.
  3. Write `.pi/plans/optchat-events/repair-report.md` listing each finding, the fix and the test.
  4. Re-run the full validation.
- **Deliverable:** the fixes, the regression tests, `repair-report.md`.
- **Validation:** `timeout 300s npm test`, `timeout 120s npm run check`, `timeout 180s npm run build`.
- **Handoff:** the findings closed, the validation output, anything still open.

## Step 5 — Final review (reviewer), after a repair round

- **Agent / model:** reviewer — `kimi-coding/k3.1-pro`, **read-only**.
- **Turn budget:** ≤ 15 turns.
- **Goal:** confirm the repair round closed the findings and introduced nothing new.
- **Actions:** re-read the diff, re-run the validation, write
  `.pi/plans/optchat-events/final-review.md` with a verdict.
- **Deliverable:** `final-review.md`.
- **Handoff:** the verdict and any remaining finding.

## Step 6 — Parent acceptance

- The parent re-runs the full validation, updates `CHECKLIST.md`, and reports the outcome.
- **The commit and push are the user's decision** — the parent must not push without an explicit
  go-ahead.

## Not in this plan

- `/pi-stop` — blocked on the OptChat side publishing `startedAt` (see the PLAN's "Blocked
  follow-ups"). Do not implement it against a guessed timestamp.
- `/pi-history` — needs the content gate and a decision about what a 60 s cursor is worth.
- Live output streaming — rejected by the user.
