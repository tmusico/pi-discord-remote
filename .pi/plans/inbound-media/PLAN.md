# PLAN — inbound Discord attachments

## Problem

`pi-discord-remote` can **send** images to Discord (`discord_send_image`), but it cannot **read**
them. The inbound path is one line:

```ts
pi.sendUserMessage(message.content);
```

`message.attachments` is never looked at, so a screenshot pasted into the Discord channel is
invisible to the agent — the agent replies as if nothing was attached.

The capability to fix this already exists: Pi's `sendUserMessage()` accepts
`(TextContent | ImageContent)[]`, so an attachment can be handed straight to the model.

## Goal

Read **image** attachments off a Discord message and hand them to the model alongside the user's
text — without changing anything about a message that has no attachments.

## Non-goals

- **Non-image files.** `ImageContent` is the only image-shaped input Pi exposes for a user
  message. A PDF, an archive or a `.txt` has no route and is reported as skipped.
- **No remote model.** The image goes to the model the session already uses. Nothing here
  changes the model, the session or the channel.
- **No new Discord interaction.** No confirmation prompt, no slash command — the attachment
  rides along with the message the user already sent.
- **No change to the outbound path.** `discord_send_image` is untouched.

## Current state

- The extension is a Pi extension; it runs inside the Pi process and already has the Discord
  client and `pi.sendUserMessage()`.
- `discord.js` v14 exposes `message.attachments` as a `Collection<Snowflake, Attachment>` with
  `.url`, `.contentType`, `.size` and `.name`.
- The installed Pi SDK was **0.74.0 as an auto-installed peer** — it was never a direct
  dependency, so the typecheck ran against a version the extension never loads. The runtime is
  **1.5.0**, which exports `resizeImage()`.

## Decisions (user-confirmed)

| # | Decision |
|---|-----------|
| 1 | **Read attachments in.** The user asked for it and said build it. |
| 2 | **Bump the devDependency to the runtime SDK** (`@earendil-works/pi-coding-agent` 1.5.0) so the typecheck matches what is actually loaded. This is the one dependency change in the feature. |
| 3 | **Images only.** Everything else is reported as skipped. |
| 4 | **Default on**, with a config switch (`inboundImages`). |

## Target outcome

A user posts a screenshot in the Discord channel:

```
[user]  what is broken here?   📎 screenshot.png
```

The agent receives the text **and** the image, and answers about the screenshot.

## Implementation shape

| File | Responsibility |
|------|----------------|
| `extensions/inbound-media.ts` (new) | **Pure.** Which attachments to read, the content blocks, the skip notices, and `loadInboundImage()` with the network + resize **injected**. |
| `extensions/index.ts` (edit) | The real loader (bounded fetch + the SDK's `resizeImage`), the Discord attachment → `InboundAttachment` mapping, and the message-handler wiring. |
| `extensions/config.ts` (edit) | `inboundImages?: boolean` (default `true`). |
| `extensions/__tests__/inbound-media.test.ts` (new) | The pure logic, plus two **integration** tests against the real SDK resizer. |

## The size problem, and why the resize is not optional

Discord's own attachment limit is 25 MB. Base64 inflates that by 4/3, so a 25 MB image becomes
~33 MB of base64 in the prompt — far past what a model accepts. Two gates, in order:

1. **Before the download** — an attachment whose reported `size` is over
   `INBOUND_MAX_BYTES` (10 MB) is skipped without being fetched.
2. **After the download** — the image is resized to `INBOUND_RESIZE_MAX_EDGE` (2048 px) and
   `INBOUND_RESIZE_MAX_BYTES` (2 MB).

Verified against the real resizer: a 2600×2200 PNG (1.64 MB raw, 2.19 MB as base64) comes back
as **2048×1733 JPEG, 1.59 MB** — both budgets enforced.

## The fetch is bounded, not trusted

The body is read **while it streams**, and abandoned the moment it exceeds the cap — an
oversized attachment is never buffered in full. `content-length` is checked first, and the read
itself is capped, so a missing or lying `content-length` does not get past it.

The attachments are fetched **in parallel**, so the wait is one timeout rather than one per
image.

## Hard rules

- **The no-attachment path is unchanged.** With no images the message is handed to Pi as the
  plain string it always was — `buildInboundMessage()` returns the string, not a block array.
- **The user's text is verbatim.** It is never trimmed, reworded or summarised. Only a message
  with **no** text at all gets the structural marker `[N image attachments]`.
- **A broken attachment never breaks the message.** Every failure is a skip, not an exception.
- **The skip is reported.** The user is told *why* the agent did not see the file, rather than
  the agent silently reporting that it cannot see it.
- **The resizer is loaded dynamically.** It only exists in newer Pi versions; a static import
  would stop the whole extension from loading on an older one. When it is missing, the bytes
  are forwarded unchanged — but only when they already fit the budget.

## Risks

| Risk | Mitigation |
|------|------------|
| A huge attachment is downloaded | The size is checked before the fetch and the read is capped while streaming. |
| The fetch delays the turn | The attachments are fetched in parallel, with one 15 s timeout for all of them. |
| The model does not support images | Pi and the provider decide; the image is passed through as Pi's normal image content. |
| The SDK's `resizeImage` is missing on an older Pi | Dynamic import; the bytes are forwarded unchanged when they are already small enough. |
| The token cost of a screenshot | The resize keeps it to ~2 MB of base64, and the count is capped at 4 per message. |

## Verification approach

1. `npm run check` — typecheck against the **runtime** SDK (1.5.0).
2. `npm test` — the pure logic, plus integration tests that run the **real** SDK resizer over a
   real, valid PNG (built with zlib in the test) and over corrupt bytes.
3. `npm run build` — emits `dist/`.
4. `git diff --check`.
5. Manual: post a screenshot in the Discord channel and confirm the agent sees it.

## Acceptance criteria

- [x] An image attachment on a Discord message reaches the model as an image content block.
- [x] A message with no attachment is handed to Pi exactly as before (a plain string).
- [x] The user's text is passed through verbatim.
- [x] An image-only message still reaches the agent, with a structural marker as the text.
- [x] A non-image attachment is skipped and reported.
- [x] An oversized attachment is skipped **before** it is downloaded, and reported.
- [x] A corrupt or unreadable image is skipped and reported — never an exception.
- [x] At most 4 images are read per message.
- [x] The image is resized to ≤2048 px and ≤2 MB.
- [x] `inboundImages: false` turns the whole thing off.
- [x] `npm run check && npm test && npm run build` pass; `git diff --check` is clean.

## Out of scope

Non-image attachments, the outbound path, a remote model, a confirmation prompt, and any change
to how a message without attachments is handled.
