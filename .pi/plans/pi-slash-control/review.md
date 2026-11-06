# Independent review — /pi-abort + /pi-model

## Verdict

CHANGES REQUIRED

## Blocking findings (P0/P1)

### P1 — `hasConfiguredAuth` is called without its receiver, so the real registry filters out every model

**Location:** `extensions/index.ts:532-535`  
**Supporting API evidence:** `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js:488-490`

`readAvailableModelsSafe()` extracts the method and then invokes it as a plain function:

```ts
const hasConfiguredAuth = r.hasConfiguredAuth;
const hasAuth = safeCall(() => hasConfiguredAuth(model), false);
```

Pi’s actual `ModelRegistry.hasConfiguredAuth()` uses `this.authStorage` and `this.providerRequestConfigs`. With no receiver, `this` is undefined; the call throws, `safeCall` converts that to `false`, and every candidate is discarded.

Consequently, registry fallback returns an empty list. This breaks `/pi-model` listing, autocomplete, and switching whenever scoped models are not used. The tests miss this because their fakes use arrow functions that do not depend on `this` (`extensions/__tests__/index-wiring.test.ts:70-73`, `99-102`).

**Concrete fix:** Preserve the receiver:

```ts
const hasAuth = safeCall(() => r.hasConfiguredAuth?.(model), false);
```

Add a regression whose fake defines `hasConfiguredAuth` as a normal method and reads a `this`-owned field. That test fails with the current implementation and passes with the bound call.

### P1 — Unknown and ambiguous `/pi-model` replies echo arbitrary user input, violating the secrecy contract

**Location:** `extensions/slash.ts:739-756`  
**Input flow:** `extensions/slash.ts:859`, `extensions/model-control.ts:297-334`

The formatters interpolate `selection.query` verbatim:

```ts
`⚠️ "${selection.query}" matches several models:`
`❌ Unknown model "${selection.query}".`
```

The query is the raw trimmed slash-option value. If it contains the bot token, system-prompt text, or file contents, the ephemeral reply contains it too. The plan’s rule is not limited to error objects: no reply may contain those values.

The existing secret tests only inject secrets into thrown errors (`extensions/__tests__/slash-control.test.ts:431-451`, `643-663`, `837-867`), so they do not cover this path. Echoing a long option value can also exceed Discord’s 2,000-character message limit and turn a required unknown/ambiguous explanation into the generic unavailable response.

**Concrete fix:** Do not echo the query. Use fixed text such as `❌ Unknown model.` and `⚠️ Model selection matches several models:`, retaining only canonical catalog entries as suggestions. Bound the complete plain-text response to 2,000 characters. Add regressions using `SECRET_TOKEN`/`SECRET_PROMPT` as the option value for both unknown and ambiguous paths, plus an over-length query case.

### P1 — “Safe” error logging still emits the mutable, arbitrary `Error.name`

**Locations:** `extensions/slash.ts:530-534`, `extensions/index.ts:707-711`  
**Reachable log sinks:** `extensions/slash.ts:646-671`, `841-854`, `897-898`, `1001-1004`; `extensions/index.ts:753`, `806`, `1788`, `1839-1841`

Both helpers return `err.name` directly. `Error.name` is writable and may contain arbitrary provider-supplied text. For example, an error with `name = SECRET_TOKEN` causes that token to be logged even when its message is suppressed. Thus the claim that these paths can never log secrets or raw provider details is not established.

Current tests use an ordinary `Error` with a secret only in `message` (`extensions/__tests__/index-wiring.test.ts:622-645`, `699-721`), so they cannot catch this case.

**Concrete fix:** Return a fixed category such as `"Error"` for every `Error`, rather than propagating any property from the error. Add regressions with secrets in `name`, not just `message`, for both helper families and their log call sites.

## Non-blocking findings (P2/P3)

### P2 — `/pi-model` without an argument intentionally contradicts the plan’s hub-mode outcome

**Locations:** `extensions/slash.ts:859-870`, `extensions/index.ts:1697-1699`, `README.md:120-122`  
**Contract:** `.pi/plans/pi-slash-control/PLAN.md:63`

The plan says both new commands answer “no session connected” in hub mode. Instead, no-argument `/pi-model` always builds and returns a catalog; the README explicitly documents that it still lists models in hub mode. There is no session gate on this read-only path.

**Concrete fix:** Add a `hasSession` dependency and return `PI_MODEL_NO_SESSION` before catalog construction when no session is bound, then update the README. If listing in hub mode is desired instead, that is a parent-owned contract change, not an implementation-local decision.

### P2 — Autocomplete truncates the submitted model ID, producing unusable choices

**Location:** `extensions/slash.ts:993-995`

Both display names and `value` are sliced to 100 characters. For a qualified model ID longer than 100 characters, the displayed choice therefore submits a truncated value that cannot resolve to the original model. Multiple long IDs can also collapse to the same value. This is safe against accidental switching, but the autocomplete choice does not perform its advertised function.

**Concrete fix:** Only offer autocomplete entries whose complete canonical `entry.id` fits Discord’s 100-character value limit; long entries remain available through explicit input. Add a test with qualified IDs longer than 100 characters asserting that no invalid truncated value is returned.

### P2 — README overstates credential filtering for scoped models

**Locations:** `README.md:85-90`, `extensions/index.ts:552-561`

The README says “a model without credentials is never offered.” However, a non-empty scoped list is returned as-is; only the registry fallback applies `hasConfiguredAuth`. A scoped model without credentials can therefore be listed and subsequently produce the documented `no_auth` result.

**Concrete fix:** Qualify the documentation: credential filtering applies to the registry fallback, while explicitly scoped entries are retained and may report missing credentials when selected.

## Checks performed

- Read the design contract, execution plan, checklist, repair report, prior `/pi-status` plan/review, and both implementation reports.
- Inspected the working-tree delta using `watchdog_diff`; modified files were `README.md`, `extensions/index.ts`, `extensions/slash.ts`, and `extensions/__tests__/slash.test.ts`.
- Read all untracked implementation/test files directly:
  - `extensions/model-control.ts`
  - `extensions/__tests__/model-control.test.ts`
  - `extensions/__tests__/slash-control.test.ts`
  - `extensions/__tests__/index-wiring.test.ts`
- **Allow-list/ephemeral behavior:** Both chat-input handlers check the allow-list before doing session work; refusals use `reply({ ephemeral: true })`, and allowed paths defer with `{ ephemeral: true }` (`extensions/slash.ts:641-675`, `837-905`). Error edits inherit the ephemeral defer. Autocomplete is gated and returns no choices to unauthorized users (`extensions/slash.ts:975-1008`).
- **Abort semantics:** Outcome precedence is `no_session → unsupported → idle/aborted`; pending-question cancellation occurs before `ctx.abort()` (`extensions/index.ts:670-680`, `733-757`). No session/channel/client teardown is called by this path. The call-order regression at `extensions/__tests__/index-wiring.test.ts:548-565` is substantive.
- **Model resolution:** Exact qualified, exact bare, qualified prefix, bare prefix, ambiguity, and suggestions are case-insensitive and resolved against `catalog.entries`, not `visible` (`extensions/model-control.ts:297-334`). Current-first/provider/model-ID sorting is implemented at `extensions/model-control.ts:246-263`. The full-list regression at `extensions/__tests__/model-control.test.ts:232-238` would fail if resolution were changed to `visible`.
- **Model switching:** `false` maps to `no_auth`; thrown switch errors map to `failed`; unknown IDs do not reach `setModel` (`extensions/index.ts:782-808`). Raw messages are not returned, subject to the `Error.name` logging finding above.
- **Guarded context access:** Scoped-model, registry, current-model, and idle reads use guarded helpers (`extensions/index.ts:489-491`, `514-539`, `588-594`, `427-431`). Stale-context tests exercise throwing getters/methods. The receiver-binding defect is separate from stale-context handling.
- **Registration:** `registerPiCommands()` fetches once and uses per-name `edit`/`create`; no production `commands.set(...)` or bulk replacement was found (`extensions/slash.ts:381-447`). Runtime registration catches failures and remains non-fatal (`extensions/index.ts:1802-1845`).
- **Routing:** Autocomplete is dispatched before `isChatInputCommand()` (`extensions/index.ts:842-874`). The fake that claims both interaction types provides a real precedence regression (`extensions/__tests__/index-wiring.test.ts:754-773`).
- **Discord rendering limits:** Model embeds cap title, description, fields, field sizes, and the 6,000-character aggregate; list text is finally capped at 2,000 characters (`extensions/model-control.ts:415-480`, `490-548`). The long-model tests are meaningful and would fail without the budget enforcement.
- **Test quality:** The sorting, resolution, truncation, abort ordering, `no_auth`, routing, registration, and character-budget tests assert behavior rather than tautologies. Missing regressions for the concrete defects are identified above.
- **Scope/dependencies:** `package.json` is unchanged and no new runtime dependency was found. `/pi-status` interaction behavior is unchanged; its registration error result now uses a fixed safe code, which is shared registration plumbing and a secrecy improvement.
- Compared the implementation with the installed Pi API to verify method receiver requirements, context shape, and model-switch behavior.
- **Not run:** `timeout 300s npm test`, `timeout 120s npm run check`, `timeout 180s npm run build`, and `git diff --check`; no shell/command-execution tool was exposed. The repair report’s claim of 293 passing tests and clean check/build/diff was not independently reproduced. These commands should be run by the supervisor after repairs.

## Claims verified from repair-report.md (R1–R6)

- **R1 — PARTIALLY CONFIRMED.** Registration now returns fixed safe codes and no longer propagates error messages/bodies (`extensions/slash.ts:219-222`, `392-443`). The old registration `describeError`/`redact` implementation is gone. However, the broader log-hygiene claim is not fully true because `describeErrorSafely()` and `describeErrorName()` still return arbitrary `err.name` (`extensions/slash.ts:530-534`, `extensions/index.ts:707-711`).
- **R2 — PARTIALLY CONFIRMED.** Scope API feature detection, the three scope kinds, unavailable-scope note, and scoped/empty/missing tests exist (`extensions/index.ts:489-496`, `552-561`, `602-609`; `extensions/__tests__/index-wiring.test.ts:480-541`). The authenticated fallback is nevertheless broken with Pi’s real registry because of the unbound `hasConfiguredAuth` call at `extensions/index.ts:532-535`.
- **R3 — CONFIRMED.** README persistence wording is version-aware (`README.md:101-110`), the success reply says “(this session)” (`extensions/slash.ts:793-800`), and the version dependency is recorded beside `pi.setModel` (`extensions/index.ts:1733-1741`). The installed older Pi implementation also appends the session model change and updates the default (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1080-1090`).
- **R4 — CONFIRMED.** Aggregate embed budgeting and 2,000-character text bounding are present (`extensions/model-control.ts:376-405`, `448-478`, `490-548`), with substantive long-input tests at `extensions/__tests__/model-control.test.ts:330-380` and a handler-level embed test at `extensions/__tests__/slash-control.test.ts:609-640`.
- **R5 — CONFIRMED.** The exported `abortSessionRun`, `performModelSwitch`, and `routePiInteraction` seams are the same functions called by runtime wiring (`extensions/index.ts:1681-1687`, `1731-1743`, `1756-1786`). Their tests cover call order, outcome mapping, secret-bearing messages, and autocomplete precedence.
- **R6 — CONFIRMED.** The failed-switch README row now says provider details are suppressed and only a generic category is logged (`README.md:98`). The remaining `Error.name` caveat is tracked under R1/blocking finding 3.

## Residual risks / gaps not covered by tests

- **Open question — real scoped-model access:** The installed Pi 0.74.0 `ExtensionContext` does not expose `scopedModels` (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:207-236`), and the runtime’s `createContext()` does not add it (`.../core/extensions/runner.js:377-437`). Therefore real sessions take the `unavailable` fallback; after the receiver bug is fixed, `--models`/`enabledModels` scoping will still not be enforced. The plan assumes `ctx.scopedModels` exists but does not specify an alternative API. A parent decision is needed on whether the documented all-authenticated fallback is acceptable or another supported scope source is required.
- **Open question — stale context during model switching:** `switchSessionModel()` maps a missing/stale context to `no_session` (`extensions/index.ts:1727-1729`), even if a session is still bound. Unlike abort, the plan defines no `unsupported` model-switch outcome, so the desired user-facing mapping needs confirmation rather than a reviewer-invented outcome.
- No live Discord or live Pi integration was exercised. In particular, connect/reconnect registration, real model-registry behavior, actual autocomplete submission, and session survival after abort remain source-reviewed rather than integration-tested.
- No tests cover refusal/deferral/edit/respond failures exhaustively. The handlers contain safe catch paths, but failure of both the initial edit and fallback edit remains unverified at runtime.
- No test currently covers scoped models lacking credentials, matching the README overstatement above.