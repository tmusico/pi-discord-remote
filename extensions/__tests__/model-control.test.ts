import { describe, it, expect } from "vitest";

import {
  EMBED_MAX_FIELDS,
  EMBED_TOTAL_MAX,
  MESSAGE_MAX,
  MODEL_CANDIDATE_LIMIT,
  buildModelCatalog,
  buildModelListEmbed,
  buildModelListReply,
  formatModelListText,
  resolveModelSelection,
  type ModelLike,
} from "../model-control.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const MODELS: ModelLike[] = [
  { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
  { provider: "openai", id: "gpt-5.1", name: "GPT-5.1" },
];

// ─── Catalog ─────────────────────────────────────────────────────────────────

describe("buildModelCatalog", () => {
  it("builds a qualified id and keeps the display name", () => {
    const catalog = buildModelCatalog(MODELS, null);
    const entry = catalog.entries.find((e) => e.provider === "anthropic" && e.modelId === "claude-opus-4-1");
    expect(entry).toBeDefined();
    expect(entry!.id).toBe("anthropic/claude-opus-4-1");
    expect(entry!.name).toBe("Claude Opus 4.1");
  });

  it("falls back to the model id when the model has no name", () => {
    const catalog = buildModelCatalog([{ provider: "openai", id: "gpt-5.1" }], null);
    expect(catalog.entries[0].name).toBe("gpt-5.1");
    expect(catalog.entries[0].name.length).toBeGreaterThan(0);
  });

  it("ignores a blank name and never emits an empty label", () => {
    const catalog = buildModelCatalog([{ provider: "openai", id: "gpt-5.1", name: "   " }], null);
    expect(catalog.entries[0].name).toBe("gpt-5.1");
  });

  it("sorts deterministically: provider, then model id", () => {
    const catalog = buildModelCatalog(MODELS, null);
    expect(catalog.entries.map((e) => e.id)).toEqual([
      "anthropic/claude-opus-4-1",
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-5.1",
      "openai-codex/gpt-6.1-sol",
    ]);
  });

  it("puts the current model first", () => {
    const catalog = buildModelCatalog(MODELS, "openai-codex/gpt-6.1-sol");
    expect(catalog.entries[0].id).toBe("openai-codex/gpt-6.1-sol");
    expect(catalog.entries[0].current).toBe(true);
    expect(catalog.entries.filter((e) => e.current)).toHaveLength(1);
    expect(catalog.currentId).toBe("openai-codex/gpt-6.1-sol");
  });

  it("marks the current model case-insensitively", () => {
    const catalog = buildModelCatalog(MODELS, "OpenAI-Codex/GPT-6.1-SOL");
    expect(catalog.entries[0].id).toBe("openai-codex/gpt-6.1-sol");
    expect(catalog.entries[0].current).toBe(true);
  });

  it("caps the visible list and flags the truncation", () => {
    const catalog = buildModelCatalog(MODELS, null, 2);
    expect(catalog.visible).toHaveLength(2);
    expect(catalog.truncated).toBe(true);
    expect(catalog.total).toBe(4);
    expect(catalog.entries).toHaveLength(4);
  });

  it("does not flag the truncation when everything fits", () => {
    const catalog = buildModelCatalog(MODELS, null, 20);
    expect(catalog.visible).toHaveLength(4);
    expect(catalog.truncated).toBe(false);
    expect(catalog.total).toBe(4);
  });

  it("handles an empty model list", () => {
    const catalog = buildModelCatalog([], null);
    expect(catalog.entries).toHaveLength(0);
    expect(catalog.visible).toHaveLength(0);
    expect(catalog.truncated).toBe(false);
    expect(catalog.total).toBe(0);
    expect(catalog.currentId).toBeNull();
  });
});

// ─── Resolution ──────────────────────────────────────────────────────────────

describe("resolveModelSelection", () => {
  const catalog = buildModelCatalog(MODELS, null);

  it("resolves an exact qualified id", () => {
    const selection = resolveModelSelection(catalog, "anthropic/claude-sonnet-4-5");
    expect(selection.kind).toBe("exact");
    if (selection.kind === "exact") {
      expect(selection.entry.id).toBe("anthropic/claude-sonnet-4-5");
    }
  });

  it("resolves an exact qualified id case-insensitively", () => {
    const selection = resolveModelSelection(catalog, "Anthropic/Claude-Sonnet-4-5");
    expect(selection.kind).toBe("exact");
    if (selection.kind === "exact") {
      expect(selection.entry.id).toBe("anthropic/claude-sonnet-4-5");
    }
  });

  it("resolves a unique bare model id", () => {
    const selection = resolveModelSelection(catalog, "gpt-5.1");
    expect(selection.kind).toBe("exact");
    if (selection.kind === "exact") {
      expect(selection.entry.id).toBe("openai/gpt-5.1");
    }
  });

  it("reports an ambiguous bare model id", () => {
    const ambiguousCatalog = buildModelCatalog(
      [
        { provider: "openai", id: "gpt-5.1", name: "GPT-5.1" },
        { provider: "azure", id: "gpt-5.1", name: "GPT-5.1 (Azure)" },
      ],
      null,
    );
    const selection = resolveModelSelection(ambiguousCatalog, "gpt-5.1");
    expect(selection.kind).toBe("ambiguous");
    if (selection.kind === "ambiguous") {
      expect(selection.candidates.map((c) => c.id)).toEqual(["azure/gpt-5.1", "openai/gpt-5.1"]);
      expect(selection.query).toBe("gpt-5.1");
    }
  });

  it("resolves a unique prefix of a qualified id", () => {
    const selection = resolveModelSelection(catalog, "anthropic/claude-sonnet");
    expect(selection.kind).toBe("exact");
    if (selection.kind === "exact") {
      expect(selection.entry.id).toBe("anthropic/claude-sonnet-4-5");
    }
  });

  it("reports an ambiguous prefix of a qualified id", () => {
    const ambiguousCatalog = buildModelCatalog(
      [
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "anthropic", id: "claude-sonnet-4-6" },
      ],
      null,
    );
    const selection = resolveModelSelection(ambiguousCatalog, "anthropic/claude-sonnet");
    expect(selection.kind).toBe("ambiguous");
    if (selection.kind === "ambiguous") {
      expect(selection.candidates.map((c) => c.id)).toEqual([
        "anthropic/claude-sonnet-4-5",
        "anthropic/claude-sonnet-4-6",
      ]);
    }
  });

  it("resolves a unique prefix of a bare model id", () => {
    const selection = resolveModelSelection(catalog, "gpt-6");
    expect(selection.kind).toBe("exact");
    if (selection.kind === "exact") {
      expect(selection.entry.id).toBe("openai-codex/gpt-6.1-sol");
    }
  });

  it("reports an ambiguous prefix of a bare model id", () => {
    const ambiguousCatalog = buildModelCatalog(
      [
        { provider: "openai", id: "gpt-5.1" },
        { provider: "azure", id: "gpt-5.2" },
      ],
      null,
    );
    const selection = resolveModelSelection(ambiguousCatalog, "gpt-5");
    expect(selection.kind).toBe("ambiguous");
    if (selection.kind === "ambiguous") {
      expect(selection.candidates).toHaveLength(2);
    }
  });

  it("reports an unknown model", () => {
    const selection = resolveModelSelection(catalog, "totally-unknown");
    expect(selection.kind).toBe("unknown");
    if (selection.kind === "unknown") {
      expect(selection.query).toBe("totally-unknown");
      expect(selection.suggestions).toHaveLength(0);
    }
  });

  it("suggests substring matches for an unknown model", () => {
    // "onnet" is a substring of a model id, but never a prefix of one.
    const selection = resolveModelSelection(catalog, "onnet");
    expect(selection.kind).toBe("unknown");
    if (selection.kind === "unknown") {
      expect(selection.suggestions.map((s) => s.id)).toEqual(["anthropic/claude-sonnet-4-5"]);
    }
  });

  it("caps the suggestions at five", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      provider: "prov",
      id: `model-claude-${index}`,
    }));
    const selection = resolveModelSelection(buildModelCatalog(many, null), "claude");
    expect(selection.kind).toBe("unknown");
    if (selection.kind === "unknown") {
      expect(selection.suggestions).toHaveLength(MODEL_CANDIDATE_LIMIT);
    }
  });

  it("caps the ambiguous candidates at five", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      provider: "prov",
      id: `gpt-${index}`,
    }));
    const selection = resolveModelSelection(buildModelCatalog(many, null), "gpt-");
    expect(selection.kind).toBe("ambiguous");
    if (selection.kind === "ambiguous") {
      expect(selection.candidates).toHaveLength(MODEL_CANDIDATE_LIMIT);
    }
  });

  it("resolves against the full list, never the truncated display list", () => {
    const truncated = buildModelCatalog(MODELS, null, 1);
    expect(truncated.visible).toHaveLength(1);
    const selection = resolveModelSelection(truncated, "anthropic/claude-sonnet-4-5");
    expect(selection.kind).toBe("exact");
  });

  it("treats an empty query as unknown", () => {
    const selection = resolveModelSelection(catalog, "   ");
    expect(selection.kind).toBe("unknown");
  });
});

// ─── Renderers ───────────────────────────────────────────────────────────────

describe("buildModelListEmbed", () => {
  it("marks the current model and states the total count", () => {
    const catalog = buildModelCatalog(MODELS, "anthropic/claude-sonnet-4-5");
    const embed = buildModelListEmbed(catalog);

    expect(embed.title).toBeTruthy();
    expect(embed.description).toContain("anthropic/claude-sonnet-4-5");
    expect(embed.description).toContain("4 models");
    expect(embed.fields).toHaveLength(4);
    expect(embed.fields!.some((f) => f.name.includes("✅") && f.name.includes("anthropic/claude-sonnet-4-5"))).toBe(true);
  });

  it("states the total count when the list is truncated", () => {
    const catalog = buildModelCatalog(MODELS, null, 2);
    const embed = buildModelListEmbed(catalog);
    expect(embed.description).toContain("4 models");
    expect(embed.description).toContain("showing 2");
    expect(embed.fields).toHaveLength(2);
  });

  it("renders an explicit no-models state", () => {
    const embed = buildModelListEmbed(buildModelCatalog([], null));
    expect(embed.description).toBeTruthy();
    expect(embed.description).toContain("No models available");
    expect(embed.fields).toHaveLength(0);
  });

  it("never exceeds the Discord embed limits", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      provider: "prov",
      id: `model-${index}`,
      name: `Model ${index}`,
    }));
    const embed = buildModelListEmbed(buildModelCatalog(many, null, 40));
    expect(embed.fields!.length).toBeLessThanOrEqual(EMBED_MAX_FIELDS);
    expect(embed.title!.length).toBeLessThanOrEqual(256);
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
  });
});

describe("formatModelListText", () => {
  it("lists the models with the current one marked", () => {
    const catalog = buildModelCatalog(MODELS, "openai/gpt-5.1");
    const text = formatModelListText(catalog);

    expect(text).toContain("Current model: openai/gpt-5.1 — GPT-5.1");
    expect(text).toContain("✅ openai/gpt-5.1 — GPT-5.1");
    expect(text).toContain("anthropic/claude-opus-4-1 — Claude Opus 4.1");
    expect(text).toContain("4 models available");
  });

  it("renders an explicit no-models state instead of an empty string", () => {
    const text = formatModelListText(buildModelCatalog([], null));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("No models available");
  });
});

// ─── Discord character budgets ──────────────────────────────────────────────

describe("Discord character budgets", () => {
  /** Models whose ids and names are long enough to blow the embed budget. */
  function makeLongModels(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      provider: `provider-${index}`,
      id: `model-${index}-${"x".repeat(120)}`,
      name: `Model ${index} ${"y".repeat(400)}`,
    }));
  }

  /** The aggregate size of an embed (title + description + fields). */
  function embedSize(embed: {
    title?: string;
    description?: string;
    fields?: { name: string; value: string }[];
  }): number {
    return (
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)
    );
  }

  it("keeps the embed within the aggregate budget", () => {
    const models = makeLongModels(25);
    const catalog = buildModelCatalog(models, null, 25);

    const embed = buildModelListEmbed(catalog);

    expect(embedSize(embed)).toBeLessThanOrEqual(EMBED_TOTAL_MAX);
    expect(embed.fields!.length).toBeGreaterThan(0);
    // The entries that do not fit are dropped.
    expect(embed.fields!.length).toBeLessThan(25);
  });

  it("still lists the current model when the list does not fit", () => {
    const models = makeLongModels(25);
    const currentId = `${models[0].provider}/${models[0].id}`;
    const catalog = buildModelCatalog(models, currentId, 25);

    const embed = buildModelListEmbed(catalog);

    expect(embedSize(embed)).toBeLessThanOrEqual(EMBED_TOTAL_MAX);
    expect(embed.description).toContain("Current model:");
    expect(embed.description).toContain(currentId.slice(0, 40));
    expect(embed.fields![0].name.startsWith("✅")).toBe(true);
    expect(embed.fields![0].name).toContain(currentId.slice(0, 40));
  });

  it("bounds the plain-text fallback to Discord's message limit", () => {
    const models = makeLongModels(25);
    const currentId = `${models[0].provider}/${models[0].id}`;
    const catalog = buildModelCatalog(models, currentId, 25);

    const text = formatModelListText(catalog);

    expect(text.length).toBeLessThanOrEqual(MESSAGE_MAX);
    // The current model stays visible, the rest is cut with a marker.
    expect(text).toContain("Current model:");
    expect(text).toContain(currentId.slice(0, 40));
    expect(text).toContain("more model");
  });

  it("falls back to the plain text when the embed cannot carry the list", () => {
    const models = makeLongModels(3);
    const catalog = buildModelCatalog(models, null, 0);

    const reply = buildModelListReply(catalog);

    expect(reply.embed).toBeUndefined();
    expect(reply.content).toBeTruthy();
    expect((reply.content ?? "").length).toBeLessThanOrEqual(MESSAGE_MAX);
  });

  it("uses the embed when the list fits", () => {
    const reply = buildModelListReply(buildModelCatalog(MODELS, null));

    expect(reply.embed).toBeDefined();
    expect(reply.content).toBeUndefined();
  });
});
