# EXECUTION PLAN — inbound Discord attachments

Source: `.pi/plans/inbound-media/PLAN.md` + `CHECKLIST.md`.

**Status:** the implementation is **done**. This document records the execution as it ran, and
the review steps that remain.

## Execution rules

- **One writer per working tree.**
- The parent owns acceptance, the commit and the push. Implementors never commit, push or
  publish.
- The branch is `feat/slash-control`; `main` is never touched.
- Every step runs its targeted validation and reports the exact command + result.
- **Stop conditions:** a design question the plan does not answer; a need for a runtime
  dependency beyond the SDK bump; validation that fails twice without a diagnosis.
- Prefer pure, exported helpers (the house pattern: `buildStatusView`, `resolveModelSelection`,
  `buildAgentFleetView`) so behavior is testable without Discord or a live Pi.

## Model guidance

| Role | Model | Why |
|------|-------|-----|
| Implementor | `minimax/MiniMax-M3` | contained implementation work; cheapest capable model |
| Reviewer | `kimi-coding/k3.1-pro` | independent read-only review, cheaper than the Terra reviewer |

## Step 1 — The dependency (implementor) — done

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** make the typecheck run against the SDK the extension actually loads.
- **Actions:** add `@earendil-works/pi-coding-agent@^1.5.0` to devDependencies; run
  `npm install`; run the typecheck and the full suite.
- **Deliverable:** `package.json`, `package-lock.json`.
- **Result:** the bump needed **no** source change — 430 tests and the typecheck were green
  against 1.5.0 immediately. `resizeImage` became importable.
- **Finding:** the SDK had never been a direct dependency — it was an auto-installed peer at
  0.74.0, so the typecheck had been running against a version the extension never loads.

## Step 2 — The pure media module (implementor) — done

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** the selection, the content building and the skip notices, with the network and the
  resize injected.
- **Actions:** create `extensions/inbound-media.ts` exactly as the PLAN specifies; keep it free
  of discord.js and of the Pi SDK so it stays unit-testable.
- **Deliverable:** `extensions/inbound-media.ts`, `extensions/__tests__/inbound-media.test.ts`.
- **Validation:** `timeout 180s npx vitest run extensions/__tests__/inbound-media.test.ts` and
  `timeout 120s npm run check`.

## Step 3 — Wiring (implementor) — done

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** the real loader, the Discord mapping and the message-handler change.
- **Actions:** the bounded streaming fetch; the dynamic-import resizer with the "already small
  enough" fallback; the parallel fetch; the message-handler wiring; the `inboundImages` config
  switch; the skip notice.
- **Deliverable:** `extensions/index.ts`, `extensions/config.ts`.
- **Validation:** `timeout 120s npm run check`, `timeout 300s npm test`.

## Step 4 — Verification against the real resizer (implementor) — done

- **Agent / model:** implementor — `minimax/MiniMax-M3`
- **Goal:** prove the SDK call actually works, rather than mocking it.
- **Actions:** generate a real PNG (zlib + CRC32) and run it through the SDK's `resizeImage()`;
  repeat with a 2600×2200 PNG to confirm both budgets are enforced; add the two integration
  tests to the suite.
- **Result:** a 2600×2200 PNG (1.64 MB raw, 2.19 MB as base64) came back as **2048×1733 JPEG,
  1.59 MB**. Both the edge budget and the byte budget held.
- **Finding:** the first probe used a hand-written base64 PNG that Photon rejected
  (`RuntimeError: unreachable`). The resizer was fine; the fixture was not — which is exactly
  why the integration test builds its PNG properly instead of embedding a blob.

## Step 5 — Review (reviewer) — **not started**

- **Agent / model:** reviewer — `kimi-coding/k3.1-pro`, **read-only**.
- **Goal:** an independent verdict on the feature.
- **Actions:** read the diff against the branch base plus `.pi/plans/inbound-media/PLAN.md`;
  check specifically:
  - the **unchanged path** — a message with no attachment is handed to Pi as the plain string
    it always was;
  - **text fidelity** — the user's text is never trimmed or reworded; only a message with no
    text at all gets the structural marker;
  - the **size guards** — the reported size is checked before the download, and the read is
    capped while streaming (a missing or lying `content-length` must not get past it);
  - **failure containment** — a broken attachment is a skip, never an exception that stops the
    message reaching the agent;
  - **privacy** — no attachment bytes, names or URLs are logged; only a short factual notice
    is posted;
  - the **dynamic import** — an older Pi without `resizeImage` must degrade, not fail to load;
  - **scope** — the only dependency change is the devDependency bump; the outbound path, the
    existing `pi.on(...)` hooks and the message-injection path are otherwise untouched.
  Run `timeout 300s npm test`, `timeout 120s npm run check`, `timeout 180s npm run build` and
  `git diff --check`.
- **Deliverable:** `.pi/plans/inbound-media/review.md` — verdict **ACCEPT** / **ACCEPT WITH
  FINDINGS** / **CHANGES REQUIRED**, every finding as P0/P1/P2 with a concrete fix.
- **Files in scope:** read-only.

## Step 6 — Repair + re-review (only if the review demands it)

- Fix only the findings in `review.md`; add a regression test per finding, and verify each one
  **fails without its fix**; write `repair-report.md`; then a final `final-review.md`.

## Step 7 — Parent acceptance

- The parent re-runs the full validation, updates `CHECKLIST.md`, and reports the outcome.
- **The commit and push are the user's decision.**

## Not in this plan

Non-image attachments, a remote model, a confirmation prompt, and any change to the outbound
`discord_send_image` path.
