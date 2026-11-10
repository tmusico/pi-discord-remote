import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";

import {
  buildInboundContent,
  buildInboundMessage,
  describeSkipReason,
  detectImageMimeType,
  describeSkipped,
  formatBytes,
  inboundAttachmentMarker,
  loadInboundImage,
  selectInboundImages,
  INBOUND_IMAGE_LIMIT,
  INBOUND_MAX_BYTES,
  type InboundAttachment,
  type InboundImageLoader,
} from "../inbound-media.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function attachment(overrides: Partial<InboundAttachment> = {}): InboundAttachment {
  return {
    id: "att-1",
    name: "screenshot.png",
    url: "https://cdn.discordapp.net/att-1/screenshot.png",
    size: 1024,
    contentType: "image/png",
    ...overrides,
  };
}

const IMAGE = { type: "image", data: "AAAA", mimeType: "image/png" } as const;

// ─── Selection ───────────────────────────────────────────────────────────────

describe("selectInboundImages", () => {
  it("accepts image attachments", () => {
    const selection = selectInboundImages([attachment()]);
    expect(selection.accepted).toHaveLength(1);
    expect(selection.skipped).toHaveLength(0);
  });

  it("keeps images ahead of other file types", () => {
    const selection = selectInboundImages([
      attachment({ id: "pdf", name: "doc.pdf", contentType: "application/pdf" }),
      attachment({ id: "png", name: "shot.png", contentType: "image/png" }),
    ]);
    expect(selection.accepted.map((a) => a.id)).toEqual(["png"]);
    expect(selection.skipped.map((a) => a.name)).toEqual(["doc.pdf"]);
  });

  it("skips a non-image attachment", () => {
    const selection = selectInboundImages([
      attachment({ contentType: "application/pdf", name: "doc.pdf" }),
    ]);
    expect(selection.accepted).toHaveLength(0);
    expect(selection.skipped[0].reason).toBe("not_an_image");
  });

  it("treats an unknown content type as not an image", () => {
    const selection = selectInboundImages([attachment({ contentType: null })]);
    expect(selection.accepted).toHaveLength(0);
    expect(selection.skipped[0].reason).toBe("not_an_image");
  });

  it("skips an oversized attachment before fetching it", () => {
    const selection = selectInboundImages([
      attachment({ size: INBOUND_MAX_BYTES + 1, name: "huge.png" }),
    ]);
    expect(selection.accepted).toHaveLength(0);
    expect(selection.skipped[0].reason).toBe("too_large");
    expect(selection.skipped[0].size).toBe(INBOUND_MAX_BYTES + 1);
  });

  it("accepts an attachment exactly at the size limit", () => {
    const selection = selectInboundImages([attachment({ size: INBOUND_MAX_BYTES })]);
    expect(selection.accepted).toHaveLength(1);
  });

  it("caps the number of images per message", () => {
    const many = Array.from({ length: INBOUND_IMAGE_LIMIT + 2 }, (_unused, index) =>
      attachment({ id: `att-${index}`, name: `image-${index}.png` }),
    );
    const selection = selectInboundImages(many);
    expect(selection.accepted).toHaveLength(INBOUND_IMAGE_LIMIT);
    expect(selection.skipped).toHaveLength(2);
    expect(selection.skipped[0].reason).toBe("too_many");
  });

  it("honours a custom limit", () => {
    const selection = selectInboundImages(
      [attachment({ id: "a" }), attachment({ id: "b" })],
      { maxImages: 1 },
    );
    expect(selection.accepted).toHaveLength(1);
    expect(selection.skipped[0].reason).toBe("too_many");
  });

  it("names an attachment without a file name by its id", () => {
    const selection = selectInboundImages([attachment({ name: null, contentType: "image/png" })]);
    expect(selection.accepted[0].id).toBe("att-1");
  });

  it("tolerates an empty or missing list", () => {
    expect(selectInboundImages([]).accepted).toHaveLength(0);
    expect(selectInboundImages(undefined as unknown as InboundAttachment[]).accepted).toHaveLength(
      0,
    );
  });
});

// ─── Content building ───────────────────────────────────────────────────────

describe("buildInboundContent", () => {
  it("puts the user's text first, verbatim", () => {
    const blocks = buildInboundContent("  look at this  ", [IMAGE]);
    expect(blocks[0]).toEqual({ type: "text", text: "  look at this  " });
    expect(blocks[1]).toEqual(IMAGE);
  });

  it("adds a structural marker when the message had no text", () => {
    const blocks = buildInboundContent("", [IMAGE]);
    expect(blocks[0]).toEqual({ type: "text", text: "[1 image attachment]" });
    expect(blocks).toHaveLength(2);
  });

  it("counts the attachments in the marker", () => {
    const blocks = buildInboundContent("   ", [IMAGE, IMAGE]);
    expect((blocks[0] as { text: string }).text).toBe("[2 image attachments]");
  });

  it("is empty when there is neither text nor an image", () => {
    expect(buildInboundContent("", [])).toHaveLength(0);
  });
});

describe("inboundAttachmentMarker", () => {
  it("is singular for one attachment", () => {
    expect(inboundAttachmentMarker(1)).toBe("[1 image attachment]");
  });

  it("is plural for more", () => {
    expect(inboundAttachmentMarker(3)).toBe("[3 image attachments]");
  });
});

describe("buildInboundMessage", () => {
  it("keeps the plain string when there are no images", () => {
    expect(buildInboundMessage("hello", [])).toBe("hello");
  });

  it("uses the blocks when there are images", () => {
    const message = buildInboundMessage("hello", [IMAGE]);
    expect(Array.isArray(message)).toBe(true);
    expect(message).toHaveLength(2);
  });
});

// ─── Skip notices ────────────────────────────────────────────────────────────

describe("formatBytes", () => {
  it("formats a byte count", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(12 * 1024 * 1024)).toBe("12.0 MB");
  });

  it("returns null for an unknown size", () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
  });
});

describe("describeSkipReason", () => {
  it("names each reason", () => {
    expect(describeSkipReason("not_an_image", null)).toBe("not an image");
    expect(describeSkipReason("too_many", null)).toContain("too many images");
    expect(describeSkipReason("unreadable", null)).toBe("could not be read");
    expect(describeSkipReason("too_large", 20 * 1024 * 1024)).toContain("too large");
  });
});

describe("describeSkipped", () => {
  it("is null when nothing was skipped", () => {
    expect(describeSkipped([])).toBeNull();
  });

  it("lists the skipped attachments", () => {
    const notice = describeSkipped([
      { name: "huge.png", reason: "too_large", size: 20 * 1024 * 1024 },
    ]);
    expect(notice).toContain("huge.png");
    expect(notice).toContain("too large");
  });

  it("caps the list and says how many more there are", () => {
    const notice = describeSkipped(
      Array.from({ length: 5 }, (_unused, index) => ({
        name: `f${index}.png`,
        reason: "not_an_image" as const,
        size: null,
      })),
    );
    expect(notice).toContain("+2 more");
  });
});

// ─── Loading ─────────────────────────────────────────────────────────────────

describe("loadInboundImage", () => {
  function loader(overrides: Partial<InboundImageLoader> = {}): InboundImageLoader {
    return {
      async fetchBytes() {
        return new Uint8Array([1, 2, 3]);
      },
      async resize(_bytes, mimeType) {
        return { data: "BASE64", mimeType };
      },
      ...overrides,
    };
  }

  it("returns the resized image", async () => {
    const result = await loadInboundImage(attachment(), loader());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.image).toEqual({ type: "image", data: "BASE64", mimeType: "image/png" });
    }
  });

  it("reports an unreadable attachment when the fetch throws", async () => {
    const result = await loadInboundImage(
      attachment(),
      loader({
        async fetchBytes() {
          throw new Error("network down");
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreadable");
  });

  it("reports an unreadable attachment when the fetch returns nothing", async () => {
    const result = await loadInboundImage(
      attachment(),
      loader({
        async fetchBytes() {
          return null;
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreadable");
  });

  it("reports an oversized download", async () => {
    const result = await loadInboundImage(
      attachment(),
      loader({
        async fetchBytes() {
          return new Uint8Array(50);
        },
      }),
      { maxBytes: 10 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_large");
  });

  it("reports an unreadable image when the resize fails", async () => {
    const result = await loadInboundImage(
      attachment(),
      loader({
        async resize() {
          return null;
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreadable");
  });

  it("reports an unreadable image when the resize throws", async () => {
    const result = await loadInboundImage(
      attachment(),
      loader({
        async resize() {
          throw new Error("photon exploded");
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreadable");
  });

  it("passes the resize budget to the loader", async () => {
    const seen: unknown[] = [];
    await loadInboundImage(
      attachment(),
      loader({
        async resize(_bytes, _mimeType, options) {
          seen.push(options);
          return { data: "BASE64", mimeType: "image/png" };
        },
      }),
    );
    expect(seen[0]).toMatchObject({ maxWidth: 2048, maxHeight: 2048 });
  });
});

// ─── Integration: the real Pi resizer ───────────────────────────────────────

/**
 * Build a real, valid PNG (16×16).
 *
 * The resizer is exercised against real bytes, not a mock: a hand-written
 * base64 blob can be subtly invalid, and a mocked resize proves nothing about
 * the SDK call.
 */
function makeRealPng(): Uint8Array {
  const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();

  const crc32 = (buffer: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const width = 16;
  const height = 16;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour

  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = x * 16;
      raw[p + 1] = y * 16;
      raw[p + 2] = 200;
    }
  }

  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

describe("loadInboundImage with the real Pi resizer", () => {
  it("turns a real PNG into a Pi image content block", async () => {
    const { resizeImage } = await import("@earendil-works/pi-coding-agent");
    const bytes = makeRealPng();

    const result = await loadInboundImage(attachment(), {
      async fetchBytes() {
        return bytes;
      },
      async resize(input, mimeType, options) {
        const resized = await resizeImage(input, mimeType, options);
        return resized ? { data: resized.data, mimeType: resized.mimeType } : null;
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.type).toBe("image");
    expect(result.image.mimeType).toMatch(/^image\//);
    // The data is base64 and decodes back to a real image.
    const decoded = Buffer.from(result.image.data, "base64");
    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  it("reports a corrupt image as unreadable, not as a crash", async () => {
    const { resizeImage } = await import("@earendil-works/pi-coding-agent");

    const result = await loadInboundImage(attachment(), {
      async fetchBytes() {
        return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      },
      async resize(input, mimeType, options) {
        const resized = await resizeImage(input, mimeType, options);
        return resized ? { data: resized.data, mimeType: resized.mimeType } : null;
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreadable");
  });
});

// ─── Regression tests for the review findings ───────────────────────────────

describe("review repairs: the MIME type comes from the bytes", () => {
  it("R-P2-2: detects the type from the bytes, not from Discord's report", () => {
    // A real PNG.
    const png = makeRealPng();
    expect(detectImageMimeType(png)).toBe("image/png");
  });

  it("R-P2-2: detects JPEG, GIF, BMP and WebP", () => {
    expect(detectImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImageMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe("image/gif");
    expect(detectImageMimeType(new Uint8Array([0x42, 0x4d, 0x00, 0x00]))).toBe("image/bmp");
    expect(
      detectImageMimeType(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("image/webp");
  });

  it("R-P2-2: returns null for bytes that are not a known image", () => {
    expect(detectImageMimeType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(detectImageMimeType(new Uint8Array([]))).toBeNull();
  });

  it("R-P2-2: a mislabelled attachment is labelled by its bytes", async () => {
    const png = makeRealPng();
    const seen: string[] = [];

    const result = await loadInboundImage(
      // Discord says JPEG; the bytes are PNG.
      attachment({ contentType: "image/jpeg" }),
      {
        async fetchBytes() {
          return png;
        },
        // The real resizer echoes its input type back when it does not resize.
        async resize(_bytes, mimeType) {
          seen.push(mimeType);
          return { data: "BASE64", mimeType };
        },
      },
    );

    // The detected type was handed to the resizer, so its echo is correct.
    expect(seen[0]).toBe("image/png");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.image.mimeType).toBe("image/png");
  });

  it("R-P3-2: the old-Pi fallback labels the bytes by their type too", async () => {
    const png = makeRealPng();

    const result = await loadInboundImage(
      attachment({ contentType: "image/jpeg" }),
      {
        async fetchBytes() {
          return png;
        },
        // An older Pi without the resizer: the bytes are forwarded as they are.
        async resize(bytes, mimeType) {
          return { data: Buffer.from(bytes).toString("base64"), mimeType };
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.image.mimeType).toBe("image/png");
  });

  it("R-P2-2: falls back to the reported type for an unrecognised format", async () => {
    const result = await loadInboundImage(
      attachment({ contentType: "image/avif" }),
      {
        async fetchBytes() {
          return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        },
        async resize(_bytes, mimeType) {
          return { data: "BASE64", mimeType };
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.image.mimeType).toBe("image/avif");
  });
});
