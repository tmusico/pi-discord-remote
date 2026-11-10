import { describe, it, expect } from "vitest";

import { buildSetupConfig } from "../index.js";

// ─── buildSetupConfig: the config written by `/pi-discord-remote setup` ─────

describe("buildSetupConfig", () => {
  const inputs = {
    token: "new-token",
    guildId: "guild-1",
    categoryId: "cat-1",
    allowedUserIds: ["user-1"],
    toolResponses: true,
  };

  it("defaults keepOnline to true when there is no existing config", () => {
    expect(buildSetupConfig(null, inputs).keepOnline).toBe(true);
  });

  it("keeps an existing keepOnline: true", () => {
    const existing = { token: "old-token", guildId: "old-guild", keepOnline: true };
    expect(buildSetupConfig(existing, inputs).keepOnline).toBe(true);
  });

  it("preserves an existing keepOnline: false", () => {
    const existing = { token: "old-token", guildId: "old-guild", keepOnline: false };
    const cfg = buildSetupConfig(existing, inputs);

    expect(cfg.keepOnline).toBe(false);
  });

  it("writes the other answers unchanged", () => {
    expect(buildSetupConfig(null, inputs)).toEqual({
      token: "new-token",
      guildId: "guild-1",
      categoryId: "cat-1",
      allowedUserIds: ["user-1"],
      reactions: true,
      toolResponses: true,
      keepOnline: true,
      inboundImages: true,
    });
  });

  it("defaults inboundImages to true when there is no existing config", () => {
    expect(buildSetupConfig(null, inputs).inboundImages).toBe(true);
  });

  it("preserves an existing inboundImages: false", () => {
    const existing = {
      token: "old-token",
      guildId: "old-guild",
      keepOnline: true,
      inboundImages: false,
    };
    expect(buildSetupConfig(existing, inputs).inboundImages).toBe(false);
  });

  it("keeps an existing inboundImages: true", () => {
    const existing = {
      token: "old-token",
      guildId: "old-guild",
      inboundImages: true,
    };
    expect(buildSetupConfig(existing, inputs).inboundImages).toBe(true);
  });

  it("omits empty optional answers", () => {
    const cfg = buildSetupConfig(null, { token: "t", guildId: "g" });

    expect(cfg.categoryId).toBeUndefined();
    expect(cfg.allowedUserIds).toBeUndefined();
    expect(cfg.toolResponses).toBe(false);
    expect(cfg.keepOnline).toBe(true);
  });
});
