# Repair report — `/pi-status` (REPAIR round)

Branch: `feat/slash-status` · Repo: `/home/tony/code/personal/pi-discord-remote`
Scope: exactly the 7 items R1–R7 of the repair brief. No git write commands were run, no
dependency/`package.json` changes, feature scope unchanged (one slash command `pi-status`,
ephemeral replies, always-registered, "no session connected" answer).

---

## R1 (BLOCKING) — never render raw provider/tool error text to Discord

### Changes

| File | Change |
|------|--------|
| `extensions/index.ts` | `describeTurnFailure()` now returns **only a fixed safe label**: `TURN_FAILURE_ABORTED` (`"aborted"`) or `TURN_FAILURE_ERROR` (`"turn failed"`), or `null` for a normal turn. The provider `errorMessage` text is **never** returned, so it can no longer reach `lastError` → `StatusState.errorMessage` → the embed headline. |
| `extensions/index.ts` | New module-private `rawTurnErrorDetail(event)` extracts the raw text **for the local console only**. The `agent_end` handler logs it via the new closure-private `redactToken()` (replaces the bot token with `***`, caps the line at 500 chars) — the token is never printed. |
| `extensions/index.ts` | `lastError` now holds the safe label only; the `error` state is still raised because the labels are non-empty. |
| `extensions/status.ts` | `StatusState.errorMessage` doc updated: it carries a **safe label only** (`"aborted"` / `"turn failed"`), never provider text. Rendering is unchanged → headline `⚠️ Error — turn failed`; the existing `undefined`/`NaN`/`null` scrub is kept. |
| `README.md` | The "never prints the bot token, the system prompt or raw file contents" sentence is now true; added the half-sentence that a failed/aborted turn is reported as a generic label and the raw text stays in the local log. |

`stopReason` (closed enum) mapping: `"aborted"` → `"aborted"`, `"error"` → `"turn failed"`,
all other stop reasons → `null` unless the assistant message carries an error text, in which
case the turn is classified (aborted-looking vs. failed) but **only the fixed label is
returned**.

### Tests

Updated (`extensions/__tests__/status-tracking.test.ts`)
- `describeTurnFailure > describes a failed run with a fixed label — never the provider text` (was: *…with the provider message*, asserted `"rate limited"`)
- `describeTurnFailure > detects abort-like error messages without rendering them` (was: asserted the raw text)
- `describeTurnFailure > never returns the provider text — no matter how long it is` (replaces *truncates long messages*)
- `describeTurnFailure > describes an aborted run with a fixed label` (unchanged expectation, renamed)

Updated (`extensions/__tests__/status.test.ts`)
- `buildStatusView: state headlines > renders the error headline with the safe error label` (was: *renders the error headline with the error message*, asserted `"⚠️ Error — boom"`)
- `buildStatusView: state headlines > renders the aborted label` (new)

Added (`extensions/__tests__/status-tracking.test.ts`)
- `turn failures never leak provider text > describes the failure with a fixed safe label`
- `turn failures never leak provider text > keeps the secrets out of the status view and the embed` — regression test: an `agent_end`-like event whose assistant `errorMessage` contains a bot-token-like string, a system-prompt-like string and file content; asserts none of the three appear in the label, in `buildStatusView(...)` or in `buildStatusEmbed(...)`
- `turn failures never leak provider text > renders the generic error headline`

---

## R2 (BLOCKING) — git lookups must respect the ≤2-invocation bound

### Changes

| File | Change |
|------|--------|
| `extensions/index.ts` | `collectGitInfo(cwd, runner?)` now performs **exactly one** git invocation: `git status --porcelain=v2 --branch` (was three: two `rev-parse` + one `status --porcelain`). The 2 s per-call timeout (`GIT_TIMEOUT_MS`), the ~5 s cache (`GIT_CACHE_TTL_MS` in `readGitInfo`) and the "never throws" behaviour are kept. |
| `extensions/index.ts` | New **pure** exported parser `parseGitStatusV2(output)`: branch = `# branch.head` (may be `(detached)`), sha = `# branch.oid` shortened to 7 chars (`null` for `(initial)` = unborn branch), dirtyCount = number of non-empty lines that do not start with `#`. Empty output or a `fatal:` line ⇒ all `null`. |
| `extensions/index.ts` | `runGit()` moved to module scope (still private) so the exported `collectGitInfo` can use it as its default runner. `parseGitStatusInfo` / `countDirtyFiles` are kept and unchanged. |

### Tests (all in `extensions/__tests__/status-tracking.test.ts`)

- `parseGitStatusV2 > parses a clean working tree`
- `parseGitStatusV2 > counts modified and untracked entries`
- `parseGitStatusV2 > parses a detached HEAD`
- `parseGitStatusV2 > treats an unborn branch as an unknown sha`
- `parseGitStatusV2 > reports everything as unknown for an empty output`
- `parseGitStatusV2 > reports everything as unknown when git failed` (non-git directory)
- `collectGitInfo > uses exactly one git invocation` — spy runner counts the calls, asserts `calls.length <= 2` **and** `=== 1`, and that the argv is `["status", "--porcelain=v2", "--branch"]`
- `collectGitInfo > reports everything as unknown when git fails`
- `collectGitInfo > never throws when the runner throws`

---

## R3 (non-blocking) — `setup` must not silently reset `keepOnline`

### Changes

| File | Change |
|------|--------|
| `extensions/index.ts` | New **exported pure** helper `buildSetupConfig(existing, inputs)` builds the config written by `/pi-discord-remote setup`; `keepOnline` is `existing?.keepOnline !== false` (was an unconditional `keepOnline: true`). The `setup` command case now calls it. |

### Tests (`extensions/__tests__/setup-config.test.ts`, new file)

- `buildSetupConfig > defaults keepOnline to true when there is no existing config`
- `buildSetupConfig > keeps an existing keepOnline: true`
- `buildSetupConfig > preserves an existing keepOnline: false` ← the regression test for R3
- `buildSetupConfig > writes the other answers unchanged`
- `buildSetupConfig > omits empty optional answers`

---

## R4 (non-blocking) — the re-invite URL must use the APPLICATION id

### Changes

| File | Change |
|------|--------|
| `extensions/slash.ts` | `resolveApplicationId()` now returns **only** `client.application?.id` (or `null`). The bot *user* id fallback was removed. When the application id is unknown the URL uses the literal `client_id=<APP_ID>` and the hint says the application id must be taken from the Discord Developer Portal. |

### Tests (`extensions/__tests__/slash.test.ts`)

- `registerPiStatusCommand > never uses the bot user id as the OAuth client_id` (new) — application id unavailable + non-null user id ⇒ the URL contains `client_id=<APP_ID>`, does **not** contain the user id, and the hint mentions the Developer Portal.
- `registerPiStatusCommand > keeps the <APP_ID> placeholder when no application id is known` (existing, still green).

---

## R5 (non-blocking) — detect a bare HTTP 403 as a missing scope

### Changes

| File | Change |
|------|--------|
| `extensions/slash.ts` | `isMissingCommandScopeError()` now also treats `status === 403` (or `"403"`) as the missing-scope case, in addition to code `50013` and the text `Missing Access`. |

### Tests (`extensions/__tests__/slash.test.ts`)

- `registerPiStatusCommand > recognizes a bare HTTP 403 as the missing-scope failure` (new) — `{ status: 403 }` and `{ status: 403, code: 50013 }`.
- `registerPiStatusCommand > recognizes the missing-scope failure shape` (existing, still green).

---

## R6 (non-blocking) — the new config test must not write the user's real config

### Changes

| File | Change |
|------|--------|
| `extensions/config.ts` | `loadConfig(file: string = CONFIG_FILE)` and `saveConfig(cfg: Config, file: string = CONFIG_FILE)` — the path is injectable. `CONFIG_FILE` and the default behaviour are unchanged for every other caller; `saveConfig` now creates `dirname(file)` instead of the fixed `CONFIG_DIR`. |
| `extensions/__tests__/config.test.ts` | The **new** `keepOnline > is optional on the Config type` test now uses `mkdtemp()` under `os.tmpdir()` and the injectable path — it never touches the real config. The pre-existing config tests were left untouched (per instructions). |

### Tests

- `keepOnline > is optional on the Config type` (updated — now runs against a temporary file)

---

## R7 (test addition) — stale-ctx degradation must be provable

### Changes

| File | Change |
|------|--------|
| `extensions/index.ts` | New **exported** ctx readers that accept a ctx-like object and never throw: `readContextUsageSafe(ctx)`, `readSessionIdentitySafe(ctx)`, `readAgentIdleSafe(ctx)`. `safeCall()` moved to module scope. `buildStatusState()` now calls the exported readers directly with `capturedCtx` (the closure-local wrappers were removed). |

### Tests (`extensions/__tests__/status-tracking.test.ts`)

- `stale ctx degradation > returns the null fallback when every ctx getter throws` — a ctx whose `getContextUsage`/`sessionManager`/`isIdle` getters all throw
- `stale ctx degradation > returns the null fallback when the ctx methods throw`
- `stale ctx degradation > returns the null fallback without a ctx`
- `stale ctx degradation > reads a healthy ctx`
- `stale ctx degradation > renders a valid embed from an all-null snapshot` — `buildStatusView`/`buildStatusEmbed` produce a valid embed with no `undefined`/`NaN`/`null` text

---

## Validation (all run in `/home/tony/code/personal/pi-discord-remote`)

```
$ npm run check          # tsc --noEmit
> pi-discord-remote@0.2.4 check
> tsc --noEmit
(exit 0 — no output)

$ npm test               # vitest run
 RUN  v4.1.6 /home/tony/code/personal/pi-discord-remote
 Test Files  14 passed (14)
      Tests  336 passed (336)
   Duration  ~0.9s
(exit 0)

$ npm run build          # tsc
> pi-discord-remote@0.2.4 build
> tsc
(exit 0 — no output)

$ git diff --check
(no output, exit 0)
```

Note on the test count: `npm test` picks up **both** the TypeScript sources
(`extensions/__tests__/*.test.ts`, 7 files / 168 tests) and the compiled copies in the
git-ignored `dist/` (7 files / 168 tests) — a pre-existing repo layout, not something this
repair changed. Source-only: `npx vitest run extensions/__tests__` → 7 files / 168 tests
passed. Every pre-existing test stayed green.

---

## Newly exported symbols

| Symbol | File | Signature |
|--------|------|-----------|
| `TURN_FAILURE_ABORTED` | `extensions/index.ts` | `const TURN_FAILURE_ABORTED = "aborted"` |
| `TURN_FAILURE_ERROR` | `extensions/index.ts` | `const TURN_FAILURE_ERROR = "turn failed"` |
| `parseGitStatusV2` | `extensions/index.ts` | `(output: string) => GitStatusInfo` |
| `collectGitInfo` | `extensions/index.ts` | `(cwd: string, runner?: (args: string[]) => Promise<string \| null>) => Promise<GitStatusInfo>` |
| `readContextUsageSafe` | `extensions/index.ts` | `(ctx: unknown) => { tokens: number \| null; contextWindow: number \| null }` |
| `readSessionIdentitySafe` | `extensions/index.ts` | `(ctx: unknown) => { id: string \| null; name: string \| null; entries: number \| null }` |
| `readAgentIdleSafe` | `extensions/index.ts` | `(ctx: unknown) => boolean \| null` |
| `SetupConfigInputs` | `extensions/index.ts` | `interface SetupConfigInputs { token: string; guildId: string; categoryId?: string; allowedUserIds?: string[]; toolResponses?: boolean }` |
| `buildSetupConfig` | `extensions/index.ts` | `(existing: Config \| null, inputs: SetupConfigInputs) => Config` |
| `loadConfig` *(changed signature)* | `extensions/config.ts` | `(file: string = CONFIG_FILE) => Promise<Config \| null>` |
| `saveConfig` *(changed signature)* | `extensions/config.ts` | `(cfg: Config, file: string = CONFIG_FILE) => Promise<void>` |

All previously exported symbols keep their name and behaviour
(`PI_STATUS_COMMAND`, `registerPiStatusCommand`, `handlePiStatusInteraction`,
`buildStatusView`, `buildStatusEmbed`, `formatStatusText`, `resolveSessionState`,
`parseGitStatusInfo`, `countDirtyFiles`, `describeTurnFailure` — the last one now returns a
safe label instead of raw text, as required by R1).

New module-private helpers (not exported): `runGit`, `rawTurnErrorDetail`, `looksAborted`,
`safeCall` (module scope) and `redactToken` (closure scope).

---

## Deviations / judgement calls

1. **R1 classification.** `describeTurnFailure` maps the closed `stopReason` enum to the two
   safe labels. When the assistant message carries an `errorMessage` but a non-failure
   `stopReason` (e.g. `"stop"`), the turn is still classified as failed (as before the
   repair) — only its *classification* is used, never its text. An abort-looking error text
   is classified as `"aborted"`, everything else as `"turn failed"`. A local `looksAborted()`
   helper is used instead of `helpers.ts#isAbortLikeError`, because that helper reads
   `.message` off an `Error`-like object and would never match a plain string.
2. **R1 console line.** The raw detail is written to the local console (allowed by the
   brief) with the bot token redacted and the line capped at 500 chars.
3. **R2 parser edge cases.** `parseGitStatusV2("")` and a `fatal:` line both mean "git
   failed" → `{ branch: null, sha: null, dirtyCount: null }` (not `dirtyCount: 0`), so a
   non-repo is not reported as a clean tree. `"(detached)"` is kept verbatim as the branch.
4. **R7 wiring.** The closure-local wrappers (`readContextUsage`, `readSessionIdentity`,
   `readAgentIdle`) were removed so `buildStatusState()` calls the exported `*Safe` helpers
   directly — the exported helpers are the single source of truth.
5. **R6 side effect.** `saveConfig` now creates `dirname(file)` instead of the fixed
   `CONFIG_DIR`, so a custom path works. `CONFIG_DIR` is still exported and unchanged.

## Incident (not caused by the repair, but triggered by the mandated `npm test`)

The **pre-existing** test `saveConfig + loadConfig > saveConfig writes valid JSON`
(`extensions/__tests__/config.test.ts`) writes to the real
`~/.pi/agent/pi-discord-remote/config.json` and then deletes it with
`rm(CONFIG_FILE, { force: true })`. Running the mandated `npm test` therefore **removed the
user's real config file** (it held the bot token) before/while this repair ran — no backup
exists, so the user has to re-run `/pi-discord-remote setup`. The brief explicitly said to
leave the pre-existing config tests alone, so they were **not** changed; only the new
`keepOnline` test was moved to a temp directory. If the parent wants, the remaining
pre-existing real-path tests can be moved to temp files in a follow-up (one line each, the
path is now injectable).
