# EXECUTION PLAN — Discord `/pi-status` slash command

Source plan: `.pi/plans/pi-slash-status/PLAN.md`
Checklist: `.pi/plans/pi-slash-status/CHECKLIST.md`

## Execution rules

- One writer at a time. Steps 1–4 are sequential and each owns a disjoint file scope; the reviewer
  (Step 5) is read-only.
- Never commit, push, publish, or deploy from a step. The parent owns git and publication.
- Do not delete or rewrite existing behavior outside the file scope of the step.
- Follow existing repo conventions: ESM, `node:` built-ins, `discord.js` v14, vitest unit tests in
  `extensions/__tests__/*.test.ts`, pure helpers in their own module (see `helpers.ts`, `config.ts`).
- Repo scripts: `npm run check` (tsc --noEmit), `npm test` (vitest run), `npm run build` (tsc).
- Bounded validation per step: `timeout 180s npm run check`, `timeout 180s npm test`,
  `timeout 180s npm run build`.
- Stop condition for every step: if the task is ambiguous in a way that could corrupt user data or
  change documented behavior, stop and report the question instead of inventing a decision.

## Step 1 — Pure status view model

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** create the pure status view model and formatters with unit tests.
- **Actions:**
  1. Create `extensions/status.ts` with **no discord.js import** (pure data + formatting only).
  2. Define the state union: `"no_session" | "idle" | "working" | "waiting" | "error"`.
  3. Define a `StatusState` input interface with every field optional-ish and explicitly
     nullable: state, model id/name/provider, thinking level, cwd, git branch/sha/dirty count,
     context tokens/window, session id/name, entry count, channel name/id, bot tag, reconnect
     attempts, last prompt time, run start time, last tool name, error message.
  4. `buildStatusView(state)` → normalized view model (never emits `undefined`, `NaN`, or
     `null` inside strings).
  5. `buildStatusEmbed(view)` → **plain object** `{ title, description, fields: [{name,value,inline}], color }`
     suitable for `channel.send({ embeds: [obj] })`. Use Discord field limits (≤25 fields,
     field value ≤1024 chars, description ≤4096 chars) and truncate long values.
  6. `formatStatusText(view)` → plain-text fallback of the same content.
  7. Add `extensions/__tests__/status.test.ts` covering every state, plus missing/partial fields,
     truncation, and the `unknown` fallbacks.
- **File scope:** `extensions/status.ts`, `extensions/__tests__/status.test.ts` (new files only).
- **Validation:** `timeout 180s npm test -- status` and `timeout 180s npm run check`.
- **Turn budget:** ~12 turns. **Checkpoint:** report the exported symbol names and the exact
  embed shape so Step 2 can consume them without re-reading the file.
- **Deliverable:** the two files + passing focused tests.
- **Handoff (to Step 2):** exported names, the `StatusState` field list, embed shape.

## Step 2 — Command definition, registration, interaction handler

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** create `extensions/slash.ts` with the command definition, idempotent guild
  registration, and the interaction handler, plus tests.
- **Actions:**
  1. Create `extensions/slash.ts` importing from `./status.js` (Step 1 output).
  2. Export the command definition: name `pi-status`, type chat input (`type: 1`), a one-line
     description, no options.
  3. `registerPiStatusCommand(client, token, guildId)`:
     - fetch existing guild commands, find the one named `pi-status`;
     - update it in place when present, otherwise create it;
     - **never** bulk-`PUT`/replace the guild's whole command set;
     - wrap in try/catch; detect the "missing `applications.commands` scope" failure (403 /
       "Missing Access") and return a structured result carrying a re-invite hint that includes
       the application id and `scope=bot%20applications.commands`;
     - return `{ ok: true } | { ok: false, error: string, hint?: string }`.
  4. `handlePiStatusInteraction(interaction, deps)` where `deps` carries the allow-list, a
     snapshot provider, and the Discord client:
     - refuse (ephemerally, with a short message) when the user is not on `allowedUserIds`;
     - `deferReply({ ephemeral: true })` **before** any slow work;
     - build the view, then `editReply({ embeds: [embed] })`;
     - every path replies ephemerally, including internal errors (a short "status unavailable"
       message; never a stack trace, token, or system prompt).
  5. Tests in `extensions/__tests__/slash.test.ts` with **fake** client and interaction objects
     (no network, no real Discord types required at runtime): registration is idempotent and does
     not remove other commands; allow-list refusal; ephemeral defer/edit; error path stays
     ephemeral and leaks nothing.
- **File scope:** `extensions/slash.ts`, `extensions/__tests__/slash.test.ts` (new files only).
- **Validation:** `timeout 180s npm test -- slash` and `timeout 180s npm run check`.
- **Turn budget:** ~12 turns. **Checkpoint:** report the exported function signatures and the
  `deps` contract exactly as implemented.
- **Deliverable:** the two files + passing focused tests.
- **Handoff (to Step 3):** exported names, `deps` shape, registration result shape.

## Step 3 — Wire it into the extension

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** make `/pi-status` work end-to-end in the running extension and add hub mode.
- **Actions:**
  1. In `extensions/index.ts`:
     - track the active model from the `model_select` event (`event.model`);
     - track run state and elapsed time (`agent_start` → `runStartedAt`, `agent_end` → clear) and
       the last tool name (`tool_execution_start` / `tool_execution_end`);
     - track `lastPromptAt` when a Discord message is injected;
     - treat an outstanding `discord_ask_user_question` answer as the `waiting` state;
     - treat `reconnectFailed` / an aborted last turn as the `error` state.
  2. Capture a `ctx` reference (from `session_start` / `agent_start`) for `ctx.getContextUsage()`,
     `ctx.sessionManager.getSessionId()` / `getSessionName()`, and the entry count; **guard every
     access with try/catch** (a captured ctx throws after session replacement or reload) and fall
     back to tracked state.
  3. Register `client.on("interactionCreate", ...)`; route chat-input commands named `pi-status` to
     `handlePiStatusInteraction`; ignore everything else.
  4. After the client is `ready`, call `registerPiStatusCommand(...)`; on failure log a clear
     error (including the re-invite hint) to the console and the TUI — **non-fatal**.
  5. Hub mode: `stop` deletes the session channel and clears session state but keeps the client
     connected when `keepOnline !== false`; update the TUI message accordingly. Add a new
     `disconnect` Pi command that destroys the client completely. `session_shutdown` keeps its
     current full-teardown behavior. In hub mode the message handler must ignore all channel
     messages.
  6. `extensions/config.ts`: add `keepOnline?: boolean` to `Config` and to
     `defaultConfigTemplate()`.
  7. Add or extend tests under `extensions/__tests__/` covering the state-tracking helpers
     (pure parts only — do not try to unit-test the discord.js client).
- **File scope:** `extensions/index.ts`, `extensions/config.ts`,
  `extensions/__tests__/*.test.ts` (new/extended tests only).
- **Validation:** `timeout 180s npm run check`, `timeout 180s npm test`, `timeout 180s npm run build`.
- **Turn budget:** ~14 turns. **Checkpoint:** report every behavior change to `stop`, the new
  `disconnect` command, and the config addition.
- **Deliverable:** wired extension + passing full suite.
- **Handoff (to Step 4):** list of changed files, behavior deltas, validation output summary.

## Step 4 — Documentation and final validation

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** document the feature and confirm the whole repo is green.
- **Actions:**
  1. Update `README.md`:
     - `/pi-status` in the usage list with a short description;
     - the `applications.commands` OAuth scope requirement plus a ready-to-use re-invite URL
       template (`https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot%20applications.commands&permissions=...`);
     - hub mode, the `keepOnline` config key, and the `disconnect` command;
     - a note that status replies are ephemeral.
  2. Re-read the diff for leftovers (TODO comments, debug logging, unused imports).
  3. Run the full validation: `timeout 180s npm run check`, `timeout 180s npm test`,
     `timeout 180s npm run build`, `git diff --check`.
- **File scope:** `README.md` only.
- **Validation:** as above.
- **Turn budget:** ~8 turns. **Checkpoint:** report the final validation results verbatim
  (test counts, check/build status).
- **Deliverable:** updated README + green validation.

## Step 5 — Independent review

- **Agent / model:** reviewer — `kimi-coding/k3.1-pro` (read-only)
- **Goal:** an independent check of the whole change against `PLAN.md` / `CHECKLIST.md`.
- **Actions:** review the diff (`git diff` + untracked files) for:
  - correctness of the state machine and the `waiting` state;
  - stale-`ctx` safety (every ctx read guarded);
  - idempotent registration that cannot delete other commands of the same app;
  - allow-list enforcement and secret leakage (token, system prompt, file contents);
  - the 3-second interaction window (defer before slow work) and bounded git calls;
  - hub-mode semantics: message handling inert without a session channel, `disconnect` and
    `session_shutdown` teardown correctness;
  - test quality (are the new tests meaningful, do they cover the checklist?);
  - scope creep beyond `/pi-status`.
- **Deliverable:** a review report at `.pi/plans/pi-slash-status/review.md` with findings split into
  blocking / non-blocking / notes, each with file+line and a concrete fix. **No code edits.**
- **Turn budget:** ~10 turns. **Stop condition:** if the working tree is not in the state Step 4
  left it, stop and report instead of reviewing a different tree.

## Step 6 — Repairs and re-review

- **Agent / model:** implementor — `minimax/MiniMax-M3` (repair), then reviewer
  `kimi-coding/k3.1-pro` (re-review)
- **Goal:** resolve every blocking finding from Step 5 and confirm the fixes.
- **Actions:**
  1. Repair **only** the blocking findings; keep the repair minimal and inside the same file
     scopes used above.
  2. Add or update a regression test for each repaired defect.
  3. Re-run `timeout 180s npm run check && timeout 180s npm test && timeout 180s npm run build`.
  4. Hand off to the reviewer for a focused re-review of the repaired areas only; write the result
     to `.pi/plans/pi-slash-status/review-round-2.md`.
- **Turn budget:** ~12 turns for the repair, ~6 for the re-review.
- **Stop condition:** if a blocking finding cannot be fixed without a design decision that the plan
  does not cover, stop and report the decision needed.

## Completion criteria

- [ ] Steps 1–4 complete with the full validation green.
- [ ] Step 5 review has no blocking findings (after Step 6 repairs, if any).
- [ ] `git status` shows only intended changes; nothing committed or pushed.
- [ ] The parent has the final summary: what changed, what the user must do (re-invite with
      `applications.commands` if needed), and the manual verification steps.
