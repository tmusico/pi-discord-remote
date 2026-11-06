# Repair report #2 — findings of the independent review

Branch: `feat/slash-control` · Repo: `/home/tony/code/personal/pi-discord-remote`
Review: `.pi/plans/pi-slash-control/review.md` (verdict: **CHANGES REQUIRED** — 3 × P1, 3 × P2)
Scope: repair pass only — no commit, no push, no version bump, no new dependency.

---

## N1 (P1) — `hasConfiguredAuth` was called without its receiver

**Where:** `extensions/index.ts` (`readAvailableModelsSafe`)

The method was extracted and invoked as a plain function:

```ts
const hasConfiguredAuth = r.hasConfiguredAuth;
const hasAuth = safeCall(() => hasConfiguredAuth(model), false);
```

Pi's real `ModelRegistry.hasConfiguredAuth()` reads `this.authStorage` and
`this.providerRequestConfigs`. Without the receiver the call throws, the guarded call swallows
it and returns `false` — so **every** model was filtered out and the registry fallback always
returned an empty list (breaking the list, the autocomplete and the switch whenever the session
has no explicit model scope).

**Fix:** the method is now called *on the registry*, so the receiver is kept:

```ts
const hasAuth = safeCall(() => r.hasConfiguredAuth?.(model), false);
```

**Regression:** `extensions/__tests__/index-wiring.test.ts` → `readAvailableModelsSafe` now uses
a fake registry whose `hasConfiguredAuth` is a **normal method** that reads `this.authStorage`
(an arrow-function fake cannot catch this defect). A second case proves that a provider without
credentials is still filtered out.

**Negative control:** reverting the fix fails 2 tests (the reviewer confirmed the same gap).

---

## N2 (P1) — the unknown/ambiguous replies echoed arbitrary user input

**Where:** `extensions/slash.ts` (`formatUnknownModels`, `formatAmbiguousModels`)

Both formatters interpolated the raw slash-option value. The value is arbitrary text: it could
carry a secret (the bot token, the system prompt, file contents) and — with Discord's 2 000
character message limit — it could make the reply fail with an API error instead of explaining
what to do next.

**Fix:** the typed id is **never echoed**. The replies now use fixed text and only render
canonical catalog entries (the qualified ids of the session's own models):

* `❌ Unknown model.` (+ up to 5 suggestions + "Use the qualified id, e.g. provider/model-id.")
* `⚠️ That model id matches several models:` (+ up to 5 candidates + "Use the full
  provider/model-id, …")

Every plain-text reply of `/pi-model` is additionally cut to Discord's message limit
(`boundMessage`, 2 000 characters).

**Regressions:** `extensions/__tests__/slash-control.test.ts`

* `never echoes the typed id — it could carry a secret` (unknown path, the secret is the option
  value),
* `never echoes the typed id of an ambiguous selection` (the typed id is not quoted back),
* `keeps an over-long typed id within Discord's message limit` (a 5 000 character option value
  still yields a reply ≤ 2 000 characters),
* the pre-existing `never switches a model for an unknown input` test now asserts that the typed
  id is **absent**.

---

## N3 (P1) — the "safe" error logging still emitted the mutable `Error.name`

**Where:** `extensions/slash.ts` (`describeErrorSafely`), `extensions/index.ts`
(`describeErrorName`)

Both helpers returned `err.name`. `name` is a writable property, so a provider error could carry
any text in it — the claim "a log line can never carry a secret" did not hold.

**Fix:** both helpers now return a **fixed** category from a closed vocabulary. The built-in
error classes are recognized through `instanceof` (their prototype chain cannot be forged by
assigning a property):

`TypeError` · `RangeError` · `ReferenceError` · `SyntaxError` · `Error` · `unknown_error`

**Regressions:** a secret in `err.name` is asserted to be absent from the log line — for the
handler path (`slash-control.test.ts`) and for the runtime seam (`index-wiring.test.ts`), plus a
direct unit test of `describeErrorName`.

---

## N4 (P2) — hub mode contradicted the plan

**Where:** `extensions/slash.ts` (`handlePiModelInteraction`, `handlePiModelAutocomplete`),
`extensions/index.ts` (runtime wiring), `README.md`

PLAN.md decision 3 says both new commands answer **"no session connected"** in hub mode. The
implementation listed the models in hub mode instead (a documented deviation from the earlier
step report).

**Fix:** the plan is the contract — the model list is now gated on an active session as well:

* `PiModelAutocompleteDeps` / `PiModelInteractionDeps` gained an optional `hasSession?: () => boolean`
  (missing → the handler assumes a session, so the pure handlers stay testable),
* the runtime passes `hasActiveSession`,
* in hub mode `/pi-model` answers **"No Pi session is connected."** (list *and* switch) and the
  autocomplete offers no choices.

**Regressions:** `answers with no session connected in hub mode`, `answers with nothing in hub
mode`.

**Docs:** the README's hub-mode paragraph and the reply table were updated accordingly.

---

## N5 (P2) — the autocomplete truncated the submitted model id

**Where:** `extensions/slash.ts` (`handlePiModelAutocomplete`)

`value: entry.id.slice(0, 100)` cut a long qualified id into a value that could never resolve
to a model.

**Fix:** an entry whose complete qualified id exceeds Discord's 100 character choice limit is
**skipped** (it stays reachable by typing the id manually); the submitted value is always the
complete id.

**Regression:** `never offers a truncated model id`.

---

## N6 (P2) — the README overstated the credential filtering

**Where:** `README.md`

"a model without credentials is never offered" was only true for the registry fallback; an
explicitly scoped model is kept as it is.

**Fix:** the README now states that the credential filter applies to the registry fallback while
an explicitly scoped entry is kept and reports the missing API key when it is selected.

---

## N7 (P1) — the `no_auth` reply was not bounded

**Where:** `extensions/slash.ts` (`renderSwitchOutcome`, the `no_auth` branch)

The re-review found that only the unknown/ambiguous/switched replies went through
`boundMessage`. The `no_auth` reply interpolated the provider name directly — a model with a
pathologically long provider name produced a reply Discord rejects (over the 2 000 character
message limit).

**Fix:** the `no_auth` branch is bounded like every other plain-text reply.

**Regression:** `keeps an over-long provider name within Discord's message limit` (a provider name
of 2 100 characters → the reply stays ≤ 2 000 characters).

**Negative control:** reverting the fix fails the test.

---

## N8 (P2) — the README overstated what the list embed contains

**Where:** `README.md`

"An embed with every usable model" overstates the behavior: the catalog caps the display list at
20 entries and the embed budget can drop entries that do not fit.

**Fix:** the README now states that the embed lists the usable models *up to* the display limit
and Discord's embed budget, that entries which do not fit are left out, and that the total count
is stated in that case.

---

## Open questions (not changed — parent decision required)

1. **Real scoped models.** The extension's dev dependency (`pi-coding-agent@0.74.0`) does not
   expose `ctx.scopedModels`; the installed runtime (`1.5.0`) does. The feature detection
   handles both: on an older Pi the list is the authenticated fallback and the reply says
   "scope API unavailable — showing all authenticated models".
2. **A stale ctx during a model switch** maps to `no_session` ("No Pi session is connected.").
   The plan defines no `unsupported` outcome for the model command, so no new outcome was
   invented.
3. **No live integration test** — the registration, the real registry, the autocomplete
   submission and the session survival after an abort are source-reviewed only.

---

## Validation (after the repairs)

```
$ timeout 300s npm test
 Test Files  10 passed (10)
      Tests  305 passed (305)

$ timeout 120s npm run check      # tsc --noEmit — clean
$ timeout 180s npm run build      # tsc — clean
$ git diff --check                # clean
```

**Negative controls** (each fix reverted → the new regression fails):

| Reverted fix | Failing tests |
|--------------|---------------|
| unbound `hasConfiguredAuth` | 2 |
| echo the typed id | 2 |
| log `err.name` (slash.ts) | 1 |
| log `err.name` (index.ts) | 2 |
| drop the hub-mode gate | 2 |
| truncate the autocomplete value | 1 |
| unbind the `no_auth` reply | 1 |

**Total: 306 tests, 10 files — all passing.**

## Files changed by this repair pass

| File | Change |
|------|--------|
| `extensions/index.ts` | receiver-preserving `hasConfiguredAuth` call, fixed error category, `hasSession` wiring for `/pi-model` + autocomplete |
| `extensions/slash.ts` | fixed error category, no query echo, message-limit bound, hub-mode gate, valid autocomplete values |
| `extensions/__tests__/index-wiring.test.ts` | receiver regression, `err.name` regressions, `describeErrorName` unit tests |
| `extensions/__tests__/slash-control.test.ts` | no-echo regressions, over-long query, hub-mode regressions, truncated-id regression, `err.name` regression |
| `README.md` | hub-mode wording, reply table, credential-filtering wording |
| `.pi/plans/pi-slash-control/review.md` | the independent review (copied from the reviewer's artifact) |
