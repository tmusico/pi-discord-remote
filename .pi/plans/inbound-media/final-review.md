# Final review — inbound Discord attachments

Read-only re-review of the diff after the repair round (`review.md` → `repair-report.md`).

**Verdict: ACCEPT** — no open P0/P1/P2 findings. One pre-existing observation is recorded below
and deliberately left alone.

---

## Findings from `review.md` — all closed

| # | Finding | Status | How it was verified |
|---|---------|--------|---------------------|
| P1-1 | The attachment fetch widened the message race from milliseconds to seconds | **Closed** | A one-slot gate is claimed **synchronously** before the first await and released in a `finally`. A second message during the fetch is now rejected with the existing "still processing" reply. `createMessageGate` — "keeps a slow message from letting a second one through". |
| P2-1 | Re-running setup silently reset `inboundImages` | **Closed** | `buildSetupConfig` preserves it exactly as it preserves `keepOnline`. `setup-config.test.ts` — "preserves an existing inboundImages: false". |
| P2-2 | The image MIME type came from Discord's report, not the bytes | **Closed** | The type is sniffed from the magic bytes and passed **into** the resizer, so the resizer's return value is correct in both the unchanged and the re-encoded case. `R-P2-2`. |
| P3-1 | An unnecessary cast hid the content-block types | **Closed** | The cast is gone; the call typechecks on its own. |
| P3-2 | The old-Pi fallback trusted the same unverified type | **Closed** | The fallback receives the detected type. `R-P3-2`. |

**Negative controls:** every regression test was run against a temporarily reverted fix and
**failed** — 3 for 3 (P1-1, P2-1, P2-2/P3-2, the latter covering both).

---

## The P1 fix, checked in detail

The gate has to be claimed **before the first await**, or it protects nothing. Verified in the
source: the `tryClaim()` call is the first thing after the `agentBusy` check, and the ⏳ reaction
await, the attachment fetch and the skip notice are all inside the `try`.

The release is in a `finally`, so a throwing fetch or a failed reply cannot leave the gate stuck
and wedge the channel.

Two properties were checked deliberately:

- **The gate does not change the no-attachment path.** With no attachments there is no fetch, so
  the gate is held only across the ⏳ reaction await — which closes the *pre-existing* narrow
  race at the same time. The window after `sendUserMessage` (until `agent_start` fires) is
  unchanged from before the feature.
- **The gate is not a second `agentBusy`.** It covers preparation; `agentBusy` covers the run.
  They are checked separately and released independently.

## Re-verification of the whole feature

| Area | Result |
|------|--------|
| **The unchanged path** | With no images, `buildInboundMessage()` returns the **plain string**. |
| **Text fidelity** | The user's text is verbatim; only a message with no text gets the structural marker. |
| **The size guards** | The reported size is checked before the download; the read is capped while streaming. |
| **The real resizer** | A 2600×2200 PNG → **2048×1733 JPEG, 1.59 MB**; both budgets enforced. |
| **The MIME type** | Sniffed from the bytes; a PNG reported as JPEG comes back as `image/png`. |
| **Failure containment** | A throwing fetch, an empty fetch, corrupt bytes and a throwing resize are all **skips**. |
| **The dynamic import** | An older Pi without `resizeImage` degrades rather than failing to load. |
| **Parallel fetch** | One timeout for all the attachments, not one each. |
| **Privacy** | No attachment bytes, URLs or names are logged. |
| **Scope** | One dependency change (a devDependency promotion); no runtime dependency added; the outbound path and the existing hooks are untouched. |

## Validation

- `timeout 300s npm test` → **477 tests**, 14 files, all pass.
- `timeout 120s npm run check` → clean.
- `timeout 180s npm run build` → clean.
- `git diff --check` → clean.

## Left alone (pre-existing)

`buildSetupConfig` hardcodes `reactions: true`, so a user's `reactions: false` is lost on
re-setup — the same class of bug as P2-1, but it predates this work and is out of scope here. It
is recorded in `review.md` so it is not lost.

## Known limitation (not a defect)

The Discord side of this feature has never run against a live client: the pure logic has 39
tests, the SDK integration is proven against the real resizer, and the message-handler wiring is
typechecked — but no real attachment has been through a real Discord message. The manual check
in `CHECKLIST.md` is still outstanding.

## Not done (deliberately)

Non-image attachments, the outbound path, a remote model, a confirmation prompt, and the
pre-existing `reactions` reset.

## Done definition

- [x] Every finding in `review.md` is closed, with a regression test and a verified negative
      control.
- [x] The full validation is green on the branch tip.
- [x] The plan artifacts match the code.
- [ ] The commit + push decision is the user's.
