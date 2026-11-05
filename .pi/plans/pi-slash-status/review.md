# Independent review — `/pi-status`

## Blocking findings

### P1 — Raw turn errors can disclose sensitive content in Discord

**Locations:** `extensions/index.ts:160-167`, `extensions/index.ts:584`, `extensions/status.ts:360-362`, `README.md:55-57`

`describeTurnFailure()` copies the assistant/provider `errorMessage` verbatim, apart from trimming and truncating it to 200 characters:

```ts
const detail = errorMessage || (aborted ? "aborted" : stopReason || "error");
return detail.slice(0, 200);
```

That value becomes `lastError` at `extensions/index.ts:584`, is passed into the status snapshot, and is rendered directly into the embed headline:

```ts
const message = clean(snapshot.errorMessage);
if (message) headline = `${headline} — ${sanitize(message)}`;
```

`sanitize()` only replaces the words `undefined`, `NaN`, and `null`; it does not redact secrets or content. Truncation limits the amount disclosed but does not satisfy the rule that a reply must **never** contain the bot token, system prompt, or raw file contents. A provider error containing request details, credentials, prompt excerpts, or tool output would therefore be sent to Discord.

This also makes the README guarantee at `README.md:55-57` unsupported.

**Concrete fix:** Do not render arbitrary `errorMessage` text. Map the failure to a fixed safe label such as `"aborted"` or `"last turn failed"` and keep detailed errors in local logs only. Add a regression test passing token/prompt/file-content strings through `describeTurnFailure()` and the successful embed path, asserting that none appear in the reply. The existing tests at `extensions/__tests__/status.test.ts:100-104` and `status-tracking.test.ts:170-180` currently affirm the unsafe raw-text behavior and should be updated.

### P1 — Git collection exceeds the plan’s hard two-invocation bound

**Location:** `extensions/index.ts:925-932`

Each uncached status request launches **three** processes:

```ts
const [branch, sha, porcelain] = await Promise.all([
  runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
  runGit(["rev-parse", "--short", "HEAD"], cwd),
  runGit(["status", "--porcelain"], cwd),
]);
```

`PLAN.md` explicitly requires “≤2 invocations.” The implementation does correctly defer first (`extensions/slash.ts:308-319`), applies a 2000 ms `execFile` timeout (`extensions/index.ts:899-922`), and caches completed results for five seconds, but the invocation-count rule is still violated.

**Concrete fix:** Obtain the same data with at most two calls. For example, parse `# branch.oid` and `# branch.head` from `git status --porcelain=v2 --branch`, leaving at most one additional `rev-parse` call for the short SHA. Add a test with an injected/spied process runner that asserts the maximum invocation count, timeout behavior, and cache reuse. No specific hanging-process leak was established from the source; the finding is the explicit count-bound violation.

## Non-blocking findings

### P2 — Re-running setup silently resets `keepOnline: false`

**Location:** `extensions/index.ts:1578-1587`

Setup loads the existing configuration but unconditionally writes:

```ts
keepOnline: true,
```

Thus a user who configured `keepOnline: false` loses that setting when rerunning setup for an unrelated change. This undermines the documented escape hatch until the user edits the JSON again.

**Concrete fix:** Preserve the existing value:

```ts
keepOnline: existing?.keepOnline !== false,
```

Add a setup/configuration regression test showing that an existing `false` survives setup.

### P2 — Re-invite fallback can construct a URL with the wrong application ID

**Location:** `extensions/slash.ts:223-230`

When `client.application.id` is unavailable, the code uses `client.user.id`:

```ts
const userId = client.user?.id;
if (typeof userId === "string" && userId.trim()) return userId.trim();
```

The comment acknowledges that the bot user ID is not necessarily the application ID. The resulting “actionable” URL can therefore authorize the wrong/invalid client, and it contradicts the README’s explicit distinction between application ID and bot user ID.

**Concrete fix:** Use only `client.application.id`; otherwise return the `<APP_ID>` placeholder and instruct the user to substitute the Developer Portal application ID. Add a test for `appId: null` with a non-null `userId`, asserting that the user ID is not placed in `client_id`.

### P2 — Missing-scope detection does not cover a bare HTTP 403

**Location:** `extensions/slash.ts:208-214`

Detection checks only code `50013` or the text `"Missing Access"`:

```ts
if (e.code === 50013 || e.code === "50013") return true;
return /missing access/i.test(describeError(err));
```

The implementation report claims HTTP 403 detection, but `status` is never inspected. The normal Discord `50013` shape is covered, so this is not blocking, but the implementation and report differ.

**Concrete fix:** Either include the intended 403 handling, with a suitably careful hint, or narrow the report/documentation to the actual supported error shapes. Add a test for the precise Discord error shape intended to be supported.

### P2 — Important degradation and lifecycle paths have no behavioral tests

The new tests are generally substantive: they assert precedence, registration operations, allow-list refusal, ephemeral calls, formatting, parsing, and interaction failures. However, coverage is missing for several acceptance-critical seams:

- No stale-`ctx` test makes `ctx.model`, `ctx.isIdle()`, `ctx.getContextUsage()`, or `ctx.sessionManager` throw and verifies a successful degraded embed.
- No hub-mode lifecycle test covers stop → no injected messages, pending-question rejection, hub start, disconnect, `session_shutdown`, or `keepOnline: false`.
- No process-runner test covers real `execFile` timeout/failure behavior, the invocation bound, or five-second caching.
- No successful error-status test asserts secret non-disclosure; the existing secret test covers only a throwing `buildState`.
- No interaction test covers `deferReply` rejection or failure of both `editReply` attempts.

**Concrete fix:** Extract small lifecycle/snapshot seams with injected context, client, and process-runner interfaces, then add focused tests without a real Discord network connection.

### P2 — The new config test writes to the real user configuration

**Location:** `extensions/__tests__/config.test.ts:53-83`

The new test calls `saveConfig()` twice against `CONFIG_FILE`, which is under `~/.pi/agent/pi-discord-remote/`. Backup/finally restoration reduces the risk but is not crash-safe and adds to the pre-existing suite’s real-config hazard.

**Concrete fix:** Make the config path injectable or mock the filesystem/home directory so this test uses a temporary path. Avoid adding further tests that write real user state.

## Notes / observations

- **State precedence is correct.** `resolveSessionState()` at `extensions/index.ts:90-96` implements `waiting > error > working > idle > no_session`. `buildStatusState()` reads `questionResolver !== null` at line 959, so an outstanding Discord answer is detected and cannot be shadowed by `lastError` or `reconnectFailed`.
- **No unguarded captured-`ctx` read was found.** The model and cwd reads in `session_start` are guarded, and context usage, session-manager access, and `isIdle()` are wrapped by `safeCall()` at `extensions/index.ts:846-895`. The outer `buildStatusState()` catch provides an additional fallback.
- **Registration is non-destructive and uses the correct discord.js signatures.** `extensions/slash.ts:256-261` uses `fetch({ guildId })`, `edit(id, body, guildId)`, and `create(body, guildId)`. These match `node_modules/discord.js/typings/index.d.ts:4762-4782`. No production `commands.set()` or bulk-PUT path exists.
- **Authorization and ephemeral handling are correct apart from the error-content finding.** The allow-list check at `extensions/slash.ts:297-305` mirrors the message-handler semantics, including empty-list allow-all. Refusal uses an ephemeral reply; success defers ephemerally before awaiting the snapshot; subsequent edits inherit that ephemeral acknowledgment.
- **Hub-mode source paths satisfy the requested semantics.** Message injection returns when the channel ID does not match (`extensions/index.ts:754-760`), so a null hub channel is inert. Stop/disconnect reject pending questions through `cancelPendingQuestion()` (`extensions/index.ts:275-283`), and the tool also has a five-minute timeout. `teardownClient()` destroys and nulls the client; hub start tears down the idle client before creating a fresh one; `keepOnline === false` selects full teardown. No client/channel leak was found in those direct paths.
- **Baseline behavior:** The tracked diff leaves message injection, tool-call label generation, reactions, and the central reconnect/backoff algorithm intact. The `ask_user_question` and prompt-hint changes to use `hasActiveSession()` are deliberate and necessary for hub mode.
- **Documentation:** Command name, scope/re-invite documentation, ephemeral behavior, hub mode, `disconnect`, and `keepOnline` otherwise match the implementation. The unsupported secrecy guarantee is covered by the blocking finding.
- **Scope:** Only one Discord slash command is added; there is no global registration or additional Discord command. Two extra fields in the existing TUI `/pi-discord-remote status` output (`extensions/index.ts:1671-1681`) are a small additional read-only surface beyond the original one-command request, but not a separate command or risky feature.
- `package-lock.json` was treated as the expected npm resync and not reviewed as a feature defect.

## Verification performed

- Read all requested plan, checklist, execution, and implementor-report documents.
- Inspected the tracked working-tree diff for `extensions/index.ts`, `extensions/config.ts`, `extensions/__tests__/config.test.ts`, and `README.md`.
- Read all five new source/test files, plus `extensions/helpers.ts` and the existing config tests.
- Compared the discord.js command-manager calls against the installed implementation and typings.
- Searched all production extension files for bulk command replacement, captured-`ctx` accesses, error rendering, and relevant lifecycle seams.
- Baseline comparison used the tracked diff because direct `git show HEAD:extensions/index.ts` execution was unavailable in this tool environment.
- **Not run:** `npm test`, `npm run check`, `npm run build`, and `git diff --check`; no shell/command-execution tool was exposed to this reviewer. The implementor reports claim 143 passing tests and clean check/build/diff validation, but those results were not independently reproduced.
- The supervisor should run:

  ```text
  timeout 200s npm test
  timeout 200s npm run check
  timeout 200s npm run build
  git diff --check
  ```

- No source files were edited, created, or deleted during this review.

## Verdict

**CHANGES REQUIRED** — raw error text violates the non-disclosure hard rule, and git collection exceeds the explicit two-invocation bound.