import { describe, it, expect } from "vitest";
import type { ChatInputCommandInteraction, Client } from "discord.js";

import {
  PI_STATUS_COMMAND,
  REGISTRATION_FAILED_CODE,
  buildPiStatusInviteUrl,
  handlePiStatusInteraction,
  isMissingCommandScopeError,
  registerPiStatusCommand,
  type PiStatusClient,
  type PiStatusCommandEntry,
  type PiStatusEmbedPayload,
  type PiStatusInteraction,
} from "../slash.js";
import type { StatusEmbed, StatusState } from "../status.js";

// ─── Fakes (no network, no real Discord client) ──────────────────────────────

interface FakeCalls {
  fetch: { guildId: string }[];
  create: { body: unknown; guildId: string }[];
  edit: { id: string; body: unknown; guildId: string }[];
  set: unknown[][];
}

function makeFakeClient(options: {
  existing?: PiStatusCommandEntry[];
  failWith?: unknown;
  appId?: string | null;
  userId?: string | null;
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
      return { id: "created-id", name: "pi-status" };
    },
    async edit(id: string, body: unknown, guildId: string) {
      calls.edit.push({ id, body, guildId });
      return { id, name: "pi-status" };
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
    user: options.userId === null ? undefined : { id: options.userId ?? "bot-987654321" },
  };

  return { client, calls };
}

function makeFakeInteraction(userId = "user-1") {
  const calls: string[] = [];
  const replies: unknown[] = [];
  const edits: unknown[] = [];
  const defers: unknown[] = [];

  const interaction: PiStatusInteraction = {
    user: { id: userId },
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

const SECRET_TOKEN = "super-secret-bot-token";
const SECRET_PROMPT = "SYSTEM PROMPT: you are a helpful agent";

const STATE: StatusState = {
  state: "idle",
  modelId: "openai-codex/gpt-6.1-sol",
  thinkingLevel: "high",
  cwd: "/home/tony/code/personal/byow",
  gitBranch: "main",
  gitSha: "4bea19a",
  gitDirtyCount: 3,
  contextTokens: 42100,
  contextWindow: 200000,
  sessionId: "8f3c1a2b9d",
  entryCount: 42,
  channelName: "byow-may09",
  botTag: "bot#1234",
  reconnectAttempts: 0,
};

// ─── Command definition ──────────────────────────────────────────────────────

describe("PI_STATUS_COMMAND", () => {
  it("is a chat-input command named pi-status", () => {
    expect(PI_STATUS_COMMAND.name).toBe("pi-status");
    expect(PI_STATUS_COMMAND.type).toBe(1);
  });

  it("has a one-line description of at most 100 characters", () => {
    expect(PI_STATUS_COMMAND.description.length).toBeLessThanOrEqual(100);
    expect(PI_STATUS_COMMAND.description).not.toContain("\n");
  });

  it("has no options", () => {
    expect("options" in PI_STATUS_COMMAND).toBe(false);
  });
});

// ─── Registration ────────────────────────────────────────────────────────────

describe("registerPiStatusCommand", () => {
  it("creates the command when it does not exist yet", async () => {
    const { client, calls } = makeFakeClient({ existing: [] });
    const result = await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");

    expect(result.ok).toBe(true);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].body).toMatchObject({
      name: "pi-status",
      type: 1,
    });
    expect(calls.edit).toHaveLength(0);
    expect(calls.set).toHaveLength(0);
  });

  it("edits the existing command instead of creating a second one", async () => {
    const { client, calls } = makeFakeClient({
      existing: [
        { id: "cmd-1", name: "other-command" },
        { id: "cmd-2", name: "pi-status" },
      ],
    });
    const result = await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");

    expect(result.ok).toBe(true);
    expect(calls.edit).toHaveLength(1);
    expect(calls.edit[0].id).toBe("cmd-2");
    expect(calls.edit[0].body).toMatchObject({ name: "pi-status", type: 1 });
    expect(calls.create).toHaveLength(0);
  });

  it("never bulk-replaces the guild command set", async () => {
    const { client, calls } = makeFakeClient({
      existing: [{ id: "cmd-1", name: "pi-status" }],
    });
    await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");
    expect(calls.set).toHaveLength(0);
  });

  it("leaves other commands of the same application alone", async () => {
    const { client, calls } = makeFakeClient({
      existing: [
        { id: "cmd-1", name: "other-command" },
        { id: "cmd-2", name: "pi-status" },
      ],
    });
    await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");

    const touchedIds = [...calls.edit.map((call) => call.id), ...calls.create.map(() => "new")];
    expect(touchedIds).toEqual(["cmd-2"]);
    expect(calls.set).toHaveLength(0);
  });

  it("is idempotent: a second run still edits, never creates", async () => {
    const { client, calls } = makeFakeClient({
      existing: [{ id: "cmd-2", name: "pi-status" }],
    });
    await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");
    await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");

    expect(calls.edit).toHaveLength(2);
    expect(calls.create).toHaveLength(0);
    expect(calls.set).toHaveLength(0);
  });

  it("finds the command inside a discord.js style [key, value] collection", async () => {
    const { client, calls } = makeFakeClient();
    const collection = new Map([["cmd-2", { id: "cmd-2", name: "pi-status" }]]);
    client.application!.commands.fetch = async () => collection;

    const result = await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");
    expect(result.ok).toBe(true);
    expect(calls.edit[0].id).toBe("cmd-2");
    expect(calls.create).toHaveLength(0);
  });

  it("returns a failure result when the application is not ready", async () => {
    const { client } = makeFakeClient();
    const notReady: PiStatusClient = { application: null, user: null };
    const result = await registerPiStatusCommand(notReady, SECRET_TOKEN, "guild-1");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(client).toBeDefined();
  });

  it("returns a failure result when the request fails", async () => {
    const { client, calls } = makeFakeClient({ failWith: new Error("network down") });
    const result = await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");

    expect(result.ok).toBe(false);
    // The failure is reported as a fixed, leak-free code — the raw error
    // message never leaves the module.
    expect(result.error).toBe(REGISTRATION_FAILED_CODE);
    expect(result.error).not.toContain("network down");
    expect(calls.set).toHaveLength(0);
  });

  it("detects the missing applications.commands scope and returns a re-invite hint", async () => {
    const scopeError = Object.assign(new Error("Missing Access"), {
      status: 403,
      code: 50013,
    });
    const { client } = makeFakeClient({ failWith: scopeError });
    const result = await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.hint).toBeTruthy();
    expect(result.hint).toContain("applications.commands");
    expect(result.hint).toContain("scope=bot%20applications.commands");
    expect(result.hint).toContain("client_id=app-123456789");
    expect(result.hint).toContain("permissions=274145945856");
  });

  it("keeps the hint on a single line", async () => {
    const scopeError = Object.assign(new Error("Missing Access"), { status: 403, code: 50013 });
    const { client } = makeFakeClient({ failWith: scopeError });
    const result = await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");
    expect(result.hint).not.toContain("\n");
  });

  it("keeps the <APP_ID> placeholder when no application id is known", async () => {
    const scopeError = Object.assign(new Error("Missing Access"), { status: 403, code: 50013 });
    const { client } = makeFakeClient({ failWith: scopeError, appId: null, userId: null });
    const result = await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");

    expect(result.hint).toContain("client_id=<APP_ID>");
  });

  it("never uses the bot user id as the OAuth client_id", async () => {
    const scopeError = Object.assign(new Error("Missing Access"), { status: 403, code: 50013 });
    const { client } = makeFakeClient({
      failWith: scopeError,
      appId: null,
      userId: "bot-987654321",
    });
    const result = await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");

    expect(result.hint).toContain("client_id=<APP_ID>");
    expect(result.hint).not.toContain("bot-987654321");
    expect(result.hint).toContain("Developer Portal");
  });

  it("never leaks the bot token in the failure result", async () => {
    const { client } = makeFakeClient({
      failWith: new Error(`request failed with token ${SECRET_TOKEN}`),
    });
    const result = await registerPiStatusCommand(client, SECRET_TOKEN, "guild-1");

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(SECRET_TOKEN);
  });

  it("recognizes the missing-scope failure shape", () => {
    expect(isMissingCommandScopeError(Object.assign(new Error("Missing Access"), { code: 50013 }))).toBe(true);
    expect(isMissingCommandScopeError(new Error("Missing Access"))).toBe(true);
    expect(isMissingCommandScopeError(new Error("network down"))).toBe(false);
  });

  it("recognizes a bare HTTP 403 as the missing-scope failure", () => {
    expect(isMissingCommandScopeError({ status: 403 })).toBe(true);
    expect(isMissingCommandScopeError({ status: 403, code: 50013 })).toBe(true);
  });

  it("builds the re-invite URL with the application id", () => {
    expect(buildPiStatusInviteUrl("app-1")).toBe(
      "https://discord.com/oauth2/authorize?client_id=app-1&scope=bot%20applications.commands&permissions=274145945856",
    );
  });
});

// ─── Interaction handler ─────────────────────────────────────────────────────

describe("handlePiStatusInteraction", () => {
  it("defers ephemerally and then edits with an embed", async () => {
    const { interaction, calls, defers, edits } = makeFakeInteraction("user-1");
    const result = await handlePiStatusInteraction(interaction, {
      allowedUserIds: ["user-1"],
      buildState: () => STATE,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["deferReply", "editReply"]);
    expect(defers[0]).toEqual({ ephemeral: true });

    const edit = edits[0] as { embeds?: { fields?: unknown[]; title?: string }[] };
    expect(Array.isArray(edit.embeds)).toBe(true);
    expect(edit.embeds?.[0]?.title).toBe("Pi Session Status");
    expect(Array.isArray(edit.embeds?.[0]?.fields)).toBe(true);
  });

  it("renders the live snapshot supplied by the caller", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1");
    await handlePiStatusInteraction(interaction, {
      buildState: () => STATE,
    });

    const edit = edits[0] as { embeds?: { description?: string; fields?: { name: string; value: string }[] }[] };
    expect(edit.embeds?.[0]?.description).toContain("Idle");
    const model = edit.embeds?.[0]?.fields?.find((field) => field.name === "Model");
    expect(model?.value).toContain("openai-codex/gpt-6.1-sol");
  });

  it("awaits an asynchronous snapshot provider (bounded git lookup)", async () => {
    const { interaction, calls, edits } = makeFakeInteraction("user-1");
    const result = await handlePiStatusInteraction(interaction, {
      buildState: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return STATE;
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["deferReply", "editReply"]);
    const edit = edits[0] as { embeds?: { description?: string }[] };
    expect(edit.embeds?.[0]?.description).toContain("Idle");
  });

  it("refuses users outside the allow-list without any status data", async () => {
    const { interaction, calls, replies, edits, defers } = makeFakeInteraction("intruder");
    const result = await handlePiStatusInteraction(interaction, {
      allowedUserIds: ["user-1"],
      buildState: () => STATE,
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["reply"]);
    expect(defers).toHaveLength(0);
    expect(edits).toHaveLength(0);

    const reply = replies[0] as { content?: string; ephemeral?: boolean };
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toBeTruthy();
    expect(reply.content).not.toContain("openai-codex");
    expect(reply.content).not.toContain("byow");
    expect(reply.content).not.toContain("8f3c1a2");
    expect(reply.content).not.toContain("Idle");
  });

  it("allows everyone when the allow-list is empty or missing", async () => {
    for (const allowedUserIds of [[], undefined]) {
      const { interaction, calls } = makeFakeInteraction("anyone");
      const result = await handlePiStatusInteraction(interaction, {
        allowedUserIds,
        buildState: () => STATE,
      });
      expect(result.ok).toBe(true);
      expect(calls).toEqual(["deferReply", "editReply"]);
    }
  });

  it("stays ephemeral and leaks nothing when the status cannot be built", async () => {
    const { interaction, calls, defers, edits } = makeFakeInteraction("user-1");
    const result = await handlePiStatusInteraction(interaction, {
      allowedUserIds: ["user-1"],
      buildState: () => {
        throw new Error(`${SECRET_PROMPT} ${SECRET_TOKEN}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["deferReply", "editReply"]);
    expect(defers[0]).toEqual({ ephemeral: true });

    const edit = edits[0] as { content?: string; embeds?: unknown[] };
    expect(edit.content).toBeTruthy();
    expect(edit.content).not.toContain(SECRET_PROMPT);
    expect(edit.content).not.toContain(SECRET_TOKEN);
    expect(edit.content).not.toContain("Error:");
    expect(edit.embeds).toBeUndefined();
    expect(result.error).not.toContain(SECRET_PROMPT);
    expect(result.error).not.toContain(SECRET_TOKEN);
  });

  it("does not expose a stack trace when the status cannot be built", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1");
    await handlePiStatusInteraction(interaction, {
      buildState: () => {
        throw new Error("boom");
      },
    });

    const edit = edits[0] as { content?: string };
    expect(edit.content).not.toContain("at ");
    expect(edit.content).not.toContain("boom");
    expect(edit.content?.length).toBeLessThan(200);
  });

  it("reports a no-session status instead of failing", async () => {
    const { interaction, edits } = makeFakeInteraction("user-1");
    const result = await handlePiStatusInteraction(interaction, {
      buildState: () => ({ state: "no_session" }),
    });

    expect(result.ok).toBe(true);
    const edit = edits[0] as { embeds?: { description?: string }[] };
    expect(edit.embeds?.[0]?.description).toContain("No Pi session connected");
  });
});

// ─── Type compatibility with the real discord.js client ──────────────────────

describe("discord.js compatibility (compile-time)", () => {
  it("accepts a real discord.js Client, interaction and embed", () => {
    const clientFits: Client extends PiStatusClient ? true : false = true;
    const interactionFits: ChatInputCommandInteraction extends PiStatusInteraction
      ? true
      : false = true;
    const embedFits: StatusEmbed extends PiStatusEmbedPayload ? true : false = true;

    expect(clientFits).toBe(true);
    expect(interactionFits).toBe(true);
    expect(embedFits).toBe(true);
  });
});
