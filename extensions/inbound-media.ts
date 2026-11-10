/**
 * Inbound Discord attachments → Pi image content.
 *
 * A Discord message can carry image attachments. Pi's `sendUserMessage()`
 * accepts `(TextContent | ImageContent)[]`, so an attachment can be handed to
 * the model directly — there is no need for the agent to go and fetch it.
 *
 * This module holds the **pure** part of that: which attachments to read,
 * how to describe the ones that are dropped, and how to build the content
 * blocks. The network fetch and the resize are injected (see
 * {@link InboundImageLoader}), so the whole thing is testable without Discord
 * and without the network.
 *
 * Only **images** are supported: `ImageContent` is the only image-shaped
 * input Pi exposes for a user message, so a PDF or an archive has no route.
 */

/** The image content block Pi expects. */
export interface InboundImageContent {
  type: "image";
  /** The image bytes, base64 encoded. */
  data: string;
  mimeType: string;
}

/** The text content block Pi expects. */
export interface InboundTextContent {
  type: "text";
  text: string;
}

/** One Discord attachment, reduced to what this module needs. */
export interface InboundAttachment {
  /** Discord's attachment id. */
  id: string;
  /** The file name, or null when Discord did not report one. */
  name: string | null;
  /** The CDN URL of the attachment. */
  url: string;
  /** The size in bytes, or null when unknown. */
  size: number | null;
  /** The MIME type, or null when unknown. */
  contentType: string | null;
}

/** Why an attachment was not read. */
export type InboundSkipReason =
  | "not_an_image"
  | "too_large"
  | "too_many"
  | "unreadable";

/** One attachment that was dropped, with the reason. */
export interface InboundSkipped {
  /** The file name, or the attachment id when it had no name. */
  name: string;
  reason: InboundSkipReason;
  /** The size in bytes, when known. */
  size: number | null;
}

/** The outcome of picking the attachments to read. */
export interface InboundSelection {
  /** The attachments to fetch, in the order Discord listed them. */
  accepted: InboundAttachment[];
  /** The attachments that were dropped, with the reason. */
  skipped: InboundSkipped[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** How many images are read from a single message. */
export const INBOUND_IMAGE_LIMIT = 4;

/**
 * The largest attachment that is fetched, in bytes.
 *
 * Discord's own limit is 25 MB, but a 25 MB image becomes ~33 MB of base64
 * in the prompt — far past what a model accepts. The resize below brings an
 * accepted image down to {@link INBOUND_RESIZE_MAX_BYTES}; this cap is the
 * first gate, before anything is downloaded.
 */
export const INBOUND_MAX_BYTES = 10 * 1024 * 1024;

/** The budget the image is resized to, in bytes. */
export const INBOUND_RESIZE_MAX_BYTES = 2 * 1024 * 1024;

/** The longest edge the image is resized to, in pixels. */
export const INBOUND_RESIZE_MAX_EDGE = 2048;

/** How long one attachment fetch may take. */
export const INBOUND_FETCH_TIMEOUT_MS = 15_000;

/** The limits a selection runs under. */
export interface InboundLimits {
  /** How many images per message. */
  maxImages?: number;
  /** The largest attachment that is fetched, in bytes. */
  maxBytes?: number;
}

/**
 * Detect the MIME type of an image from its **bytes**.
 *
 * Discord's reported content type is not trusted: the resizer echoes the
 * input type back when it does not resize, so a mislabelled attachment would
 * reach the model under the wrong type — and a provider that believes the
 * label decodes nothing, and the image is silently not seen.
 *
 * The bytes are authoritative, so they are what is sniffed here.
 *
 * Returns null for a format that is not recognised.
 */
export function detectImageMimeType(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 4) return null;

  // PNG: 89 50 4E 47
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";

  // GIF: "GIF8"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }

  // BMP: "BM"
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";

  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

// ─── Selection ───────────────────────────────────────────────────────────────

/** Is this MIME type an image? */
function isImageType(contentType: string | null): boolean {
  if (typeof contentType !== "string") return false;
  const normalized = contentType.trim().toLowerCase();
  return normalized.startsWith("image/");
}

/** The display name of an attachment. */
function attachmentName(attachment: InboundAttachment): string {
  const name = typeof attachment.name === "string" ? attachment.name.trim() : "";
  return name.length > 0 ? name : attachment.id;
}

/**
 * Pick the attachments worth reading.
 *
 * The order is: **images first** (a PNG and a JPEG are both usable), then
 * everything else — so an image is never dropped because a PDF came first.
 *
 * An attachment with no known MIME type is treated as *not* an image: reading
 * it would fail anyway, and guessing would put binary data in a prompt.
 */
export function selectInboundImages(
  attachments: InboundAttachment[],
  limits: InboundLimits = {},
): InboundSelection {
  const maxImages =
    typeof limits.maxImages === "number" && limits.maxImages >= 0
      ? limits.maxImages
      : INBOUND_IMAGE_LIMIT;
  const maxBytes =
    typeof limits.maxBytes === "number" && limits.maxBytes >= 0
      ? limits.maxBytes
      : INBOUND_MAX_BYTES;

  const list = Array.isArray(attachments) ? attachments : [];
  const accepted: InboundAttachment[] = [];
  const skipped: InboundSkipped[] = [];

  const images = list.filter((attachment) => isImageType(attachment.contentType));
  const others = list.filter((attachment) => !isImageType(attachment.contentType));

  for (const attachment of images) {
    if (accepted.length >= maxImages) {
      skipped.push({
        name: attachmentName(attachment),
        reason: "too_many",
        size: attachment.size,
      });
      continue;
    }
    if (attachment.size !== null && attachment.size > maxBytes) {
      skipped.push({
        name: attachmentName(attachment),
        reason: "too_large",
        size: attachment.size,
      });
      continue;
    }
    accepted.push(attachment);
  }

  for (const attachment of others) {
    skipped.push({
      name: attachmentName(attachment),
      reason: "not_an_image",
      size: attachment.size,
    });
  }

  return { accepted, skipped };
}

// ─── Content building ───────────────────────────────────────────────────────

/**
 * The text that stands in for an attachment-only message.
 *
 * Pi splits the content array into a text string and a list of images, so an
 * image-only message would otherwise carry an **empty** prompt. The marker is
 * structural, not a claim about what the user wrote.
 */
export function inboundAttachmentMarker(count: number): string {
  return `[${count} image attachment${count === 1 ? "" : "s"}]`;
}

/**
 * Build the content blocks for a message that carries images.
 *
 * The user's own text is passed through **verbatim**. It is only replaced by
 * the structural marker when the message carried no text at all.
 */
export function buildInboundContent(
  text: string,
  images: InboundImageContent[],
): (InboundTextContent | InboundImageContent)[] {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const blocks: (InboundTextContent | InboundImageContent)[] = [];

  if (trimmed.length > 0) {
    blocks.push({ type: "text", text });
  } else if (images.length > 0) {
    blocks.push({ type: "text", text: inboundAttachmentMarker(images.length) });
  }

  for (const image of images) {
    blocks.push({
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
    });
  }

  return blocks;
}

/**
 * What to hand to Pi for one Discord message.
 *
 * With no images the message goes in as the **plain string** it always did —
 * the array form is only used when there is something extra to carry. That
 * keeps the common path byte-identical to the behaviour before attachments
 * were supported.
 */
export function buildInboundMessage(
  text: string,
  images: InboundImageContent[],
): string | (InboundTextContent | InboundImageContent)[] {
  if (!Array.isArray(images) || images.length === 0) return text;
  return buildInboundContent(text, images);
}

// ─── Skip notices ────────────────────────────────────────────────────────────

/** A human-readable byte size, e.g. `12.4 MB`. */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Why an attachment was dropped, in one short phrase. */
export function describeSkipReason(reason: InboundSkipReason, size: number | null): string {
  switch (reason) {
    case "not_an_image":
      return "not an image";
    case "too_large": {
      const actual = formatBytes(size);
      const limit = formatBytes(INBOUND_MAX_BYTES);
      return actual && limit ? `too large (${actual}, limit ${limit})` : "too large";
    }
    case "too_many":
      return `too many images (limit ${INBOUND_IMAGE_LIMIT})`;
    default:
      return "could not be read";
  }
}

/**
 * The notice posted when an attachment was dropped.
 *
 * It is posted so the user learns *why* the agent did not see the file,
 * instead of the agent simply reporting that it cannot see it.
 */
export function describeSkipped(skipped: InboundSkipped[]): string | null {
  if (!Array.isArray(skipped) || skipped.length === 0) return null;
  const parts = skipped
    .slice(0, 3)
    .map((entry) => `${entry.name} (${describeSkipReason(entry.reason, entry.size)})`);
  const suffix = skipped.length > 3 ? `, +${skipped.length - 3} more` : "";
  return `⚠️ Skipped attachment${skipped.length === 1 ? "" : "s"}: ${parts.join(", ")}${suffix}`;
}

// ─── Loading ─────────────────────────────────────────────────────────────────

/** The injected network + resize operations. */
export interface InboundImageLoader {
  /**
   * Fetch the raw bytes of an attachment, or null when it cannot be read.
   *
   * The implementation must not read more than `maxBytes`.
   */
  fetchBytes: (url: string, maxBytes: number) => Promise<Uint8Array | null>;
  /**
   * Downscale an image to a model-friendly size.
   *
   * Returns null when the image cannot be decoded or brought under the
   * budget.
   */
  resize: (
    bytes: Uint8Array,
    mimeType: string,
    options: { maxWidth: number; maxHeight: number; maxBytes: number },
  ) => Promise<{ data: string; mimeType: string } | null>;
}

/** The result of reading one attachment. */
export type InboundLoadResult =
  | { ok: true; image: InboundImageContent }
  | { ok: false; reason: InboundSkipReason };

/**
 * Read one attachment into an image content block.
 *
 * Never throws: an unreadable attachment comes back as a skip, not as an
 * exception that would break the message handler.
 */
export async function loadInboundImage(
  attachment: InboundAttachment,
  loader: InboundImageLoader,
  limits: InboundLimits = {},
): Promise<InboundLoadResult> {
  const maxBytes =
    typeof limits.maxBytes === "number" && limits.maxBytes >= 0
      ? limits.maxBytes
      : INBOUND_MAX_BYTES;

  let bytes: Uint8Array | null;
  try {
    bytes = await loader.fetchBytes(attachment.url, maxBytes);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!bytes || bytes.length === 0) return { ok: false, reason: "unreadable" };
  if (bytes.length > maxBytes) return { ok: false, reason: "too_large" };

  // The **bytes** are the authority, not Discord's reported content type:
  // the resizer echoes its input type back when it does not resize, so a
  // mislabelled attachment would otherwise reach the model under the wrong
  // label — and a provider that believes the label sees nothing.
  //
  // Passing the detected type *in* also makes the resizer's own return value
  // correct in both cases: it echoes the detected type when it leaves the
  // image alone, and reports the real type when it re-encodes it.
  const reported =
    typeof attachment.contentType === "string" && attachment.contentType.trim().length > 0
      ? attachment.contentType.trim().toLowerCase()
      : null;
  const mimeType = detectImageMimeType(bytes) ?? reported ?? "image/png";

  let resized: { data: string; mimeType: string } | null;
  try {
    resized = await loader.resize(bytes, mimeType, {
      maxWidth: INBOUND_RESIZE_MAX_EDGE,
      maxHeight: INBOUND_RESIZE_MAX_EDGE,
      maxBytes: INBOUND_RESIZE_MAX_BYTES,
    });
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!resized) return { ok: false, reason: "unreadable" };

  return {
    ok: true,
    image: { type: "image", data: resized.data, mimeType: resized.mimeType },
  };
}
