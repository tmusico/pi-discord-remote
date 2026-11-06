# Re-review — /pi-abort + /pi-model (repairs after the first review)

## Verdict

CHANGES REQUIRED

## Findings closed

- **N1 — CLOSED.** `readAvailableModelsSafe` now invokes `r.hasConfiguredAuth?.(model)` directly on the registry, preserving `this` (`extensions/index.ts:537`). This matches the real registry’s use of `this.authStorage` and `this.providerRequestConfigs`. The regression uses a normal method that reads `this.authStorage`, not an arrow function (`extensions/__tests__/index-wiring.test.ts:215-256`). With the old extracted, unbound call, both receiver tests would return an empty list and fail.

- **N2 — PARTIALLY CLOSED.** Unknown and ambiguous replies no longer interpolate `selection.query`; only fixed text and canonical catalog entries are rendered (`extensions/slash.ts:789-820`). Both formatters call `boundMessage`, which caps content at 2,000 characters (`extensions/slash.ts:760-764`). The secret-bearing unknown-input, ambiguous-input, and 5,000-character-input regressions are substantive (`extensions/__tests__/slash-control.test.ts:601-639`) and would fail with the old echoing implementation. However, the broader requirement that **every** plain-text reply be bounded is not met: the `no_auth` branch remains unbounded; see new finding 1.

- **N3 — CLOSED.** `describeErrorSafely` and `describeErrorName` now return only fixed categories selected through `instanceof`, never `err.name`, message, body, stack, or the raw object (`extensions/slash.ts:533-543`, `extensions/index.ts:713-723`). Assigning an arbitrary `name` property cannot change the returned category. The new tests put the secret in `err.name` and inspect actual log output or the helper result (`extensions/__tests__/slash-control.test.ts:451-474`, `extensions/__tests__/index-wiring.test.ts:701-731,737-750`); these would fail with the old helpers. The new abort, model, routing, and registration log paths use these helpers or fixed registration codes.

- **N4 — CLOSED.** The session gate runs before option reading, catalog construction, listing, or switching (`extensions/slash.ts:918-923`), so it covers both `/pi-model` forms. Autocomplete independently returns no choices when no session is present (`extensions/slash.ts:1051-1055`). Runtime wiring supplies `hasActiveSession` to both paths (`extensions/index.ts:1775,1793`), and that function checks both Discord readiness and a bound session channel (`extensions/index.ts:1588-1590`). Thus the optional dependency’s test-friendly default does not disable the runtime gate. Handler regressions cover hub-mode listing and autocomplete (`extensions/__tests__/slash-control.test.ts:642-658,811-819`).

- **N5 — CLOSED.** Entries with qualified IDs longer than 100 characters are filtered out before the 25-choice cap, and `value` is now the complete `entry.id` (`extensions/slash.ts:1062-1070`). The long-ID regression expects only the short, complete ID (`extensions/__tests__/slash-control.test.ts:821-839`); reverting to sliced values would fail it.

- **N6 — CLOSED.** The README now limits the credential-filtering claim to the registry fallback and explicitly says scoped models are retained as-is (`README.md:85-90`). The documented abort/model reply strings match the implementation’s constants and formatters (`README.md:68-71,96-101`). A separate pre-existing display-list wording issue is noted below.

## New findings

1. **P1 — The `no_auth` plain-text reply can still exceed Discord’s 2,000-character limit.**  
   **Location:** `extensions/slash.ts:868-872`  
   `renderSwitchOutcome` interpolates the provider into the `no_auth` response without calling `boundMessage`. A scoped/custom model with a sufficiently long provider name therefore produces a reply Discord rejects. This contradicts the repair report’s claim that every plain-text `/pi-model` reply is bounded, and the new over-length test covers only the unknown-input path.  
   **Smallest fix:** wrap the `no_auth` template in `boundMessage(...)`. Add a handler regression using an exactly selected model with a provider name longer than 2,000 characters, return `{ kind: "no_auth", ... }`, and assert `content.length <= 2000`.

2. **P2 — README still says the no-argument list embed contains every usable model.**  
   **Location:** `README.md:80-81`; implementation cap at `extensions/model-control.ts:261` and embed field/budget limiting at `extensions/model-control.ts:415-487`  
   The catalog display list defaults to 20 entries, and embed entries can additionally be dropped to satisfy Discord limits. “An embed with every usable model” therefore overstates what is displayed, although the following sentence does mention a total count.  
   **Smallest fix:** say the embed lists the usable models up to the display/Discord budgets and states the total when entries are omitted.

## Checks performed

- Read `PLAN.md`, the first independent review, and `repair-report-2.md`; inspected the complete working-tree file set with `watchdog_diff`.
- Verified the receiver-preserving registry call against the installed `ModelRegistry.hasConfiguredAuth` implementation, which reads instance state.
- Re-checked allow-list ordering and ephemeral refusal/defer behavior for `/pi-abort` and `/pi-model`; autocomplete refuses unauthorized users with an empty response.
- Re-checked abort outcome precedence, pending-question rejection before `ctx.abort()`, and the absence of session/channel/client teardown in the abort path.
- Re-checked case-insensitive exact/prefix/bare resolution, ambiguity and unknown handling, full-catalog resolution, and deterministic current-first/provider/model-ID sorting.
- Re-checked guarded context access, per-command upsert-only registration, autocomplete-before-chat-input routing, and embed/text character budgets.
- Assessed whether the repair regressions exercise the old defects rather than merely restating implementation details. The N1–N5 regressions are genuine behavioral controls; no tautological repair assertion was identified.
- Confirmed `package.json` is unchanged: no new runtime dependency. No `/pi-status` behavior change was found beyond the shared registration/routing plumbing and previously reviewed safe registration errors.
- `cd /home/tony/code/personal/pi-discord-remote && timeout 300s npm test` — **not run**: no shell/command-execution tool was exposed. The repair report’s 10 files / 305 tests passing claim was not independently reproduced.
- `cd /home/tony/code/personal/pi-discord-remote && timeout 120s npm run check` — **not run** for the same reason; the repair report’s clean TypeScript result was not independently reproduced.

## Residual risks / gaps not covered by tests

- No live Discord or Pi integration was exercised. Real registration, registry behavior, autocomplete submission, reconnect behavior, and session/channel/bot survival after abort remain source-reviewed only.
- Negative controls were assessed from test inputs and assertions but were not executed by reverting fixes.
- Hub-mode switching has no separate handler-level test, although the single gate before both listing and switching makes the covered list test and source path sufficient for closure.
- There is no regression for an over-length `no_auth` response; this corresponds to new finding 1.
- The previously documented product questions about real scoped-model availability across Pi versions and mapping a stale model-switch context to `no_session` remain unchanged and are not decided here.