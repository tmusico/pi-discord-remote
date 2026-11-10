# Repair report — inbound Discord attachments

Repairs for the findings in `review.md` (verdict: **CHANGES REQUIRED** — 1 × P1, 2 × P2, 2 × P3).

Every repair has a regression test, and every regression test was verified to **fail without its
fix** (the negative control): the fix was temporarily reverted, the test was run, and it failed.
The source was restored afterwards.

| # | Finding | Repair | Files | Regression test |
|---|---------|--------|-------|-----------------|
| P1-1 | The attachment fetch widened the message race from milliseconds to seconds | A one-slot **message gate**, claimed **synchronously** before the first await and released in a `finally`. A second message during the fetch is now rejected with the existing "still processing" reply instead of overwriting the reply target and injecting out of order. | `extensions/helpers.ts`, `extensions/index.ts` | `createMessageGate` — "keeps a slow message from letting a second one through" |
| P2-1 | Re-running setup silently reset `inboundImages` | `buildSetupConfig` now preserves it, exactly as it preserves `keepOnline`: `inboundImages: existing?.inboundImages !== false`. | `extensions/index.ts` | `setup-config.test.ts` — "preserves an existing inboundImages: false" |
| P2-2 | The image MIME type came from Discord's report, not the bytes | `detectImageMimeType()` sniffs the magic bytes (PNG / JPEG / GIF / BMP / WebP). The **detected** type is what goes *into* the resizer, so the resizer's return value is correct in both cases: it echoes the detected type when it leaves the image alone, and reports the real type when it re-encodes it. | `extensions/inbound-media.ts` | `R-P2-2` — "a mislabelled attachment is labelled by its bytes" |
| P3-1 | An unnecessary cast hid the content-block types | The cast is gone; `pi.sendUserMessage(buildInboundMessage(...))` typechecks on its own. | `extensions/index.ts` | — (typecheck) |
| P3-2 | The old-Pi fallback trusted the same unverified type | Fixed by the same change: the fallback receives the **detected** type, so the bytes it forwards are labelled correctly. | `extensions/index.ts` | `R-P3-2` — "the old-Pi fallback labels the bytes by their type too" |

## Notes on two of the repairs

**P1-1 needed a testable unit.** The race lives inside the message handler, which is not
exported and cannot be driven without a live Discord client. The gate was extracted into
`createMessageGate()` in `extensions/helpers.ts` — a pure, exported helper, matching the house
pattern (`resolveSessionState`, `readModelScopeSafe`, `buildStatusView`). That is what makes the
concurrency semantics testable at all, and it is why the negative control could be run.

**P2-2's fix is "pass the detected type in", not "override the output type".** Overriding the
output with the detected type of the *original* bytes would have been wrong: when the resizer
re-encodes the image, the output bytes are a different format from the input. Passing the detected
type **into** the resizer makes both cases correct — the resizer echoes its input when it does not
resize, and reports the real type when it does.

A format the sniffer does not know (say AVIF) falls back to Discord's reported type rather than
being rejected — the best available answer, and no worse than before.

## The pre-existing observation was left alone

`buildSetupConfig` also hardcodes `reactions: true`, so a user's `reactions: false` is lost on
re-setup. It predates this work and is out of this feature's scope. It is recorded in
`review.md` so it is not lost, and it is **not** fixed here.

## Validation after the repairs

- `timeout 300s npm test` → **477 tests**, 14 files, all pass (was 463; +14).
- `timeout 120s npm run check` → clean.
- `timeout 180s npm run build` → clean.
- `git diff --check` → clean.
- No dependency change beyond the devDependency bump already reported.
