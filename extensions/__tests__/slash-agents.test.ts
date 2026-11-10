import { describe, it, expect, vi } from "vitest";

import {
  PI_AGENTS_COMMAND,
  PI_AGENTS_COMMAND_NAME,
  PI_AGENTS_UNAVAILABLE,
  PI_STATUS_REFUSAL,
  PI_STOP_COMMAND,
  PI_STOP_COMMAND_NAME,
  PI_STOP_AMBIGUOUS,
  PI_STOP_DENIED,
  PI_STOP_DISABLED,
  PI_STOP_NOT_RUNNING,
  PI_STOP_NO_OWNER,
  PI_STOP_NO_TOKEN,
  PI_STOP_STALE,
  PI_STOP_STOPPED,
  PI_STOP_UNAVAILABLE,
  PI_STOP_UNKNOWN_OUTCOME,
  PI_STOP_UNKNOWN_RUN,
  handlePiAgentsInteraction,
  handlePiStopInteraction,
  registerPiCommands,
  type PiStatusClient,
  type PiStatusCommandEntry,
  type PiStatusInteraction,
} from "../slash.js";
import type { AgentFleet } from "../agents.js";

// ─── Fakes (no network, no real Discord client) ──────────────────────────────

const SECRET_TOKEN = "super-secret-bot-token";

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

function makeFakeClient(existing: PiStatusCommandEntry[] = []) {
  const created: unknown[] = [];
  const edited: unknown[] = [];
  const sets: unknown[][] = [];

  // Kept in its own variable so the `set` member (which exists only to prove
  // that a bulk replace is never called) is not an excess property of the
  // narrower `PiStatusCommandManager` type.
  const commands = {
    async fetch() {
      return existing;
    },
    async create(body: unknown) {
      created.push(body);
      return { id: "created-1", name: "created" };
    },
    async edit(id: string, body: unknown) {
      edited.push({ id, body });
      return { id, name: "edited" };
    },
    async set(commandsToSet: unknown[]) {
      sets.push(commandsToSet);
      return [];
    },
  };

  const client: PiStatusClient = {
    application: {
      id: "app-123456789",
      commands,
    },
    user: { id: "bot-987654321" },
  };

  return { client, created, edited, sets };
}

const FLEET: AgentFleet = {
  profile: "work",
  counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
  agents: [
    {
      runId: "abcdef0123456789",
      state: "running",
      handingOff: false,
      model: "openai-codex/gpt-6.1-sol",
      elapsed: "3m 20s",
      currentTool: "bash",
      depth: 1,
      startedAt: 1760000000000,
      live: true,
    },
  ],
};

// ─── Command definition ──────────────────────────────────────────────────────

describe("PI_AGENTS_COMMAND", () => {
  it("is a chat-input command named pi-agents", () => {
    expect(PI_AGENTS_COMMAND.name).toBe("pi-agents");
    expect(PI_AGENTS_COMMAND.name).toBe(PI_AGENTS_COMMAND_NAME);
    expect(PI_AGENTS_COMMAND.type).toBe(1);
  });

  it("has a one-line description of at most 100 characters", () => {
    expect(PI_AGENTS_COMMAND.description.length).toBeLessThanOrEqual(100);
    expect(PI_AGENTS_COMMAND.description).not.toContain("\n");
  });
});

// ─── Handler ─────────────────────────────────────────────────────────────────

describe("handlePiAgentsInteraction", () => {
  it("defers ephemerally and replies with the fleet", async () => {
    const { interaction, calls, edits, defers } = makeFakeInteraction();

    const result = await handlePiAgentsInteraction(interaction, {
      readFleet: () => FLEET,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["deferReply", "editReply"]);
    expect(defers[0]).toEqual({ ephemeral: true });

    const embed = (edits[0] as { embeds: Array<{ title: string; fields: unknown[] }> }).embeds[0];
    expect(embed.title).toBe("Pi Background Agents");
    expect(embed.fields).toHaveLength(1);
  });

  it("refuses a user outside the allow-list", async () => {
    const { interaction, calls, replies } = makeFakeInteraction("intruder");

    const result = await handlePiAgentsInteraction(interaction, {
      allowedUserIds: ["user-1"],
      readFleet: () => FLEET,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_allowed");
    expect(calls).toEqual(["reply"]);
    expect(replies[0]).toEqual({ content: PI_STATUS_REFUSAL, ephemeral: true });
  });

  it("allows everyone when the allow-list is empty", async () => {
    const { interaction } = makeFakeInteraction("anyone");

    const result = await handlePiAgentsInteraction(interaction, {
      allowedUserIds: [],
      readFleet: () => FLEET,
    });

    expect(result.ok).toBe(true);
  });

  it("explains that no OptChat owner is bound", async () => {
    const { interaction, edits } = makeFakeInteraction();

    const result = await handlePiAgentsInteraction(interaction, {
      readFleet: () => null,
    });

    expect(result.ok).toBe(true);
    const reply = edits[0] as { content: string };
    expect(reply.content).toContain("No OptChat owner");
  });

  it("explains that the owner has no agents", async () => {
    const { interaction, edits } = makeFakeInteraction();

    const result = await handlePiAgentsInteraction(interaction, {
      readFleet: () => ({
        profile: "work",
        counts: { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 },
        agents: [],
      }),
    });

    expect(result.ok).toBe(true);
    const reply = edits[0] as { content: string };
    expect(reply.content).toContain("No background agents");
  });

  it("never leaks the bot token, a provider error or file contents", async () => {
    const { interaction, edits } = makeFakeInteraction();

    await handlePiAgentsInteraction(interaction, {
      readFleet: () => {
        throw new Error(`failed with ${SECRET_TOKEN} /home/tony/secret.txt`);
      },
    });

    const reply = edits[0] as { content: string };
    expect(reply.content).toBe(PI_AGENTS_UNAVAILABLE);
    expect(reply.content).not.toContain(SECRET_TOKEN);
    expect(reply.content).not.toContain("/home/tony");
  });

  it("reports a failed defer without throwing", async () => {
    const interaction: PiStatusInteraction = {
      user: { id: "user-1" },
      async deferReply() {
        throw new Error("timeout");
      },
      async editReply() {},
      async reply() {},
    };

    const result = await handlePiAgentsInteraction(interaction, { readFleet: () => FLEET });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("defer_failed");
  });
});

// ─── Registration ────────────────────────────────────────────────────────────

describe("registerPiCommands with /pi-agents", () => {
  it("creates the command when it does not exist yet", async () => {
    const { client, created, sets } = makeFakeClient([]);

    const result = await registerPiCommands(client, SECRET_TOKEN, "guild-1", [
      PI_AGENTS_COMMAND,
    ]);

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect((created[0] as { name: string }).name).toBe("pi-agents");
    // A bulk replace would delete the guild's other commands — never.
    expect(sets).toHaveLength(0);
  });

  it("updates the command in place when it already exists", async () => {
    const { client, created, edited, sets } = makeFakeClient([
      { id: "cmd-1", name: "pi-agents" },
    ]);

    await registerPiCommands(client, SECRET_TOKEN, "guild-1", [PI_AGENTS_COMMAND]);

    expect(created).toHaveLength(0);
    expect(edited).toHaveLength(1);
    expect(sets).toHaveLength(0);
  });

  it("never touches a command with another name", async () => {
    const { client, created, edited } = makeFakeClient([
      { id: "cmd-1", name: "pi-status" },
    ]);

    await registerPiCommands(client, SECRET_TOKEN, "guild-1", [PI_AGENTS_COMMAND]);

    expect(created).toHaveLength(1);
    expect(edited).toHaveLength(0);
  });
});

describe("handlePiAgentsInteraction: pending snapshot", () => {
  it("says the list is not available yet instead of claiming there are no agents", async () => {
    const { interaction, edits } = makeFakeInteraction();

    await handlePiAgentsInteraction(interaction, {
      readFleet: () => ({
        profile: null,
        counts: { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 },
        agents: [],
        pending: true,
      }),
    });

    const reply = edits[0] as { content: string };
    expect(reply.content).toContain("not available yet");
    expect(reply.content).not.toContain("No background agents");
  });
});

// ─── /pi-stop ────────────────────────────────────────────────────────────────

describe("PI_STOP_COMMAND", () => {
  it("is a chat-input command named pi-stop with a required run option", () => {
    expect(PI_STOP_COMMAND.name).toBe("pi-stop");
    expect(PI_STOP_COMMAND.name).toBe(PI_STOP_COMMAND_NAME);
    expect(PI_STOP_COMMAND.type).toBe(1);
    expect(PI_STOP_COMMAND.options).toHaveLength(1);
    expect(PI_STOP_COMMAND.options[0].name).toBe("run");
    expect(PI_STOP_COMMAND.options[0].required).toBe(true);
  });

  it("has a one-line description of at most 100 characters", () => {
    expect(PI_STOP_COMMAND.description.length).toBeLessThanOrEqual(100);
    expect(PI_STOP_COMMAND.description).not.toContain("\n");
  });
});

describe("handlePiStopInteraction", () => {
  const RUNS = [
    {
      runId: "abcdef0123456789",
      state: "running",
      handingOff: false,
      model: null,
      elapsed: null,
      currentTool: null,
      depth: 1,
      startedAt: 1760000000000,
      live: true,
    },
  ];

  function makeStopInteraction(userId = "user-1", runValue: string | null = "abcdef01") {
    const calls: string[] = [];
    const edits: unknown[] = [];
    const replies: unknown[] = [];

    const interaction: PiStatusInteraction = {
      user: { id: userId },
      options: {
        getString(name: string) {
          return name === "run" ? runValue : null;
        },
      },
      async deferReply() {
        calls.push("deferReply");
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

    return { interaction, calls, edits, replies };
  }

  it("stops the run and sends the generation token", async () => {
    const { interaction, edits } = makeStopInteraction();
    const targets: unknown[] = [];

    const result = await handlePiStopInteraction(interaction, {
      listRuns: () => RUNS,
      stopRun: async (target) => {
        targets.push(target);
        return { ok: true, code: null };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.outcome).toBe("stopped");
    expect(targets).toEqual([{ runId: "abcdef0123456789", expectedStartedAt: 1760000000000 }]);
    expect((edits[0] as { content: string }).content).toBe(PI_STOP_STOPPED);
  });

  it("refuses a user outside the allow-list", async () => {
    const { interaction, calls } = makeStopInteraction("intruder");

    const result = await handlePiStopInteraction(interaction, {
      allowedUserIds: ["user-1"],
      listRuns: () => RUNS,
      stopRun: async () => ({ ok: true, code: null }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("not_allowed");
    expect(calls).toEqual(["reply"]);
  });

  it("reports an unknown run without asking the owner to stop anything", async () => {
    const { interaction, edits } = makeStopInteraction("user-1", "zzz");
    let called = false;

    await handlePiStopInteraction(interaction, {
      listRuns: () => RUNS,
      stopRun: async () => {
        called = true;
        return { ok: true, code: null };
      },
    });

    expect(called).toBe(false);
    expect((edits[0] as { content: string }).content).toBe(PI_STOP_UNKNOWN_RUN);
  });

  it("reports an ambiguous run", async () => {
    const { interaction, edits } = makeStopInteraction("user-1", "abc");

    await handlePiStopInteraction(interaction, {
      listRuns: () => [RUNS[0], { ...RUNS[0], runId: "abc9999876543210" }],
      stopRun: async () => ({ ok: true, code: null }),
    });

    expect((edits[0] as { content: string }).content).toBe(PI_STOP_AMBIGUOUS);
  });

  it("refuses a run whose generation token is not published", async () => {
    const { interaction, edits } = makeStopInteraction();
    let called = false;

    await handlePiStopInteraction(interaction, {
      listRuns: () => [{ ...RUNS[0], startedAt: null }],
      stopRun: async () => {
        called = true;
        return { ok: true, code: null };
      },
    });

    expect(called).toBe(false);
    expect((edits[0] as { content: string }).content).toBe(PI_STOP_NO_TOKEN);
  });

  it("maps a stale generation to the stale message", async () => {
    const { interaction, edits } = makeStopInteraction();

    await handlePiStopInteraction(interaction, {
      listRuns: () => RUNS,
      stopRun: async () => ({ ok: false, code: "STALE_RUN" }),
    });

    expect((edits[0] as { content: string }).content).toBe(PI_STOP_STALE);
  });

  it("maps a run that is no longer running", async () => {
    const { interaction, edits } = makeStopInteraction();

    await handlePiStopInteraction(interaction, {
      listRuns: () => RUNS,
      stopRun: async () => ({ ok: false, code: "INVALID_STATE" }),
    });

    expect((edits[0] as { content: string }).content).toBe(PI_STOP_NOT_RUNNING);
  });

  it("maps the disabled control gate", async () => {
    const { interaction, edits } = makeStopInteraction();

    await handlePiStopInteraction(interaction, {
      listRuns: () => RUNS,
      stopRun: async () => ({ ok: false, code: "DISABLED" }),
    });

    expect((edits[0] as { content: string }).content).toBe(PI_STOP_DISABLED);
  });

  it("never leaks the bot token, a provider error or file contents", async () => {
    const { interaction, edits } = makeStopInteraction();

    await handlePiStopInteraction(interaction, {
      listRuns: () => RUNS,
      stopRun: async () => {
        throw new Error(`failed with ${SECRET_TOKEN} /home/tony/secret.txt`);
      },
    });

    const reply = edits[0] as { content: string };
    expect(reply.content).toBe(PI_STOP_UNAVAILABLE);
    expect(reply.content).not.toContain(SECRET_TOKEN);
    expect(reply.content).not.toContain("/home/tony");
  });
});

// ─── Regression tests for the review findings ───────────────────────────────

describe("handlePiStopInteraction: review repairs", () => {
  const RUN = {
    runId: "abcdef0123456789",
    state: "running",
    handingOff: false,
    model: null,
    elapsed: null,
    currentTool: null,
    depth: 1,
    startedAt: 1760000000000,
    live: true,
  };

  function makeStopInteraction(runValue: string | null = "abcdef01") {
    const edits: unknown[] = [];
    const interaction: PiStatusInteraction = {
      user: { id: "user-1" },
      options: { getString: () => runValue },
      async deferReply() {},
      async editReply(editOptions) {
        edits.push(editOptions);
      },
      async reply() {},
    };
    return { interaction, edits };
  }

  it("R-P2-1: says no OptChat owner when there is no owner", async () => {
    const { interaction, edits } = makeStopInteraction();
    let called = false;

    const result = await handlePiStopInteraction(interaction, {
      // null = no OptChat owner is bound.
      listRuns: () => null,
      stopRun: async () => {
        called = true;
        return { ok: true, code: null };
      },
    });

    expect(called).toBe(false);
    expect(result.outcome).toBe("no_owner");
    expect((edits[0] as { content: string }).content).toBe(PI_STOP_NO_OWNER);
  });

  it("R-P2-2: says the outcome is unknown rather than that it failed", async () => {
    const { interaction, edits } = makeStopInteraction();

    await handlePiStopInteraction(interaction, {
      listRuns: () => [RUN],
      stopRun: async () => ({ ok: false, code: "OUTCOME_UNKNOWN" }),
    });

    const content = (edits[0] as { content: string }).content;
    expect(content).toBe(PI_STOP_UNKNOWN_OUTCOME);
    // The whole point of OUTCOME_UNKNOWN: the stop may have worked.
    expect(content).not.toBe(PI_STOP_UNAVAILABLE);
    expect(content).toContain("may or may not have happened");
  });

  it("R-P2-4: reports a denied target distinctly", async () => {
    const { interaction, edits } = makeStopInteraction();

    await handlePiStopInteraction(interaction, {
      listRuns: () => [RUN],
      stopRun: async () => ({ ok: false, code: "POLICY_DENIED" }),
    });

    const content = (edits[0] as { content: string }).content;
    expect(content).toBe(PI_STOP_DENIED);
    expect(content).not.toBe(PI_STOP_UNAVAILABLE);
  });
});
