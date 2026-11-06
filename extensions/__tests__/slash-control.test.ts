import { describe, it, expect, vi } from "vitest";
import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";

import {
  PI_ABORT_COMMAND,
  PI_ABORT_COMMAND_NAME,
  PI_MODEL_COMMAND,
  PI_MODEL_COMMAND_NAME,
  PI_MODEL_AUTOCOMPLETE_MAX,
  PI_STATUS_COMMAND,
  PI_STATUS_REFUSAL,
  REGISTRATION_FAILED_CODE,
  handlePiAbortInteraction,
  handlePiModelAutocomplete,
  handlePiModelInteraction,
  registerPiCommands,
  registerPiStatusCommand,
  type PiAutocompleteChoice,
  type PiModelAutocompleteInteraction,
  type PiStatusClient,
  type PiStatusCommandEntry,
  type PiStatusInteraction,
} from "../slash.js";
import { MODEL_SCOPE_NOTE_UNAVAILABLE, type ModelLike } from "../model-control.js";

// ─── Fakes (no network, no real Discord client) ──────────────────────────────

const SECRET_TOKEN = "super-secret-bot-token";
const SECRET_PROMPT = "SYSTEM PROMPT: you are a helpful agent";

interface FakeCalls {
  fetch: { guildId: string }[];
  create: { body: unknown; guildId: string }[];
  edit: { id: string; body: unknown; guildId: string }[];
  set: unknown[][];
}

function makeFakeClient(options: {
  existing?: PiStatusCommandEntry[];
  failWith?: unknown;
  failCreateWith?: unknown;
  appId?: string | null;
} = {}) {
  const calls: FakeCalls = { fetch: [], create: [], edit: [], set: [] };

  const commands = {
    async fetch(fetchOptions: { guildId: string }) {
      calls.fetch.push(fetchOptions);
      if (options.failWith) throw options.failWith;
      return options.existing ?? [];
    },
    async create(body: unknown, guildId: string) {
      calls.create.push({ body, guildId });
      if (options.failCreateWith) throw options.failCreateWith;
      return { id: `created-${calls.create.length}`, name: "created" };
    },
    async edit(id: string, body: unknown, guildId: string) {
      calls.edit.push({ id, body, guildId });
      return { id, name: "edited" };
    },
    // A bulk replace would delete every other command of this application —
    // it must never be called.
    async set(commandsToSet: unknown[]) {
      calls.set.push(commandsToSet);
      return [];
    },
  };

  const client: PiStatusClient = {
    application: {
      id: options.appId === undefined ? "app-123456789" : options.appId,
      commands,
    },
    user: { id: "bot-987654321" },
  };

  return { client, calls };
}

function makeFakeInteraction(userId = "user-1", optionValue: string | null = null) {
  const calls: string[] = [];
  const replies: unknown[] = [];
  const edits: unknown[] = [];
  const defers: unknown[] = [];

  const interaction: PiStatusInteraction = {
    user: { id: userId },
    options: {
      getString(name: string) {
        return name === "model" ? optionValue : null;
      },
    },
    async deferReply(deferOptions) {
      calls.push("deferReply");
      defers.push(deferOptions);
    },
    async editReply(editOptions) {
      calls.push("editReply");
      edits.push(editOptions);
    },
    async reply(replyOptions) {
      calls.push("reply");
      replies.push(replyOptions);
    },
  };

  return { interaction, calls, replies, edits, defers };
}

function makeFakeAutocomplete(userId = "user-1", focused = "") {
  const responses: PiAutocompleteChoice[][] = [];

  const interaction: PiModelAutocompleteInteraction = {
    user: { id: userId },
    options: {
      getString: () => focused,
      getFocused: () => focused,
    },
    async respond(choices) {
      responses.push(choices);
    },
  };

  return { interaction, responses };
}

const MODELS: ModelLike[] = [
  { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
];

// ─── Command definitions ─────────────────────────────────────────────────────

describe("PI_ABORT_COMMAND", () => {
  it("is a chat-input command named pi-abort", () => {
    expect(PI_ABORT_COMMAND.name).toBe("pi-abort");
    expect(PI_ABORT_COMMAND.name).toBe(PI_ABORT_COMMAND_NAME);
    expect(PI_ABORT_COMMAND.type).toBe(1);
  });

  it("has a one-line description of at most 100 characters", () => {
    expect(PI_ABORT_COMMAND.description.length).toBeLessThanOrEqual(100);
    expect(PI_ABORT_COMMAND.description).not.toContain("\n");
  });

  it("has no options", () => {
    expect("options" in PI_ABORT_COMMAND).toBe(false);
  });
});

describe("PI_MODEL_COMMAND", () => {
  it("is a chat-input command named pi-model", () => {
    expect(PI_MODEL_COMMAND.name).toBe("pi-model");
    expect(PI_MODEL_COMMAND.name).toBe(PI_MODEL_COMMAND_NAME);
    expect(PI_MODEL_COMMAND.type).toBe(1);
  });

  it("has a one-line description of at most 100 characters", () => {
    expect(PI_MODEL_COMMAND.description.length).toBeLessThanOrEqual(100);
    expect(PI_MODEL_COMMAND.description).not.toContain("\n");
  });

  it("has one optional, autocompleted string option", () => {
    expect(PI_MODEL_COMMAND.options).toHaveLength(1);
    const option = PI_MODEL_COMMAND.options[0];
    expect(option.name).toBe("model");
    expect(option.type).toBe(3);
    expect(option.required).toBe(false);
    expect(option.autocomplete).toBe(true);
    expect(option.description.length).toBeLessThanOrEqual(100);
  });
});

// ─── Registration ────────────────────────────────────────────────────────────

describe("registerPiCommands", () => {
  it("edits the existing command and creates the missing ones", async () => {
    const { client, calls } = makeFakeClient({
      existing: [
        { id: "cmd-status", name: "pi-status" },
        { id: "cmd-foreign", name: "some-other-bot-command" },
      ],
    });

    const result = await registerPiCommands(client, SECRET_TOKEN, "guild-1", [
      PI_STATUS_COMMAND,
      PI_ABORT_COMMAND,
      PI_MODEL_COMMAND,
    ]);

    expect(result.ok).toBe(true);
    // The guild's commands are fetched exactly once.
    expect(calls.fetch).toHaveLength(1);
    expect(calls.fetch[0]).toEqual({ guildId: "guild-1" });

    // The existing command is edited in place.
    expect(calls.edit).toHaveLength(1);
    expect(calls.edit[0].id).toBe("cmd-status");
    expect(calls.edit[0].body).toMatchObject({ name: "pi-status", type: 1 });

    // The two missing commands are created.
    expect(calls.create).toHaveLength(2);
    expect(calls.create.map((call) => (call.body as { name: string }).name)).toEqual([
      "pi-abort",
      "pi-model",
    ]);
    expect(calls.create[1].body).toMatchObject({
      name: "pi-model",
      type: 1,
      options: [{ name: "model", type: 3, required: false, autocomplete: true }],
    });
  });

  it("never bulk-replaces the guild command set", async () => {
    const { client, calls } = makeFakeClient({ existing: [{ id: "cmd-status", name: "pi-status" }] });
    await registerPiCommands(client, SECRET_TOKEN, "guild-1", [
      PI_STATUS_COMMAND,
      PI_ABORT_COMMAND,
      PI_MODEL_COMMAND,
    ]);
    expect(calls.set).toHaveLength(0);
  });

  it("never touches a foreign guild command", async () => {
    const { client, calls } = makeFakeClient({
      existing: [
        { id: "cmd-foreign", name: "some-other-bot-command" },
        { id: "cmd-other", name: "pi-status" },
      ],
    });

    await registerPiCommands(client, SECRET_TOKEN, "guild-1", [
      PI_STATUS_COMMAND,
      PI_ABORT_COMMAND,
      PI_MODEL_COMMAND,
    ]);

    const touchedIds = [...calls.edit.map((call) => call.id), ...calls.create.map(() => "new")];
    expect(touchedIds).not.toContain("cmd-foreign");
    expect(calls.edit.map((call) => call.id)).toEqual(["cmd-other"]);
    expect(calls.create).toHaveLength(2);
  });

  it("reports one outcome per command", async () => {
    const { client } = makeFakeClient({ existing: [{ id: "cmd-status", name: "pi-status" }] });
    const result = await registerPiCommands(client, SECRET_TOKEN, "guild-1", [
      PI_STATUS_COMMAND,
      PI_ABORT_COMMAND,
      PI_MODEL_COMMAND,
    ]);

    expect(result.outcomes.map((outcome) => outcome.name)).toEqual([
      "pi-status",
      "pi-abort",
      "pi-model",
    ]);
    expect(result.outcomes.every((outcome) => outcome.ok)).toBe(true);
  });

  it("keeps registering the other commands when one of them fails", async () => {
    const { client, calls } = makeFakeClient({
      existing: [{ id: "cmd-status", name: "pi-status" }],
      failCreateWith: new Error("network down"),
    });

    const result = await registerPiCommands(client, SECRET_TOKEN, "guild-1", [
      PI_STATUS_COMMAND,
      PI_ABORT_COMMAND,
      PI_MODEL_COMMAND,
    ]);

    expect(result.ok).toBe(false);
    // The failure is reported as a fixed, leak-free code — the raw error
    // message never leaves the module.
    expect(result.error).toBe(REGISTRATION_FAILED_CODE);
    expect(result.error).not.toContain("network down");
    expect(result.outcomes.find((outcome) => outcome.name === "pi-abort")?.ok).toBe(false);
    expect(result.outcomes.find((outcome) => outcome.name === "pi-model")?.ok).toBe(false);
    // pi-status was edited before the failures happened.
    expect(calls.edit).toHaveLength(1);
    expect(calls.set).toHaveLength(0);
  });

  it("returns the missing-scope hint", async () => {
    const scopeError = Object.assign(new Error("Missing Access"), { status: 403, code: 50013 });
    const { client } = makeFakeClient({ failWith: scopeError });

    const result = await registerPiCommands(client, SECRET_TOKEN, "guild-1", [
      PI_STATUS_COMMAND,
      PI_ABORT_COMMAND,
      PI_MODEL_COMMAND,
    ]);

    expect(result.ok).toBe(false);
    expect(result.hint).toContain("applications.commands");
    expect(result.hint).toContain("client_id=app-123456789");
    expect(result.hint).toContain("scope=bot%20applications.commands");
    expect(result.hint).not.toContain("\n");
  });

  it("never leaks the bot token in the failure result", async () => {
    const { client } = makeFakeClient({
      failWith: new Error(`request failed with token ${SECRET_TOKEN}`),
    });
    const result = await registerPiCommands(client, SECRET_TOKEN, "guild-1", [
      PI_STATUS_COMMAND,
      PI_ABORT_COMMAND,
      PI_MODEL_COMMAND,
    ]);

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(SECRET_TOKEN);
    expect(result.hint).toBeUndefined();
  });

  it("keeps registerPiStatusCommand working as a thin wrapper", async () => {
    const { client, calls } = makeFakeClient({ existing: [{ id: "cmd-status", name: "pi-status" }] });
    const result = await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");

    expect(result.ok).toBe(true);
    expect(calls.fetch).toHaveLength(1);
    expect(calls.edit).toHaveLength(1);
    expect(calls.edit[0].id).toBe("cmd-status");
    expect(calls.create).toHaveLength(0);
    expect(calls.set).toHaveLength(0);
  });
});

// ─── Allow-list gate ─────────────────────────────────────────────────────────

describe("allow-list", () => {
  it("refuses /pi-abort for users outside the allow-list", async () => {
    const { interaction, calls, replies, edits, defers } = makeFakeInteraction("intruder");
    const result = await handlePiAbortInteraction(interaction, {
      allowedUserIds: ["user-1"],
      abortRun: () => ({ kind: "aborted" }),
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["reply"]);
    expect(defers).toHaveLength(0);
    expect(edits).toHaveLength(0);

    const reply = replies[0] as { content?: string; ephemeral?: boolean };
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toBe(PI_STATUS_REFUSAL);
  });

  it("refuses /pi-model for users outside the allow-list", async () => {
    const { interaction, calls, replies, edits, defers } = makeFakeInteraction("intruder");
    const result = await handlePiModelInteraction(interaction, {
      allowedUserIds: ["user-1"],
      listModels: () => MODELS,
      currentModelId: () => null,
      switchModel: () => ({ kind: "failed" }),
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["reply"]);
    expect(defers).toHaveLength(0);
    expect(edits).toHaveLength(0);

    const reply = replies[0] as { content?: string; ephemeral?: boolean };
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toBe(PI_STATUS_REFUSAL);
  });

  it("allows everyone when the allow-list is empty or missing", async () => {
    for (const allowedUserIds of [[], undefined]) {
      const { interaction, calls } = makeFakeInteraction("anyone");
      const result = await handlePiAbortInteraction(interaction, {
        allowedUserIds,
        abortRun: () => ({ kind: "idle" }),
      });
      expect(result.ok).toBe(true);
      expect(calls).toEqual(["deferReply", "editReply"]);
    }
  });
});

// ─── /pi-abort ───────────────────────────────────────────────────────────────

describe("handlePiAbortInteraction", () => {
  it("reports an aborted run", async () => {
    const { interaction, calls, defers, edits } = makeFakeInteraction("user-1");
    const result = await handlePiAbortInteraction(interaction, {
      abortRun: () => ({ kind: "aborted" }),
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["deferReply", "editReply"]);
    expect(defers[0]).toEqual({ ephemeral: true });
    const edit = edits[0] as { content?: string };
    expect(edit.content).toBe("🛑 Aborted the current run. The session is still connected.");
  });

  it("reports an idle session", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1");
    await handlePiAbortInteraction(interaction, { abortRun: () => ({ kind: "idle" }) });
    const edit = edits[0] as { content?: string };
    expect(edit.content).toBe("Nothing is running — there is nothing to abort.");
  });

  it("reports a missing session", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1");
    await handlePiAbortInteraction(interaction, { abortRun: () => ({ kind: "no_session" }) });
    const edit = edits[0] as { content?: string };
    expect(edit.content).toBe("No Pi session is connected.");
  });

  it("reports an unavailable session", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1");
    await handlePiAbortInteraction(interaction, { abortRun: () => ({ kind: "unsupported" }) });
    const edit = edits[0] as { content?: string };
    expect(edit.content).toBe("⚠️ The session is not available right now.");
  });

  it("awaits an asynchronous abort provider", async () => {
    const { interaction, calls, edits } = makeFakeInteraction("user-1");
    await handlePiAbortInteraction(interaction, {
      abortRun: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { kind: "aborted" };
      },
    });
    expect(calls).toEqual(["deferReply", "editReply"]);
    const edit = edits[0] as { content?: string };
    expect(edit.content).toContain("Aborted the current run");
  });

  it("stays ephemeral and leaks nothing when the abort fails", async () => {
    const { interaction, calls, defers, edits } = makeFakeInteraction("user-1");
    const result = await handlePiAbortInteraction(interaction, {
      abortRun: () => {
        throw new Error(`${SECRET_PROMPT} ${SECRET_TOKEN}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["deferReply", "editReply"]);
    expect(defers[0]).toEqual({ ephemeral: true });

    const edit = edits[0] as { content?: string };
    expect(edit.content).toBeTruthy();
    expect(edit.content).not.toContain(SECRET_PROMPT);
    expect(edit.content).not.toContain(SECRET_TOKEN);
    expect(edit.content).not.toContain("at ");
    expect(result.error).not.toContain(SECRET_TOKEN);
  });

  it("never logs a secret carried by the error's name", async () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    try {
      const err = new Error("boom");
      // `name` is a writable property — it may carry any text.
      err.name = SECRET_TOKEN;

      const { interaction } = makeFakeInteraction("user-1");
      await handlePiAbortInteraction(interaction, {
        abortRun: () => {
          throw err;
        },
      });

      expect(JSON.stringify(logged)).not.toContain(SECRET_TOKEN);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── /pi-model ───────────────────────────────────────────────────────────────

describe("handlePiModelInteraction", () => {
  const deps = {
    listModels: () => MODELS,
    currentModelId: () => "openai-codex/gpt-6.1-sol",
    switchModel: () => ({ kind: "failed" }) as const,
  };

  it("lists the models when no argument is given", async () => {
    const { interaction, calls, defers, edits } = makeFakeInteraction("user-1", null);
    const result = await handlePiModelInteraction(interaction, deps);

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["deferReply", "editReply"]);
    expect(defers[0]).toEqual({ ephemeral: true });

    const edit = edits[0] as { embeds?: { title?: string; fields?: { name: string; value: string }[] }[] };
    expect(edit.embeds).toHaveLength(1);
    expect(edit.embeds?.[0]?.title).toBeTruthy();
    const fields = edit.embeds?.[0]?.fields ?? [];
    expect(fields.some((field) => field.name.includes("openai-codex/gpt-6.1-sol"))).toBe(true);
    expect(fields.some((field) => field.value.includes("Claude Sonnet 4.5"))).toBe(true);
  });

  it("renders the explicit no-models state when the session has no models", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1", null);
    await handlePiModelInteraction(interaction, {
      ...deps,
      listModels: () => [],
    });

    const edit = edits[0] as { content?: string; embeds?: unknown[] };
    expect(edit.embeds).toBeUndefined();
    expect(edit.content).toContain("No models available");
  });

  it("switches to an exact qualified id", async () => {
    const switched: string[] = [];
    const { interaction, edits } = makeFakeInteraction("user-1", "anthropic/claude-sonnet-4-5");
    const result = await handlePiModelInteraction(interaction, {
      ...deps,
      switchModel: (id: string) => {
        switched.push(id);
        return {
          kind: "switched" as const,
          model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(switched).toEqual(["anthropic/claude-sonnet-4-5"]);
    const edit = edits[0] as { content?: string };
    expect(edit.content).toBe(
      "✅ Model switched to anthropic/claude-sonnet-4-5 — Claude Sonnet 4.5 (this session)",
    );
  });

  it("switches to an unambiguous bare model id", async () => {
    const switched: string[] = [];
    const { interaction, edits } = makeFakeInteraction("user-1", "claude-sonnet-4-5");
    await handlePiModelInteraction(interaction, {
      ...deps,
      switchModel: (id: string) => {
        switched.push(id);
        return {
          kind: "switched" as const,
          model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        };
      },
    });

    expect(switched).toEqual(["anthropic/claude-sonnet-4-5"]);
    const edit = edits[0] as { content?: string };
    expect(edit.content).toContain("✅ Model switched to anthropic/claude-sonnet-4-5");
  });

  it("never switches a model for an unknown input", async () => {
    let called = false;
    const { interaction, edits } = makeFakeInteraction("user-1", "no-such-model");
    const result = await handlePiModelInteraction(interaction, {
      ...deps,
      switchModel: () => {
        called = true;
        return { kind: "failed" } as const;
      },
    });

    expect(result.ok).toBe(true);
    expect(called).toBe(false);
    const edit = edits[0] as { content?: string };
    expect(edit.content).toContain("Unknown model");
    // The typed id is never echoed back.
    expect(edit.content).not.toContain("no-such-model");
    // The reply explains what to do next.
    expect(edit.content).toContain("provider/model-id");
  });

  it("never switches a model for an ambiguous input", async () => {
    let called = false;
    const { interaction, edits } = makeFakeInteraction("user-1", "gpt-5.1");
    const result = await handlePiModelInteraction(interaction, {
      ...deps,
      listModels: () => [
        { provider: "openai", id: "gpt-5.1", name: "GPT-5.1" },
        { provider: "azure", id: "gpt-5.1", name: "GPT-5.1 (Azure)" },
      ],
      switchModel: () => {
        called = true;
        return { kind: "failed" } as const;
      },
    });

    expect(result.ok).toBe(true);
    expect(called).toBe(false);
    const edit = edits[0] as { content?: string };
    expect(edit.content).toContain("matches several models");
    expect(edit.content).toContain("openai/gpt-5.1");
    expect(edit.content).toContain("azure/gpt-5.1");
    expect(edit.content).toContain("provider/model-id");
    // The typed id is never echoed back.
    expect(edit.content).not.toContain('"gpt-5.1"');
  });

  it("never echoes the typed id — it could carry a secret", async () => {
    const unknown = makeFakeInteraction("user-1", `no-such-model ${SECRET_TOKEN}`);
    await handlePiModelInteraction(unknown.interaction, {
      ...deps,
      switchModel: () => ({ kind: "failed" }) as const,
    });

    const unknownEdit = unknown.edits[0] as { content?: string };
    expect(unknownEdit.content).not.toContain(SECRET_TOKEN);
    expect(unknownEdit.content).toContain("Unknown model");
  });

  it("never echoes the typed id of an ambiguous selection", async () => {
    const ambiguous = makeFakeInteraction("user-1", "gpt-5.1");
    await handlePiModelInteraction(ambiguous.interaction, {
      ...deps,
      listModels: () => [
        { provider: "openai", id: "gpt-5.1", name: "GPT-5.1" },
        { provider: "azure", id: "gpt-5.1", name: "GPT-5.1 (Azure)" },
      ],
      switchModel: () => ({ kind: "failed" }) as const,
    });

    const ambiguousEdit = ambiguous.edits[0] as { content?: string };
    expect(ambiguousEdit.content).toContain("matches several models");
    // The candidates are canonical ids — the typed id is not quoted back.
    expect(ambiguousEdit.content).not.toContain('"gpt-5.1"');
  });

  it("keeps an over-long typed id within Discord's message limit", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1", "x".repeat(5000));
    const result = await handlePiModelInteraction(interaction, {
      ...deps,
      switchModel: () => ({ kind: "failed" }) as const,
    });

    expect(result.ok).toBe(true);
    const edit = edits[0] as { content?: string };
    expect(edit.content?.length ?? 0).toBeLessThanOrEqual(2000);
  });

  it("answers with no session connected in hub mode", async () => {
    let called = false;
    const { interaction, edits } = makeFakeInteraction("user-1", null);
    const result = await handlePiModelInteraction(interaction, {
      ...deps,
      hasSession: () => false,
      switchModel: () => {
        called = true;
        return { kind: "failed" } as const;
      },
    });

    expect(result.ok).toBe(true);
    expect(called).toBe(false);
    const edit = edits[0] as { content?: string };
    expect(edit.content).toBe("No Pi session is connected.");
  });

  it("reports a missing API key", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1", "anthropic/claude-sonnet-4-5");
    await handlePiModelInteraction(interaction, {
      ...deps,
      switchModel: () => ({ kind: "no_auth" as const, modelId: "anthropic/claude-sonnet-4-5" }),
    });

    const edit = edits[0] as { content?: string };
    expect(edit.content).toBe(
      "⚠️ No API key configured for provider 'anthropic' — the model was not switched.",
    );
  });

  it("keeps an over-long provider name within Discord's message limit", async () => {
    const longProvider = "p".repeat(2100);
    const { interaction, edits } = makeFakeInteraction("user-1", "m");
    const result = await handlePiModelInteraction(interaction, {
      ...deps,
      listModels: () => [{ provider: longProvider, id: "m", name: "M" }],
      switchModel: () => ({ kind: "no_auth" as const, modelId: "m" }),
    });

    expect(result.ok).toBe(true);
    const edit = edits[0] as { content?: string };
    expect(edit.content?.length ?? 0).toBeLessThanOrEqual(2000);
  });

  it("reports a failed switch", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1", "anthropic/claude-sonnet-4-5");
    await handlePiModelInteraction(interaction, {
      ...deps,
      switchModel: () => ({ kind: "failed" as const }),
    });

    const edit = edits[0] as { content?: string };
    expect(edit.content).toBe("⚠️ Could not switch the model.");
  });

  it("reports a missing session", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1", "anthropic/claude-sonnet-4-5");
    await handlePiModelInteraction(interaction, {
      ...deps,
      switchModel: () => ({ kind: "no_session" as const }),
    });

    const edit = edits[0] as { content?: string };
    expect(edit.content).toBe("No Pi session is connected.");
  });

  it("keeps the reply within Discord's embed budget", async () => {
    const models = Array.from({ length: 25 }, (_, index) => ({
      provider: `provider-${index}`,
      id: `model-${index}-${"x".repeat(120)}`,
      name: `Model ${index} ${"y".repeat(400)}`,
    }));
    const currentId = `${models[0].provider}/${models[0].id}`;
    const { interaction, edits } = makeFakeInteraction("user-1", null);

    await handlePiModelInteraction(interaction, {
      listModels: () => models,
      currentModelId: () => currentId,
      switchModel: () => ({ kind: "failed" }),
    });

    const edit = edits[0] as {
      content?: string;
      embeds?: { title?: string; description?: string; fields?: { name: string; value: string }[] }[];
    };
    const embed = edit.embeds?.[0];
    expect(embed).toBeDefined();
    const aggregate =
      (embed?.title?.length ?? 0) +
      (embed?.description?.length ?? 0) +
      (embed?.fields ?? []).reduce(
        (sum, field) => sum + field.name.length + field.value.length,
        0,
      );
    expect(aggregate).toBeLessThanOrEqual(6000);
    // The current model is still listed.
    expect(embed?.description).toContain("Current model:");
    expect(embed?.fields?.[0]?.name.startsWith("✅")).toBe(true);
  });

  it("stays ephemeral and leaks nothing when the model list fails", async () => {
    const { interaction, calls, defers, edits } = makeFakeInteraction("user-1", null);
    const result = await handlePiModelInteraction(interaction, {
      ...deps,
      listModels: () => {
        throw new Error(`${SECRET_PROMPT} ${SECRET_TOKEN}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["deferReply", "editReply"]);
    expect(defers[0]).toEqual({ ephemeral: true });

    const edit = edits[0] as { content?: string };
    expect(edit.content).toBeTruthy();
    expect(edit.content).not.toContain(SECRET_PROMPT);
    expect(edit.content).not.toContain(SECRET_TOKEN);
    expect(result.error).not.toContain(SECRET_TOKEN);
  });
});

// ─── /pi-model autocomplete ──────────────────────────────────────────────────

describe("handlePiModelAutocomplete", () => {
  it("filters the candidates by the typed text", async () => {
    const { interaction, responses } = makeFakeAutocomplete("user-1", "claude");
    const result = await handlePiModelAutocomplete(interaction, {
      listModels: () => MODELS,
    });

    expect(result.ok).toBe(true);
    expect(responses).toHaveLength(1);
    expect(responses[0].map((choice) => choice.value)).toEqual(["anthropic/claude-sonnet-4-5"]);
    expect(responses[0][0].name).toContain("Claude Sonnet 4.5");
  });

  it("answers with the qualified ids", async () => {
    const { interaction, responses } = makeFakeAutocomplete("user-1", "");
    await handlePiModelAutocomplete(interaction, { listModels: () => MODELS });

    expect(responses[0].map((choice) => choice.value)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai-codex/gpt-6.1-sol",
    ]);
  });

  it("caps the choices at 25", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      provider: "prov",
      id: `model-${index}`,
    }));
    const { interaction, responses } = makeFakeAutocomplete("user-1", "");
    const result = await handlePiModelAutocomplete(interaction, { listModels: () => many });

    expect(responses[0]).toHaveLength(PI_MODEL_AUTOCOMPLETE_MAX);
    expect(responses[0].length).toBeLessThanOrEqual(25);
    expect(result.choices).toBe(25);
  });

  it("never throws when the model list fails", async () => {
    const { interaction, responses } = makeFakeAutocomplete("user-1", "claude");
    const result = await handlePiModelAutocomplete(interaction, {
      listModels: () => {
        throw new Error(`${SECRET_PROMPT} ${SECRET_TOKEN}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toHaveLength(0);
  });

  it("answers with nothing for users outside the allow-list", async () => {
    const { interaction, responses } = makeFakeAutocomplete("intruder", "claude");
    await handlePiModelAutocomplete(interaction, {
      allowedUserIds: ["user-1"],
      listModels: () => MODELS,
    });

    expect(responses[0]).toHaveLength(0);
  });

  it("answers with nothing in hub mode", async () => {
    const { interaction, responses } = makeFakeAutocomplete("user-1", "claude");
    await handlePiModelAutocomplete(interaction, {
      listModels: () => MODELS,
      hasSession: () => false,
    });

    expect(responses[0]).toHaveLength(0);
  });

  it("never offers a truncated model id", async () => {
    // Discord's choice value is limited to 100 characters. A longer id would
    // be cut into a value that could never resolve to a model.
    const longId = "p".repeat(120);
    const { interaction, responses } = makeFakeAutocomplete("user-1", "");
    await handlePiModelAutocomplete(interaction, {
      listModels: () => [
        { provider: "prov", id: longId },
        { provider: "prov", id: "short-model" },
      ],
    });

    const values = responses[0].map((choice) => choice.value);
    expect(values).toEqual(["prov/short-model"]);
    for (const value of values) {
      expect(value.length).toBeLessThanOrEqual(100);
    }
  });
});

// ─── Secret hygiene in the registration path ────────────────────────────────

describe("registration secret hygiene", () => {
  it("never logs or returns a secret carried by the registration error", async () => {
    const secretError = Object.assign(new Error(`failed with token ${SECRET_TOKEN}`), {
      body: JSON.stringify({ prompt: SECRET_PROMPT }),
    });
    const { client } = makeFakeClient({ failWith: secretError });

    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    try {
      const result = await registerPiCommands(client, SECRET_TOKEN, "guild-1", [
        PI_STATUS_COMMAND,
        PI_ABORT_COMMAND,
        PI_MODEL_COMMAND,
      ]);

      // The failure is reported as a fixed, leak-free code.
      expect(result.ok).toBe(false);
      expect(result.error).toBe(REGISTRATION_FAILED_CODE);
      expect(result.error).not.toContain(SECRET_TOKEN);
      expect(result.error).not.toContain(SECRET_PROMPT);

      // The hint may only carry the application id.
      expect(result.hint ?? "").not.toContain(SECRET_TOKEN);
      expect(result.hint ?? "").not.toContain(SECRET_PROMPT);

      // Nothing that was logged may carry a secret.
      for (const args of logged) {
        const text = JSON.stringify(args);
        expect(text).not.toContain(SECRET_TOKEN);
        expect(text).not.toContain(SECRET_PROMPT);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("never leaks the secret of a per-command registration failure", async () => {
    const secretError = Object.assign(new Error(`boom ${SECRET_TOKEN}`), {
      body: { prompt: SECRET_PROMPT },
    });
    const { client } = makeFakeClient({ failCreateWith: secretError });

    const result = await registerPiCommands(client, SECRET_TOKEN, "guild-1", [
      PI_ABORT_COMMAND,
      PI_MODEL_COMMAND,
    ]);

    expect(result.ok).toBe(false);
    for (const outcome of result.outcomes) {
      expect(outcome.error).toBe(REGISTRATION_FAILED_CODE);
      expect(JSON.stringify(outcome)).not.toContain(SECRET_TOKEN);
      expect(JSON.stringify(outcome)).not.toContain(SECRET_PROMPT);
    }
  });
});

// ─── The scope note (older Pi without the scope API) ────────────────────────

describe("model scope note", () => {
  it("states that the list is not scope-filtered", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1", null);

    await handlePiModelInteraction(interaction, {
      listModels: () => MODELS,
      currentModelId: () => "openai-codex/gpt-6.1-sol",
      scopeNote: () => MODEL_SCOPE_NOTE_UNAVAILABLE,
      switchModel: () => ({ kind: "failed" }),
    });

    const edit = edits[0] as { embeds?: { description?: string }[] };
    expect(edit.embeds?.[0]?.description).toContain(MODEL_SCOPE_NOTE_UNAVAILABLE);
  });

  it("adds no note when the session has a scope", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1", null);

    await handlePiModelInteraction(interaction, {
      listModels: () => MODELS,
      currentModelId: () => "openai-codex/gpt-6.1-sol",
      switchModel: () => ({ kind: "failed" }),
    });

    const edit = edits[0] as { embeds?: { description?: string }[] };
    expect(edit.embeds?.[0]?.description).not.toContain(MODEL_SCOPE_NOTE_UNAVAILABLE);
  });
});


// ─── Type compatibility with the real discord.js client ──────────────────────

describe("discord.js compatibility (compile-time)", () => {
  it("accepts a real discord.js chat-input and autocomplete interaction", () => {
    const chatFits: ChatInputCommandInteraction extends PiStatusInteraction ? true : false = true;
    const autocompleteFits: AutocompleteInteraction extends PiModelAutocompleteInteraction
      ? true
      : false = true;

    expect(chatFits).toBe(true);
    expect(autocompleteFits).toBe(true);
  });
});

// ─── Security regression ─────────────────────────────────────────────────────

describe("secret hygiene", () => {
  it("never puts the bot token into a reply", async () => {
    const token = SECRET_TOKEN;

    const abortInteraction = makeFakeInteraction("user-1");
    await handlePiAbortInteraction(abortInteraction.interaction, {
      abortRun: () => {
        throw new Error(`failed with ${token}`);
      },
    });

    const modelInteraction = makeFakeInteraction("user-1", "claude");
    await handlePiModelInteraction(modelInteraction.interaction, {
      listModels: () => {
        throw new Error(`failed with ${token}`);
      },
      currentModelId: () => null,
      switchModel: () => ({ kind: "failed" }),
    });

    const refusedInteraction = makeFakeInteraction("intruder");
    await handlePiModelInteraction(refusedInteraction.interaction, {
      allowedUserIds: ["user-1"],
      listModels: () => MODELS,
      currentModelId: () => null,
      switchModel: () => ({ kind: "failed" }),
    });

    const replies = [
      ...abortInteraction.edits,
      ...abortInteraction.replies,
      ...modelInteraction.edits,
      ...modelInteraction.replies,
      ...refusedInteraction.replies,
    ];

    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) {
      expect(JSON.stringify(reply)).not.toContain(token);
      expect(JSON.stringify(reply)).not.toContain(SECRET_PROMPT);
    }
  });
});
