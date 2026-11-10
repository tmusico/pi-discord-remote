# Review — inbound Discord attachments

Read-only review of the inbound-media feature (`.pi/plans/inbound-media/`), on branch
`feat/slash-control`.

**Scope reviewed:** `extensions/inbound-media.ts` (new), `extensions/index.ts` (the loader and the
message-handler wiring), `extensions/config.ts`, `extensions/__tests__/inbound-media.test.ts`
(new), `README.md`, `package.json` / `package-lock.json`, and the plan artifacts.

**Verdict: CHANGES REQUIRED** — 1 × P1, 2 × P2, 2 × P3, plus one pre-existing observation.

Every finding below was **reproduced** before it was reported.

---

## What was verified as correct

| Area | Result |
|------|--------|
| **The unchanged path** | `buildInboundMessage()` returns the **plain string** when there are no images, so a message with no attachment reaches Pi exactly as before. Covered by a test. |
| **Text fidelity** | The user's text is passed through verbatim — not trimmed, not reworded. Only a message with no text at all gets the structural marker. |
| **The size guards** | The reported size is checked **before** the download; the read is capped **while streaming**, so a missing or lying `content-length` does not get past it. |
| **The real resizer** | Verified against the SDK's actual `resizeImage()`: a 2600×2200 PNG (1.64 MB raw → 2.19 MB base64) came back as **2048×1733 JPEG, 1.59 MB** — both budgets enforced. |
| **Failure containment** | A fetch that throws, a fetch that returns nothing, a corrupt image and a resize that throws all come back as a **skip**, never an exception. Covered by tests. |
| **The dynamic import** | The resizer is loaded lazily, so an older Pi without `resizeImage` degrades instead of failing to load the extension. Without it, bytes are forwarded unchanged — but only when they already fit the budget. |
| **No new dependency** | The only dependency change is the **devDependency** bump to the SDK the extension already loads. No runtime dependency was added. |
| **Parallel fetch** | The attachments are fetched concurrently, so the wait is one timeout rather than one per image. |
| **Privacy** | No attachment bytes, URLs or names are logged; only a short factual notice is posted in the channel. |

---

## Findings

### P1-1 — The attachment fetch widens the message race from milliseconds to seconds

**File:** `extensions/index.ts` (the message handler)

The handler's shape is now:

```ts
if (agentBusy) { …reject…; return; }        // ← the only guard
await message.react("⏳")…;                  // ← await #1
pendingReplyChannelId = …;                   // ← the reply target is claimed
pendingReplyUserId = …;
…
await readInboundImages(message);            // ← await #2 — up to 15 s
pi.sendUserMessage(…);
```

`agentBusy` only becomes true when `agent_start` fires, which happens **after**
`sendUserMessage` returns. So between the busy check and the injection, `agentBusy` is still
false and a second message is accepted.

Before this feature the only await in that window was the ⏳ reaction — one Discord API round
trip, tens of milliseconds. The feature inserts an await of up to **15 seconds** into the same
window.

**Reproduced** (a faithful simulation of the handler's state machine, with a slow fetch for the
first message and a fast one for the second):

```
injected: ["bob:second","alice:first"]
pendingReplyUserId is now: bob
→ the reply to ALICE will mention: bob
```

Three consequences, all real:

1. **Both** messages are injected — the busy check does not protect the window.
2. They are injected in **inverted order** — the second message's faster fetch finishes first, so
   the conversation the model sees is out of order.
3. The second message **overwrites `pendingReplyUserId`**, so the reply to the first message
   @-mentions the wrong person.

**Why it matters:** the reply mention is how the user knows their answer arrived. Pointing it at
the wrong person is worse than not pointing at all.

**Fix:** an explicit in-flight guard, set **synchronously** right after the busy check and
cleared in a `finally` after the injection. This closes the new window and the pre-existing
reaction window with it.

---

### P2-1 — Re-running `/pi-discord-remote setup` silently resets `inboundImages`

**File:** `extensions/index.ts` (`buildSetupConfig`)

`buildSetupConfig` rebuilds the config from the setup prompts and does not carry `inboundImages`
over:

```ts
return {
  token, guildId, …,
  reactions: true,
  toolResponses: inputs.toolResponses === true,
  keepOnline: existing?.keepOnline !== false,   // ← preserved
};
```

The function's own doc comment states the invariant:

> *"`keepOnline` is preserved from the existing config: re-running setup for an unrelated change
> must not silently reset a user's `keepOnline: false`."*

`inboundImages` is the same kind of key and is **not** preserved, so a user who turned it off
and then re-runs setup loses the setting with no warning and no way to tell.

**Fix:** `inboundImages: existing?.inboundImages !== false`.

---

### P2-2 — The image MIME type comes from Discord's report, not from the bytes

**Files:** `extensions/inbound-media.ts` (`loadInboundImage`), `extensions/index.ts` (the resize)

`loadInboundImage` passes `attachment.contentType` — Discord's **reported** type — to the
resizer, and the resizer **echoes the input type back** when it does not need to resize:

```js
// @earendil-works/pi-coding-agent — image-resize-core.js
if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
    return { data: Buffer.from(inputBytes).toString("base64"), mimeType: mimeType || … };
}
```

**Reproduced** with a real PNG but a mislabelled type:

```
reported mime:  image/jpeg
returned mime:  image/jpeg
actual bytes:   PNG
→ the label follows DISCORD, not the bytes: true
```

So a file Discord reports as `image/jpeg` but whose bytes are PNG reaches the provider labelled
`image/jpeg`. A provider that trusts the declared type decodes nothing and the image is silently
not seen — the user gets a confident answer about a picture the model never had.

The resizer itself is not at fault: Photon decoded the PNG correctly even when told it was a
JPEG. **The bytes can be sniffed** — the type just is not.

**Fix:** detect the MIME type from the magic bytes of the fetched image (PNG, JPEG, GIF, WebP,
BMP) and use that for the content block, falling back to the reported type only when the bytes
are not recognised.

---

### P3-1 — An unnecessary cast hides the content-block types

**File:** `extensions/index.ts`

```ts
pi.sendUserMessage(
  buildInboundMessage(message.content, inbound.images) as Parameters<
    typeof pi.sendUserMessage
  >[0],
);
```

Removing the cast **typechecks cleanly** (verified) — the structural types are already
compatible. The cast therefore buys nothing today, and it would silently accept a future
mismatch between `inbound-media.ts` and Pi's content types.

**Fix:** drop the cast.

---

### P3-2 — The old-Pi fallback trusts the same unverified MIME type

**File:** `extensions/index.ts` (the `resize` fallback)

When the SDK has no `resizeImage`, the bytes are forwarded with the **reported** type:

```ts
return { data: Buffer.from(bytes).toString("base64"), mimeType };
```

Same trust problem as P2-2. It is fixed by the same change (sniff the bytes), but it is a
separate code path and is called out so it is not missed.

---

### Observation (pre-existing, not introduced here)

`buildSetupConfig` also hardcodes `reactions: true`, so a user's `reactions: false` is lost on
re-setup — the same class of bug as P2-1, but it predates this work. It is **not** in this
feature's scope; it is recorded here so it is not lost.

---

## Verdict

**CHANGES REQUIRED.** P1-1 must be fixed before merge: the feature made a real, reproducible
message-ordering and reply-routing race roughly two orders of magnitude more likely.

P2-1 and P2-2 are correctness defects on the new path. P2-1 breaks an invariant the repo states
in its own doc comment; P2-2 lets a mislabelled image reach the model under the wrong type.

P3-1 and P3-2 are small and mechanical.

---

## Baseline at review time

- `timeout 300s npm test` → **463 tests**, 14 files, all pass.
- `timeout 120s npm run check` → clean.
- `timeout 180s npm run build` → clean.
- `git diff --check` → clean.
- Dependency change: `@earendil-works/pi-coding-agent` promoted from an auto-installed peer
  (0.74.0) to an explicit devDependency (`^1.5.0`), matching the runtime. No runtime dependency
  was added; the lockfile **shrank** by ~2100 lines.
- 26 files changed.
