# CHECKLIST — inbound Discord attachments

## Objective

Read image attachments off a Discord message and hand them to the model alongside the user's
text, without changing anything about a message that has no attachments.

Source: `.pi/plans/inbound-media/PLAN.md`.

**Status (2026-11-06):** implemented and validated. Nothing committed or pushed — the
commit/push decision is the user's.

## Phase 1 — The dependency

- [x] `@earendil-works/pi-coding-agent` is an **explicit** devDependency at `^1.5.0`, matching
      the runtime (it was previously only an auto-installed peer at 0.74.0, so the typecheck ran
      against a version the extension never loads)
- [x] The extension still typechecks and all existing tests pass against 1.5.0 — no source change
      was needed for the bump
- [x] `resizeImage` and `detectSupportedImageMimeTypeFromFile` are importable

## Phase 2 — Pure media module

- [x] `extensions/inbound-media.ts` exists and imports neither discord.js nor the Pi SDK
- [x] `selectInboundImages()` — images first, then the rest; the count and the size are capped;
      an unknown content type is **not** an image
- [x] `buildInboundContent()` — the user's text verbatim; the structural marker only when there
      is no text at all
- [x] `buildInboundMessage()` — with no images it returns the **plain string**, so the common
      path is unchanged
- [x] `loadInboundImage()` — the network + resize are injected; every failure is a skip
- [x] `describeSkipped()` / `describeSkipReason()` / `formatBytes()` — a short, factual notice

## Phase 3 — Wiring

- [x] The Discord attachment → `InboundAttachment` mapping (`id`, `name`, `url`, `size`,
      `contentType`)
- [x] The fetch is **bounded while streaming** — an oversized body is abandoned, not buffered
- [x] `content-length` is checked first, and the read itself is capped
- [x] The attachments are fetched **in parallel** — one timeout, not one per image
- [x] The resizer is loaded with a **dynamic import**, so an older Pi does not stop the
      extension from loading; without it the bytes are forwarded unchanged when they are small
      enough
- [x] The message handler hands the images to Pi alongside the text
- [x] A skipped attachment is reported in the channel
- [x] `inboundImages: false` (config) turns the whole thing off

## Phase 4 — Tests

- [x] `extensions/__tests__/inbound-media.test.ts` — 33 tests
- [x] Selection: images first, the count cap, the size cap, the non-image case, an unknown
      content type, a custom limit
- [x] Content: verbatim text, the structural marker, the unchanged plain-string path
- [x] Loading: a fetch that throws, a fetch that returns nothing, an oversized download, a
      resize that fails, a resize that throws
- [x] **Integration**: a real, valid PNG (built with zlib in the test) through the **real** SDK
      resizer → a valid base64 image block
- [x] **Integration**: corrupt bytes → `unreadable`, not a crash

## Phase 5 — Docs

- [x] README documents the feature, the limits and the `inboundImages` switch
- [x] The config reference lists `inboundImages`
- [x] The plan artifacts match the code

## Phase 6 — Review, repair, final review (done)

- [x] `review.md` — read-only review of the whole diff → **CHANGES REQUIRED** (1 × P1, 2 × P2, 2 × P3);
      every finding was reproduced before it was reported
- [x] `repair-report.md` — all five findings repaired, each with a regression test
- [x] **Negative controls**: each fix was reverted and its regression test was confirmed to
      **fail** (3 for 3), then the source was restored
- [x] `final-review.md` — re-read of the whole diff → **ACCEPT**, no open P0/P1/P2

## Phase 7 — Follow-ups (queued, not started)

- [ ] The commit + push decision is the user's.
- [ ] (Pre-existing, out of scope) `buildSetupConfig` hardcodes `reactions: true`, so a user's
      `reactions: false` is lost on re-setup — the same class as P2-1, but it predates this work.

## Validation checklist

- [x] `timeout 300s npm test` — 477 tests, 14 files, all pass
- [x] `timeout 120s npm run check` — clean
- [x] `timeout 180s npm run build` — clean
- [x] `git diff --check` — clean
- [x] The dependency bump is the only dependency change
- [ ] Manual check: post a screenshot in the Discord channel and confirm the agent sees it

## Rollback notes

- Set `inboundImages: false` in the config and restart — the feature turns off without a code
  change.
- Reverting the branch restores the previous behaviour exactly: the SDK bump (a devDependency
  only) and the two touched source files.

## Done definition

- [x] All phase checkboxes above are ticked (except the manual check and the commit decision).
- [x] `npm test`, `npm run check`, `npm run build` pass on the branch tip.
- [ ] The commit + push decision is the user's.
