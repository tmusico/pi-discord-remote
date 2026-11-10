import { describe, it, expect } from "vitest";
import {
  buildStatusEmbed,
  buildStatusView,
  formatStatusText,
  EMBED_DESCRIPTION_MAX,
  EMBED_FIELD_VALUE_MAX,
  EMBED_MAX_FIELDS,
  type StatusState,
} from "../status.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FULL_STATE: StatusState = {
  state: "idle",
  modelId: "openai-codex/gpt-6.1-sol",
  modelName: "GPT-6.1 Sol",
  modelProvider: "openai-codex",
  thinkingLevel: "high",
  cwd: "/home/tony/code/personal/byow",
  gitBranch: "main",
  gitSha: "4bea19a",
  gitDirtyCount: 3,
  contextTokens: 42100,
  contextWindow: 200000,
  sessionId: "8f3c1a2b9d",
  sessionName: "may09",
  entryCount: 42,
  channelName: "byow-may09",
  channelId: "123456789012345678",
  botTag: "bot#1234",
  reconnectAttempts: 0,
  lastPromptAt: new Date(Date.now() - 12 * 60_000),
  runStartedAt: null,
  lastToolName: "bash",
  errorMessage: null,
};

/** Every rendered value of a view/embed — used for the "no JS artifacts" check. */
function renderedValues(view: ReturnType<typeof buildStatusView>): string[] {
  return [
    view.headline,
    view.hint ?? "",
    ...view.fields.map((field) => `${field.name}: ${field.value}`),
  ];
}

// ─── State headlines ─────────────────────────────────────────────────────────

describe("buildStatusView: state headlines", () => {
  it("renders the no_session headline plus a hint", () => {
    const view = buildStatusView({ state: "no_session" });
    expect(view.state).toBe("no_session");
    expect(view.headline).toBe("🟠 No Pi session connected");
    expect(view.hint).toBeTruthy();
    expect(view.hint).toContain("/pi-discord-remote start");
  });

  it("treats a missing state as no_session", () => {
    const view = buildStatusView({});
    expect(view.state).toBe("no_session");
    expect(view.headline).toBe("🟠 No Pi session connected");
  });

  it("renders the idle headline", () => {
    const view = buildStatusView({ state: "idle" });
    expect(view.state).toBe("idle");
    expect(view.headline).toBe("🟢 Idle — ready for instructions");
  });

  it("renders the working headline with the elapsed time", () => {
    const view = buildStatusView({
      state: "working",
      runStartedAt: new Date(Date.now() - 42_000),
    });
    expect(view.state).toBe("working");
    expect(view.headline).toBe("🔴 Working — 42s");
  });

  it("renders the working headline without a time when it is unknown", () => {
    const view = buildStatusView({ state: "working" });
    expect(view.headline).toBe("🔴 Working");
  });

  it("renders the waiting headline", () => {
    const view = buildStatusView({ state: "waiting" });
    expect(view.state).toBe("waiting");
    expect(view.headline).toBe("⏸ Waiting for your answer to a question");
  });

  it("prefers waiting over working (the caller resolves the priority)", () => {
    const view = buildStatusView({
      state: "waiting",
      runStartedAt: new Date(Date.now() - 42_000),
    });
    expect(view.headline).toBe("⏸ Waiting for your answer to a question");
    expect(view.headline).not.toContain("Working");
  });

  it("renders the error headline with the safe error label", () => {
    const view = buildStatusView({ state: "error", errorMessage: "turn failed" });
    expect(view.state).toBe("error");
    expect(view.headline).toBe("⚠️ Error — turn failed");
  });

  it("renders the aborted label", () => {
    const view = buildStatusView({ state: "error", errorMessage: "aborted" });
    expect(view.headline).toBe("⚠️ Error — aborted");
  });

  it("renders the error headline without a message", () => {
    const view = buildStatusView({ state: "error" });
    expect(view.headline).toBe("⚠️ Error");
  });

  it("gives every state an integer color", () => {
    const states = ["no_session", "idle", "working", "waiting", "error"] as const;
    for (const state of states) {
      const view = buildStatusView({ state });
      expect(Number.isInteger(view.color)).toBe(true);
      expect(view.color).toBeGreaterThan(0);
    }
  });
});

// ─── Fields ──────────────────────────────────────────────────────────────────

describe("buildStatusView: fields", () => {
  it("renders the documented fields in the documented order", () => {
    const view = buildStatusView(FULL_STATE);
    expect(view.fields.map((field) => field.name)).toEqual([
      "State",
      "Model",
      "Project",
      "Context",
      "Session",
      "Activity",
      "Discord",
    ]);
  });

  it("renders the model with the thinking level", () => {
    const view = buildStatusView(FULL_STATE);
    const model = view.fields.find((field) => field.name === "Model");
    expect(model?.value).toBe("openai-codex/gpt-6.1-sol · thinking: high");
  });

  it("falls back to the model name when there is no model id", () => {
    const view = buildStatusView({ state: "idle", modelName: "GPT-6.1 Sol" });
    const model = view.fields.find((field) => field.name === "Model");
    expect(model?.value).toBe("GPT-6.1 Sol");
  });

  it("renders the project with git information", () => {
    const view = buildStatusView(FULL_STATE);
    const project = view.fields.find((field) => field.name === "Project");
    expect(project?.value).toBe("byow · main @ 4bea19a (3 files dirty)");
  });

  it("renders the project as 'not a git repo' without git information", () => {
    const view = buildStatusView({ state: "idle", cwd: "/tmp/byow" });
    const project = view.fields.find((field) => field.name === "Project");
    expect(project?.value).toBe("byow · not a git repo");
  });

  it("renders the project as unknown without a cwd", () => {
    const view = buildStatusView({ state: "idle", gitBranch: "main", gitSha: "4bea19a" });
    const project = view.fields.find((field) => field.name === "Project");
    expect(project?.value).toBe("unknown · main @ 4bea19a");
  });

  it("renders the context usage with a percentage", () => {
    const view = buildStatusView(FULL_STATE);
    const context = view.fields.find((field) => field.name === "Context");
    expect(context?.value).toBe("42.1k / 200k tokens (21%)");
  });

  it("omits the percentage when the token count is unknown", () => {
    const view = buildStatusView({ state: "idle", contextWindow: 200000 });
    const context = view.fields.find((field) => field.name === "Context");
    expect(context?.value).toBe("unknown / 200k tokens");
    expect(context?.value).not.toContain("%");
  });

  it("renders the session id, name and entry count", () => {
    const view = buildStatusView(FULL_STATE);
    const session = view.fields.find((field) => field.name === "Session");
    expect(session?.value).toBe("8f3c1a2 · may09 · 42 entries");
  });

  it("renders the activity with relative times", () => {
    const view = buildStatusView(FULL_STATE);
    const activity = view.fields.find((field) => field.name === "Activity");
    expect(activity?.value).toContain("last prompt 12m ago");
    expect(activity?.value).toContain("last tool bash");
  });

  it("renders the discord connection information", () => {
    const view = buildStatusView(FULL_STATE);
    const discord = view.fields.find((field) => field.name === "Discord");
    expect(discord?.value).toBe("#byow-may09 · as bot#1234 · reconnect attempts 0");
  });

  it("skips fields whose values are all unknown", () => {
    const view = buildStatusView({ state: "idle" });
    expect(view.fields.map((field) => field.name)).toEqual(["State"]);
  });

  it("skips the model, context, session, activity and discord fields when missing", () => {
    const view = buildStatusView({ state: "idle", cwd: "/tmp/byow" });
    const names = view.fields.map((field) => field.name);
    expect(names).toEqual(["State", "Project"]);
    expect(names).not.toContain("Model");
    expect(names).not.toContain("Context");
    expect(names).not.toContain("Session");
    expect(names).not.toContain("Activity");
    expect(names).not.toContain("Discord");
  });

  it("never emits an empty field value", () => {
    const view = buildStatusView(FULL_STATE);
    for (const field of view.fields) {
      expect(field.value.trim().length).toBeGreaterThan(0);
    }
  });
});

// ─── No JS artifacts ─────────────────────────────────────────────────────────

describe("buildStatusView: never renders undefined/NaN/null", () => {
  it("handles an empty snapshot", () => {
    const view = buildStatusView({});
    for (const value of renderedValues(view)) {
      expect(value).not.toMatch(/undefined/);
      expect(value).not.toMatch(/NaN/);
      expect(value).not.toMatch(/null/);
    }
  });

  it("handles a fully populated snapshot", () => {
    const view = buildStatusView(FULL_STATE);
    for (const value of renderedValues(view)) {
      expect(value).not.toMatch(/undefined/);
      expect(value).not.toMatch(/NaN/);
      expect(value).not.toMatch(/null/);
    }
  });

  it("handles explicitly null fields", () => {
    const view = buildStatusView({
      state: "error",
      modelId: null,
      modelName: null,
      modelProvider: null,
      thinkingLevel: null,
      cwd: null,
      gitBranch: null,
      gitSha: null,
      gitDirtyCount: null,
      contextTokens: null,
      contextWindow: null,
      sessionId: null,
      sessionName: null,
      entryCount: null,
      channelName: null,
      channelId: null,
      botTag: null,
      reconnectAttempts: null,
      lastPromptAt: null,
      runStartedAt: null,
      lastToolName: null,
      errorMessage: null,
    });
    for (const value of renderedValues(view)) {
      expect(value).not.toMatch(/undefined/);
      expect(value).not.toMatch(/NaN/);
      expect(value).not.toMatch(/null/);
    }
  });

  it("handles NaN numbers", () => {
    const view = buildStatusView({
      state: "idle",
      contextTokens: Number.NaN,
      contextWindow: Number.NaN,
      gitDirtyCount: Number.NaN,
      entryCount: Number.NaN,
      reconnectAttempts: Number.NaN,
    });
    for (const value of renderedValues(view)) {
      expect(value).not.toMatch(/undefined/);
      expect(value).not.toMatch(/NaN/);
      expect(value).not.toMatch(/null/);
    }
    expect(view.fields.map((field) => field.name)).toEqual(["State"]);
  });

  it("replaces JS artifacts inside a supplied string", () => {
    const view = buildStatusView({ state: "error", errorMessage: "value is undefined" });
    expect(view.headline).not.toContain("undefined");
    expect(view.headline).toContain("unknown");
  });
});

// ─── Embed ───────────────────────────────────────────────────────────────────

describe("buildStatusEmbed", () => {
  it("returns a plain object with title, description, fields and color", () => {
    const embed = buildStatusEmbed(buildStatusView(FULL_STATE));
    expect(embed).toHaveProperty("title");
    expect(embed).toHaveProperty("description");
    expect(embed).toHaveProperty("fields");
    expect(embed).toHaveProperty("color");
    expect(typeof embed.title).toBe("string");
    expect(typeof embed.description).toBe("string");
    expect(Array.isArray(embed.fields)).toBe(true);
    expect(Number.isInteger(embed.color)).toBe(true);
  });

  it("contains the headline in the description", () => {
    const embed = buildStatusEmbed(buildStatusView(FULL_STATE));
    expect(embed.description).toContain("🟢 Idle — ready for instructions");
  });

  it("contains the hint in the description when there is no session", () => {
    const embed = buildStatusEmbed(buildStatusView({ state: "no_session" }));
    expect(embed.description).toContain("🟠 No Pi session connected");
    expect(embed.description).toContain("/pi-discord-remote start");
  });

  it("keeps every field inside Discord's limits", () => {
    const embed = buildStatusEmbed(buildStatusView(FULL_STATE));
    expect(embed.fields.length).toBeLessThanOrEqual(EMBED_MAX_FIELDS);
    expect(embed.description.length).toBeLessThanOrEqual(EMBED_DESCRIPTION_MAX);
    for (const field of embed.fields) {
      expect(field.value.length).toBeLessThanOrEqual(EMBED_FIELD_VALUE_MAX);
      expect(typeof field.inline).toBe("boolean");
    }
  });

  it("truncates long field values with an ellipsis", () => {
    const embed = buildStatusEmbed(
      buildStatusView({ state: "idle", sessionName: "x".repeat(4000) }),
    );
    const session = embed.fields.find((field) => field.name === "Session");
    expect(session?.value.length).toBe(EMBED_FIELD_VALUE_MAX);
    expect(session?.value.endsWith("…")).toBe(true);
  });

  it("truncates a long description with an ellipsis", () => {
    const embed = buildStatusEmbed(
      buildStatusView({ state: "error", errorMessage: "e".repeat(9000) }),
    );
    expect(embed.description.length).toBe(EMBED_DESCRIPTION_MAX);
    expect(embed.description.endsWith("…")).toBe(true);
  });

  it("never contains undefined/NaN/null in any rendered value", () => {
    const embed = buildStatusEmbed(buildStatusView({}));
    const values = [
      embed.title,
      embed.description,
      ...embed.fields.map((field) => `${field.name}: ${field.value}`),
    ];
    for (const value of values) {
      expect(value).not.toMatch(/undefined/);
      expect(value).not.toMatch(/NaN/);
      expect(value).not.toMatch(/null/);
    }
  });
});

// ─── Plain text ──────────────────────────────────────────────────────────────

describe("formatStatusText", () => {
  it("renders the headline and every field", () => {
    const text = formatStatusText(buildStatusView(FULL_STATE));
    expect(text).toContain("🟢 Idle — ready for instructions");
    expect(text).toContain("Model: openai-codex/gpt-6.1-sol · thinking: high");
    expect(text).toContain("Project: byow · main @ 4bea19a (3 files dirty)");
    expect(text).toContain("Context: 42.1k / 200k tokens (21%)");
    expect(text).toContain("Session: 8f3c1a2 · may09 · 42 entries");
    expect(text).toContain("Discord: #byow-may09 · as bot#1234 · reconnect attempts 0");
  });

  it("includes the hint when there is no session", () => {
    const text = formatStatusText(buildStatusView({ state: "no_session" }));
    expect(text).toContain("🟠 No Pi session connected");
    expect(text).toContain("/pi-discord-remote start");
  });

  it("never contains undefined/NaN/null", () => {
    const text = formatStatusText(buildStatusView({}));
    expect(text).not.toMatch(/undefined/);
    expect(text).not.toMatch(/NaN/);
    expect(text).not.toMatch(/null/);
  });
});

// ─── OptChat owner view ──────────────────────────────────────────────────────

describe("buildStatusView: OptChat field", () => {
  it("drops the field entirely when no OptChat owner is present", () => {
    const view = buildStatusView(FULL_STATE);
    expect(view.fields.map((field) => field.name)).not.toContain("OptChat");
  });

  it("renders profile, phase, tool and agent counts", () => {
    const view = buildStatusView({
      ...FULL_STATE,
      optchatProfile: "work",
      optchatPhase: "working",
      optchatTool: "bash",
      optchatToolCount: 3,
      optchatAgentsActive: 2,
      optchatAgentsTotal: 4,
    });
    const optchat = view.fields.find((field) => field.name === "OptChat");
    expect(optchat?.value).toBe("work · working · bash (+2) · 2/4 agents");
  });

  it("renders a single agent without a fraction", () => {
    const view = buildStatusView({
      ...FULL_STATE,
      optchatAgentsActive: 1,
      optchatAgentsTotal: 1,
    });
    const optchat = view.fields.find((field) => field.name === "OptChat");
    expect(optchat?.value).toBe("1 agent");
  });

  it("mentions the pending flag only when messages are queued", () => {
    const pending = buildStatusView({ ...FULL_STATE, optchatPending: true });
    expect(pending.fields.find((f) => f.name === "OptChat")?.value).toBe("pending");

    const notPending = buildStatusView({ ...FULL_STATE, optchatPending: false });
    expect(notPending.fields.find((f) => f.name === "OptChat")).toBeUndefined();
  });

  it("shows the tool without a count when only one tool is observed", () => {
    const view = buildStatusView({ ...FULL_STATE, optchatTool: "read", optchatToolCount: 1 });
    expect(view.fields.find((f) => f.name === "OptChat")?.value).toBe("read");
  });

  it("never renders undefined/NaN/null", () => {
    const view = buildStatusView({
      ...FULL_STATE,
      optchatProfile: null,
      optchatPhase: null,
      optchatTool: null,
      optchatToolCount: null,
      optchatPending: null,
      optchatAgentsActive: null,
      optchatAgentsTotal: null,
    });
    for (const value of renderedValues(view)) {
      expect(value).not.toMatch(/\bundefined\b|\bNaN\b|\bnull\b/);
    }
  });
});
