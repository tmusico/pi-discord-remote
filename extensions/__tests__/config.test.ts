import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ─── defaultConfigTemplate ────────────────────────────────────────────────────

describe("defaultConfigTemplate", () => {
  it("returns valid JSON", async () => {
    const { defaultConfigTemplate } = await import("../config.js");
    const tpl = defaultConfigTemplate();
    const parsed = JSON.parse(tpl);
    expect(parsed).toBeDefined();
  });

  it("has the expected keys", async () => {
    const { defaultConfigTemplate } = await import("../config.js");
    const parsed = JSON.parse(defaultConfigTemplate());
    expect(parsed).toHaveProperty("token");
    expect(parsed).toHaveProperty("guildId");
    expect(parsed).toHaveProperty("categoryId");
    expect(parsed).toHaveProperty("allowedUserIds");
    expect(parsed).toHaveProperty("reactions");
    expect(parsed).toHaveProperty("toolResponses");
  });

  it("has sensible defaults", async () => {
    const { defaultConfigTemplate } = await import("../config.js");
    const parsed = JSON.parse(defaultConfigTemplate());
    expect(parsed.token).toBe("");
    expect(parsed.guildId).toBe("");
    expect(parsed.reactions).toBe(true);
    expect(parsed.toolResponses).toBe(false);
    expect(parsed.allowedUserIds).toEqual([]);
  });

  it("ends with a newline", async () => {
    const { defaultConfigTemplate } = await import("../config.js");
    expect(defaultConfigTemplate()).toMatch(/\n$/);
  });
});

// ─── keepOnline (hub mode) ──────────────────────────────────────────────────

describe("keepOnline", () => {
  it("is part of the default config template", async () => {
    const { defaultConfigTemplate } = await import("../config.js");
    const parsed = JSON.parse(defaultConfigTemplate());
    expect(parsed).toHaveProperty("keepOnline");
    expect(parsed.keepOnline).toBe(true);
  });

  it("is optional on the Config type", async () => {
    const { saveConfig, loadConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_TOKEN;

    // This test uses a temporary config file — it never touches the user's
    // real config (which holds the bot token).
    const tempDir = await mkdtemp(join(tmpdir(), "pi-discord-remote-keeponline-"));
    const tempFile = join(tempDir, "config.json");

    try {
      await saveConfig({ token: "t", guildId: "g" }, tempFile);
      const withoutFlag = await loadConfig(tempFile);
      expect(withoutFlag?.keepOnline).toBeUndefined();

      await saveConfig({ token: "t", guildId: "g", keepOnline: false }, tempFile);
      const withFlag = await loadConfig(tempFile);
      expect(withFlag?.keepOnline).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
    }
  });
});

// ─── saveConfig / loadConfig ──────────────────────────────────────────────────

describe("saveConfig + loadConfig", () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-discord-remote-test-"));
    tempFile = join(tempDir, "config.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("saveConfig writes valid JSON", async () => {
    const { saveConfig } = await import("../config.js");

    const cfg = {
      token: "test-token-123",
      guildId: "guild-456",
      categoryId: "cat-789",
      allowedUserIds: ["user1", "user2"],
      reactions: false,
      toolResponses: true,
    };

    await saveConfig(cfg, tempFile);

    const raw = await readFile(tempFile, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.token).toBe("test-token-123");
    expect(parsed.guildId).toBe("guild-456");
    expect(parsed.categoryId).toBe("cat-789");
    expect(parsed.allowedUserIds).toEqual(["user1", "user2"]);
    expect(parsed.reactions).toBe(false);
    expect(parsed.toolResponses).toBe(true);
  });

  it("loadConfig returns null when no config file and no env vars", async () => {
    const { loadConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    const origGuild = process.env.DISCORD_GUILD_ID;
    delete process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_GUILD_ID;

    try {
      // The file does not exist — the user's real config is never touched.
      const result = await loadConfig(tempFile);
      expect(result).toBeNull();
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
      if (origGuild !== undefined) process.env.DISCORD_GUILD_ID = origGuild;
    }
  });

  it("loadConfig falls back to env vars when no file exists", async () => {
    const { loadConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    const origGuild = process.env.DISCORD_GUILD_ID;
    const origCategory = process.env.DISCORD_CATEGORY_ID;

    process.env.DISCORD_TOKEN = "env-token";
    process.env.DISCORD_GUILD_ID = "env-guild";
    process.env.DISCORD_CATEGORY_ID = "env-category";

    try {
      const result = await loadConfig(tempFile);
      expect(result).not.toBeNull();
      expect(result!.token).toBe("env-token");
      expect(result!.guildId).toBe("env-guild");
      expect(result!.categoryId).toBe("env-category");
      expect(result!.reactions).toBe(true);
      expect(result!.toolResponses).toBe(false);
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
      else delete process.env.DISCORD_TOKEN;
      if (origGuild !== undefined) process.env.DISCORD_GUILD_ID = origGuild;
      else delete process.env.DISCORD_GUILD_ID;
      if (origCategory !== undefined) process.env.DISCORD_CATEGORY_ID = origCategory;
      else delete process.env.DISCORD_CATEGORY_ID;
    }
  });

  it("DISCORD_TOKEN env var overrides file token", async () => {
    const { loadConfig, saveConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    process.env.DISCORD_TOKEN = "override-token";

    try {
      await saveConfig(
        {
          token: "file-token",
          guildId: "some-guild",
        },
        tempFile,
      );

      const result = await loadConfig(tempFile);
      expect(result).not.toBeNull();
      expect(result!.token).toBe("override-token");
      expect(result!.guildId).toBe("some-guild");
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
      else delete process.env.DISCORD_TOKEN;
    }
  });

  it("loadConfig reads a previously saved config", async () => {
    const { loadConfig, saveConfig } = await import("../config.js");

    const origToken = process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_TOKEN;

    try {
      await saveConfig(
        {
          token: "round-trip-token",
          guildId: "round-trip-guild",
          allowedUserIds: ["a", "b"],
          reactions: false,
          toolResponses: true,
        },
        tempFile,
      );

      const result = await loadConfig(tempFile);
      expect(result).not.toBeNull();
      expect(result!.token).toBe("round-trip-token");
      expect(result!.guildId).toBe("round-trip-guild");
      expect(result!.allowedUserIds).toEqual(["a", "b"]);
      expect(result!.reactions).toBe(false);
      expect(result!.toolResponses).toBe(true);
    } finally {
      if (origToken !== undefined) process.env.DISCORD_TOKEN = origToken;
    }
  });
});
