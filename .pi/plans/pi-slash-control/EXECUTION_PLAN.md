# EXECUTION PLAN — Discord `/pi-abort` and `/pi-model`

Source: `.pi/plans/pi-slash-control/PLAN.md` + `CHECKLIST.md`.

## Execution rules

- **One writer per working tree.** Steps 1–2 and Step 3–4 are separate implementor delegations;
  they must not run concurrently.
- The parent (this session) owns acceptance, the commit and the push. Implementors never commit,
  push, publish or bump the package version.
- The branch is `feat/slash-control`, cut from `feat/slash-status`. `main` is never touched.
- Every step must run its targeted validation and report the exact command + result.
- **Stop conditions** (report and stop, do not improvise):
  - a design question that the plan does not answer and that changes user-visible behavior;
  - a required change to `/pi-status` behavior beyond shared registration/routing plumbing;
  - a need for a new runtime dependency;
  - validation that fails twice for the same reason without a diagnosis.
- Do not "improve" unrelated code. Keep the diff scoped to the plan.
- Prefer pure, exported helpers (the existing pattern: `resolveSessionState`, `readAgentIdleSafe`,
  `readContextUsageSafe` live in `extensions/index.ts` and are unit-tested) so behavior is testable
  without a live Discord client or a live Pi session.

## Model guidance

| Role | Model | Why |
|------|-------|-----|
| Implementor | `minimax/MiniMax-M3` | contained implementation work; cheapest capable model |
| Reviewer | `kimi-coding/k3.1-pro` | independent read-only review, cheaper than the Terra reviewer |
| Escalation | none | if a step needs deeper reasoning, stop and report instead of escalating |

## Step 1 — Pure model-control module (implementor)

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** create `extensions/model-control.ts` (pure) plus its unit tests.
- **Actions:**
  1. Read `.pi/plans/pi-slash-control/PLAN.md` (sections "Target architecture" → "Model catalog
     rules" and "Model selection rules") and `extensions/status.ts` for the house style of a pure
     view-model module.
  2. Implement the types and functions exactly as specified:
     `ModelLike`, `ModelCatalogEntry`, `ModelCatalog`, `ModelSelection`,
     `buildModelCatalog(models, currentId, limit = 20)`, `resolveModelSelection(catalog, query)`,
     `buildModelListEmbed(catalog)`, `formatModelListText(catalog)`.
  3. Deterministic ordering: current model first, then provider, then model id.
  4. Resolution order: exact qualified id → exact bare id → prefix of qualified id → prefix of bare
     id → unknown. `exact` when one candidate, `ambiguous` when several (list the qualified ids,
     cap at 5), `unknown` with up to 5 substring suggestions.
  5. Never emit `undefined`, `NaN` or an empty label; a missing model name falls back to the
     model id; an empty candidate list renders an explicit "no models available" line.
  6. Write `extensions/__tests__/model-control.test.ts` covering: sorting, truncation flag,
     resolution of every branch (exact qualified, unique bare, ambiguous bare, unique prefix,
     ambiguous prefix, unknown, unknown-with-suggestions), empty list, missing name, and the
     plain-text formatter.
- **Deliverable:** `extensions/model-control.ts`, `extensions/__tests__/model-control.test.ts`.
- **Files in scope:** the two files above (plus type-only imports). Do **not** touch
  `extensions/slash.ts`, `extensions/index.ts` or the README.
- **Validation:** `timeout 180s npx vitest run extensions/__tests__/model-control.test.ts` and
  `timeout 120s npm run check`.
- **Handoff:** changed files, exported API signatures, validation output, open questions.

## Step 2 — Command definitions, registration, handlers (implementor)

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** add the two command definitions, a generic idempotent registration and the two
  interaction handlers (plus autocomplete) in `extensions/slash.ts`, with unit tests.
- **Actions:**
  1. Read `extensions/slash.ts` (whole file) and `extensions/__tests__/slash.test.ts` to match the
     existing structural-type and fake-object style.
  2. Add `PI_ABORT_COMMAND` and `PI_MODEL_COMMAND` (see PLAN "Target architecture" for the exact
     option shape). Descriptions ≤ 100 chars, names lowercase.
  3. Add `registerPiCommands(client, token, guildId, commands[])`:
     - fetch the guild's commands **once**, index them by name;
     - for each requested command: `edit` the existing command with that name, else `create` it;
     - never call a bulk replace; commands of other bots / other names are untouched;
     - keep the existing missing-scope hint and token redaction behavior.
  4. Re-implement `registerPiStatusCommand` as a thin wrapper over `registerPiCommands` so the
     existing tests keep passing unchanged.
  5. Add `handlePiAbortInteraction(interaction, deps)` with
     `deps = { allowedUserIds?, abortRun: () => PiAbortOutcome | Promise<PiAbortOutcome> }` and
     outcomes `aborted | idle | no_session | unsupported` (exact reply texts in the PLAN).
  6. Add `handlePiModelInteraction(interaction, deps)` with
     `deps = { allowedUserIds?, listModels(), currentModelId(), switchModel(id) }` and outcomes
     `switched | unknown | ambiguous | no_auth | failed | no_session`.
     - No argument → ephemeral list embed (or the plain-text fallback when the catalog is empty).
     - With an argument → resolve through `resolveModelSelection`; `unknown`/`ambiguous` never
       switch a model.
  7. Add `handlePiModelAutocomplete(interaction, deps)` — filter candidates by the typed value,
     answer with ≤ 25 choices, never throw.
  8. Extend the structural interaction type with an optional
     `options?: { getString(name: string): string | null }` so existing fakes stay valid.
  9. Every path replies ephemerally (allowed, refused, error). Errors are logged locally with a
     short, leak-free description; the Discord reply never contains the bot token, the system
     prompt, a raw provider error or file contents.
  10. Write `extensions/__tests__/slash-control.test.ts` (fake client/interaction, no network):
      registration upsert for three commands (existing command edited, missing one created, a
      foreign guild command never touched, no bulk replace), the missing-scope hint, allow-list
      refusal for both commands, every abort outcome, model list, successful switch, unknown
      input, ambiguous input, `no_auth`, `failed`, autocomplete filtering and the ≤ 25 cap, and
      a regression asserting no reply text contains the token.
- **Deliverable:** `extensions/slash.ts` (extended), `extensions/__tests__/slash-control.test.ts`.
- **Files in scope:** `extensions/slash.ts`, `extensions/__tests__/slash-control.test.ts`,
  `extensions/model-control.ts` (read-only — do not change its public API; if a change is truly
  required, report it instead). Do **not** touch `extensions/index.ts` or the README.
- **Validation:** `timeout 240s npx vitest run extensions/__tests__/slash-control.test.ts
  extensions/__tests__/slash.test.ts` and `timeout 120s npm run check`.
- **Handoff:** changed files, exported API signatures, new dependency-injection seams (so Step 3
  knows what to inject), validation output, open questions.

## Step 3 — Wiring in `extensions/index.ts` (implementor)

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** register and route the two new commands and implement the three session-side helpers
  (`abortCurrentRun`, `listSessionModels`, `switchSessionModel`).
- **Actions:**
  1. Read `extensions/index.ts` around the `/pi-status` wiring (the status snapshot builder, the
     `interactionCreate` handler, `registerStatusCommand`, `connect`/`ready` paths, the
     `questionResolver`/`questionRejecter` state and `cancelPendingQuestion`).
  2. Generalize the registration to register **all three** commands (pi-status, pi-abort,
     pi-model) idempotently on connect and after reconnect; per-command error reporting; a
     failure stays non-fatal (the extension keeps working).
  3. Extend the `interactionCreate` handler: handle the **autocomplete** branch first
     (`interaction.isAutocomplete?.()` + `commandName === "pi-model"`), then dispatch chat-input
     commands by `commandName` to the three handlers; unknown commands are ignored.
  4. Implement `abortCurrentRun()`:
     - no active session → `{ kind: "no_session" }`;
     - captured ctx missing/throws → `{ kind: "unsupported" }`;
     - not running (`!agentBusy && readAgentIdleSafe(ctx) !== false`) → `{ kind: "idle" }`;
     - otherwise: reject a pending Discord question (so the turn cannot hang) and call
       `ctx.abort()` inside a try/catch → `{ kind: "aborted" }`.
     Never end the session, delete the channel or disconnect the bot.
  5. Implement `listSessionModels()`: prefer `ctx.scopedModels` (map `entry.model`), otherwise
     `ctx.modelRegistry.getAvailable()` filtered by `ctx.modelRegistry.hasConfiguredAuth(model)`;
     every access guarded like the existing `readAgentIdleSafe` helper.
  6. Implement `switchSessionModel(id)`: resolve the model object from the candidate list,
     call `pi.setModel(model)`; `false` → `{ kind: "no_auth" }`; a thrown error → `{ kind: "failed" }`
     with the raw error logged locally only.
  7. Export the pure parts so they are unit-testable, following the existing pattern of exported
     helpers in `extensions/index.ts` (e.g. a `readModelsSafe(ctx)`-style helper).
  8. Add tests in `extensions/__tests__/index-wiring.test.ts` (or extend an existing test file if
     that fits better) covering the exported helpers: guarded ctx reads, scoped-vs-available
     selection, auth filtering, and the abort outcome mapping.
- **Deliverable:** `extensions/index.ts` (extended), `extensions/__tests__/index-wiring.test.ts`.
- **Files in scope:** `extensions/index.ts`, `extensions/__tests__/index-wiring.test.ts`. Read-only:
  `extensions/slash.ts`, `extensions/model-control.ts`.
- **Validation:** `timeout 300s npm test`, `timeout 120s npm run check`, `timeout 180s npm run build`.
- **Handoff:** changed files, the exact injection points used, validation output, open questions.

## Step 4 — Autocomplete polish, docs, full validation (implementor)

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** finish the autocomplete path end-to-end, document both commands, and run the complete
  validation suite.
- **Actions:**
  1. Verify the autocomplete path works end-to-end: option shape in the command definition →
     registration body → `isAutocomplete()` branch → ≤ 25 filtered choices. Fix anything broken.
  2. Make the model list readable on a phone: the current model is marked, the total count is
     stated when the list is truncated, and the reply stays within Discord's embed limits
     (title ≤ 256, description ≤ 4096, ≤ 25 fields) — fall back to plain text when it does not fit.
  3. Update `README.md`: document `/pi-abort` and `/pi-model` (behavior, every outcome, the
     allow-list gate, hub mode / "no session connected", and the note that `/pi-abort` keeps the
     session alive). Keep the existing structure and tone; do not rewrite unrelated sections.
  4. Run the full validation: `timeout 300s npm test`, `timeout 120s npm run check`,
     `timeout 180s npm run build`, `git diff --check`.
  5. Report the final diff stat (`git diff --stat` + untracked files) and list every file changed.
- **Deliverable:** final implementation + README update + validation report.
- **Files in scope:** `extensions/**`, `README.md`. No commit, no push.
- **Validation:** the four commands above.
- **Handoff:** changed files, validation output, remaining risks.

## Step 5 — Independent review (reviewer, read-only)

- **Agent / model:** reviewer — `kimi-coding/k3.1-pro`
- **Goal:** an independent, fresh-context review of the whole change set.
- **Actions:**
  1. Review the diff against `main` **and** the untracked files (list them explicitly):
     `extensions/model-control.ts`, `extensions/slash.ts`, `extensions/index.ts`, the new tests and
     `README.md`.
  2. Check specifically:
     - allow-list enforcement and ephemeral replies on **every** path of both commands;
     - no secret leakage (token, system prompt, raw provider error, file contents) in any reply or
       log line;
     - abort semantics: the run stops, the session/channel/bot survive, a pending question is
       rejected, and the outcome mapping is correct;
     - model resolution correctness (exact/ambiguous/unknown, full-list vs truncated list,
       case-insensitivity, determinism);
     - `pi.setModel` false → `no_auth`; exceptions → `failed`;
     - guarded ctx access everywhere (a stale ctx must degrade, never crash);
     - registration is upsert-by-name and never bulk-replaces the guild's commands;
     - the autocomplete branch is handled before the `isChatInputCommand()` check;
     - test quality: are the regressions real (would they fail without the fix)?
  3. Report concrete findings with file + line, severity (P0/P1/P2/P3), and a suggested fix.
     Report "no issues" explicitly if that is the case. Do not edit any file.
- **Deliverable:** review report (also written to `.pi/plans/pi-slash-control/review.md`).
- **Files in scope:** read-only.
- **Validation:** the reviewer may run `timeout 300s npm test` if it is cheap; it is not required.

## Step 6 — Repairs (implementor) — only if Step 5 finds blockers

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** fix every P0/P1 finding from Step 5; add the missing regressions.
- **Actions:** fix the reported defects, add a regression test per defect, re-run the full
  validation, and list the findings with their status (fixed / not fixed + why).
- **Deliverable:** repaired implementation + validation report.
- **Files in scope:** the files named by the findings.
- **Validation:** `timeout 300s npm test`, `timeout 120s npm run check`, `timeout 180s npm run build`,
  `git diff --check`.

## Step 7 — Final re-review (reviewer, read-only) — only if Step 6 changed code

- **Agent / model:** reviewer — `kimi-coding/k3.1-pro`
- **Goal:** confirm the repairs actually close the findings and introduced no new defect.
- **Actions:** re-read only the repaired areas, verify each finding is closed, report remaining
  findings.
- **Deliverable:** re-review report (`.pi/plans/pi-slash-control/repair-review.md`).

## Step 8 — Parent acceptance (parent session, not delegated)

- **Actions:**
  1. Re-run `timeout 300s npm test`, `timeout 120s npm run check`, `timeout 180s npm run build`,
     `git diff --check` on the branch tip.
  2. Read the diff for scope, secret hygiene and the plan's acceptance criteria.
  3. Update `CHECKLIST.md` (tick the boxes that are actually done).
  4. Report to the user; **commit and push only with the user's go-ahead**.
