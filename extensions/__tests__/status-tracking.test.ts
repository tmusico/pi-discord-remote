import { describe, it, expect } from "vitest";

import {
  collectGitInfo,
  describeTurnFailure,
  parseGitStatusV2,
  readAgentIdleSafe,
  readContextUsageSafe,
  readSessionIdentitySafe,
  redactSecret,
  resolveSessionState,
} from "../index.js";
import { buildStatusEmbed, buildStatusView, type StatusState } from "../status.js";

// ─── resolveSessionState: state precedence ──────────────────────────────────
// waiting > error > working > idle > no_session

describe("resolveSessionState", () => {
  const idle = {
    hasSession: true,
    questionPending: false,
    reconnectFailed: false,
    lastError: null,
    agentBusy: false,
  };

  it("reports idle when a session is bound and nothing else applies", () => {
    expect(resolveSessionState(idle)).toBe("idle");
  });

  it("reports no_session when no session channel is bound", () => {
    expect(resolveSessionState({ ...idle, hasSession: false })).toBe("no_session");
  });

  it("reports working while the agent is busy", () => {
    expect(resolveSessionState({ ...idle, agentBusy: true })).toBe("working");
  });

  it("reports waiting when a Discord answer is outstanding", () => {
    expect(resolveSessionState({ ...idle, questionPending: true })).toBe("waiting");
  });

  it("reports error when the last turn failed", () => {
    expect(resolveSessionState({ ...idle, lastError: "aborted" })).toBe("error");
  });

  it("reports error when the reconnect failed", () => {
    expect(resolveSessionState({ ...idle, reconnectFailed: true })).toBe("error");
  });

  it("prefers waiting over every other state", () => {
    expect(
      resolveSessionState({
        hasSession: false,
        questionPending: true,
        reconnectFailed: true,
        lastError: "boom",
        agentBusy: true,
      }),
    ).toBe("waiting");
  });

  it("prefers error over working", () => {
    expect(
      resolveSessionState({ ...idle, lastError: "boom", agentBusy: true }),
    ).toBe("error");
  });

  it("prefers working over idle and no_session", () => {
    expect(resolveSessionState({ ...idle, agentBusy: true })).toBe("working");
    expect(resolveSessionState({ ...idle, hasSession: false, agentBusy: true })).toBe(
      "working",
    );
  });

  it("prefers idle over no_session", () => {
    expect(resolveSessionState({ ...idle })).toBe("idle");
    expect(resolveSessionState({ ...idle, hasSession: false })).toBe("no_session");
  });
});

// ─── describeTurnFailure: how the last run ended ────────────────────────────

describe("describeTurnFailure", () => {
  it("returns null for a normal run", () => {
    expect(
      describeTurnFailure({ messages: [{ role: "assistant", stopReason: "stop" }] }),
    ).toBeNull();
  });

  it("returns null when there are no messages", () => {
    expect(describeTurnFailure({ messages: [] })).toBeNull();
    expect(describeTurnFailure({})).toBeNull();
    expect(describeTurnFailure(undefined)).toBeNull();
  });

  it("describes an aborted run with a fixed label", () => {
    expect(
      describeTurnFailure({ messages: [{ role: "assistant", stopReason: "aborted" }] }),
    ).toBe("aborted");
  });

  it("describes a failed run with a fixed label — never the provider text", () => {
    const label = describeTurnFailure({
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "rate limited",
        },
      ],
    });

    expect(label).toBe("turn failed");
    expect(label).not.toContain("rate limited");
  });

  it("detects abort-like error messages without rendering them", () => {
    const label = describeTurnFailure({
      messages: [
        { role: "assistant", stopReason: "stop", errorMessage: "Request aborted by user" },
      ],
    });

    expect(label).toBe("aborted");
    expect(label).not.toContain("Request aborted by user");
  });

  it("never returns the provider text — no matter how long it is", () => {
    const label = describeTurnFailure({
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "x".repeat(500) }],
    });

    expect(label).toBe("turn failed");
    expect(label).not.toContain("x");
  });

  it("ignores non-assistant messages", () => {
    expect(
      describeTurnFailure({
        messages: [
          { role: "user", content: "hi" },
          { role: "toolResult", toolName: "bash", isError: true },
        ],
      }),
    ).toBeNull();
  });
});

// ─── Raw provider errors must never reach Discord ───────────────────────────

describe("turn failures never leak provider text", () => {
  const BOT_TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.fake-token-value";
  const SYSTEM_PROMPT = "SYSTEM PROMPT: You are a helpful coding agent.";
  const FILE_CONTENT = "const apiKey = 'hunter2-do-not-leak';";

  const event = {
    messages: [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: `401 Unauthorized: token=${BOT_TOKEN}\n${SYSTEM_PROMPT}\n${FILE_CONTENT}`,
      },
    ],
  };

  it("describes the failure with a fixed safe label", () => {
    const label = describeTurnFailure(event);

    expect(label).toBe("turn failed");
    for (const secret of [BOT_TOKEN, SYSTEM_PROMPT, FILE_CONTENT]) {
      expect(label ?? "").not.toContain(secret);
    }
  });

  it("keeps the secrets out of the status view and the embed", () => {
    const label = describeTurnFailure(event);
    const state: StatusState = { state: "error", errorMessage: label };
    const view = buildStatusView(state);
    const embed = buildStatusEmbed(view);

    const rendered = [
      label ?? "",
      view.headline,
      view.hint ?? "",
      embed.title,
      embed.description,
      ...view.fields.map((field) => `${field.name}: ${field.value}`),
      ...embed.fields.map((field) => `${field.name}: ${field.value}`),
    ];

    for (const text of rendered) {
      expect(text).not.toContain(BOT_TOKEN);
      expect(text).not.toContain(SYSTEM_PROMPT);
      expect(text).not.toContain(FILE_CONTENT);
    }
  });

  it("renders the generic error headline", () => {
    const label = describeTurnFailure(event);
    const view = buildStatusView({ state: "error", errorMessage: label });
    const embed = buildStatusEmbed(view);

    expect(view.headline).toBe("⚠️ Error — turn failed");
    expect(embed.description).toContain("⚠️ Error — turn failed");
  });
});

// ─── parseGitStatusV2: the single git invocation ────────────────────────────

describe("parseGitStatusV2", () => {
  it("parses a clean working tree", () => {
    const output = [
      "# branch.oid 4bea19a1c0d5f6e7a8b9c0d1e2f3a4b5c6d7e8f9",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
      "",
    ].join("\n");

    expect(parseGitStatusV2(output)).toEqual({
      branch: "main",
      sha: "4bea19a",
      dirtyCount: 0,
    });
  });

  it("counts modified and untracked entries", () => {
    const output = [
      "# branch.oid 4bea19a1c0d5f6e7a8b9c0d1e2f3a4b5c6d7e8f9",
      "# branch.head main",
      "1 .M N... 100644 100644 100644 4bea19a1c0d5f6e7a8b9c0d1e2f3a4b5c6d7e8f9 4bea19a1c0d5f6e7a8b9c0d1e2f3a4b5c6d7e8f9 src/App.tsx",
      "? untracked.txt",
      "",
    ].join("\n");

    expect(parseGitStatusV2(output)).toEqual({
      branch: "main",
      sha: "4bea19a",
      dirtyCount: 2,
    });
  });

  it("parses a detached HEAD", () => {
    const output = [
      "# branch.oid 4bea19a1c0d5f6e7a8b9c0d1e2f3a4b5c6d7e8f9",
      "# branch.head (detached)",
      "",
    ].join("\n");

    expect(parseGitStatusV2(output)).toEqual({
      branch: "(detached)",
      sha: "4bea19a",
      dirtyCount: 0,
    });
  });

  it("treats an unborn branch as an unknown sha", () => {
    const output = ["# branch.oid (initial)", "# branch.head main", ""].join("\n");

    expect(parseGitStatusV2(output)).toEqual({
      branch: "main",
      sha: null,
      dirtyCount: 0,
    });
  });

  it("reports everything as unknown for an empty output", () => {
    expect(parseGitStatusV2("")).toEqual({ branch: null, sha: null, dirtyCount: null });
    expect(parseGitStatusV2("   \n\n")).toEqual({ branch: null, sha: null, dirtyCount: null });
  });

  it("reports everything as unknown when git failed", () => {
    const output = "fatal: not a git repository (or any of the parent directories): .git\n";
    expect(parseGitStatusV2(output)).toEqual({ branch: null, sha: null, dirtyCount: null });
  });
});

// ─── collectGitInfo: the invocation bound ────────────────────────────────────

describe("collectGitInfo", () => {
  it("uses exactly one git invocation", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]): Promise<string | null> => {
      calls.push(args);
      return ["# branch.oid 4bea19a1c0", "# branch.head main", ""].join("\n");
    };

    const info = await collectGitInfo("/tmp/project", runner);

    expect(calls.length).toBeLessThanOrEqual(2);
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(["status", "--porcelain=v2", "--branch"]);
    expect(info).toEqual({ branch: "main", sha: "4bea19a", dirtyCount: 0 });
  });

  it("reports everything as unknown when git fails", async () => {
    const calls: string[][] = [];
    const info = await collectGitInfo("/tmp/project", async (args: string[]) => {
      calls.push(args);
      return null;
    });

    expect(calls.length).toBe(1);
    expect(info).toEqual({ branch: null, sha: null, dirtyCount: null });
  });

  it("never throws when the runner throws", async () => {
    const info = await collectGitInfo("/tmp/project", async () => {
      throw new Error("boom");
    });

    expect(info).toEqual({ branch: null, sha: null, dirtyCount: null });
  });
});

// ─── A stale ctx degrades gracefully ────────────────────────────────────────

describe("stale ctx degradation", () => {
  const throwingGetters = {
    get getContextUsage(): unknown {
      throw new Error("stale ctx");
    },
    get sessionManager(): unknown {
      throw new Error("stale ctx");
    },
    get isIdle(): unknown {
      throw new Error("stale ctx");
    },
  };

  it("returns the null fallback when every ctx getter throws", () => {
    expect(readContextUsageSafe(throwingGetters)).toEqual({
      tokens: null,
      contextWindow: null,
    });
    expect(readSessionIdentitySafe(throwingGetters)).toEqual({
      id: null,
      name: null,
      entries: null,
    });
    expect(readAgentIdleSafe(throwingGetters)).toBeNull();
  });

  it("returns the null fallback when the ctx methods throw", () => {
    const ctx = {
      getContextUsage(): unknown {
        throw new Error("stale ctx");
      },
      sessionManager: {
        getSessionId(): unknown {
          throw new Error("stale ctx");
        },
        getSessionName(): unknown {
          throw new Error("stale ctx");
        },
        getEntries(): unknown {
          throw new Error("stale ctx");
        },
      },
      isIdle(): unknown {
        throw new Error("stale ctx");
      },
    };

    expect(readContextUsageSafe(ctx)).toEqual({ tokens: null, contextWindow: null });
    expect(readSessionIdentitySafe(ctx)).toEqual({ id: null, name: null, entries: null });
    expect(readAgentIdleSafe(ctx)).toBeNull();
  });

  it("returns the null fallback without a ctx", () => {
    expect(readContextUsageSafe(null)).toEqual({ tokens: null, contextWindow: null });
    expect(readSessionIdentitySafe(undefined)).toEqual({
      id: null,
      name: null,
      entries: null,
    });
    expect(readAgentIdleSafe(null)).toBeNull();
  });

  it("reads a healthy ctx", () => {
    const ctx = {
      getContextUsage: () => ({ tokens: 100, contextWindow: 200 }),
      sessionManager: {
        getSessionId: () => "abc123",
        getSessionName: () => "may09",
        getEntries: () => [1, 2, 3],
      },
      isIdle: () => true,
    };

    expect(readContextUsageSafe(ctx)).toEqual({ tokens: 100, contextWindow: 200 });
    expect(readSessionIdentitySafe(ctx)).toEqual({
      id: "abc123",
      name: "may09",
      entries: 3,
    });
    expect(readAgentIdleSafe(ctx)).toBe(true);
  });

  it("renders a valid embed from an all-null snapshot", () => {
    const view = buildStatusView({
      state: "idle",
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
    const embed = buildStatusEmbed(view);

    const rendered = [
      view.headline,
      view.hint ?? "",
      embed.title,
      embed.description,
      ...embed.fields.map((field) => `${field.name}: ${field.value}`),
    ];
    for (const text of rendered) {
      expect(text).not.toMatch(/undefined/);
      expect(text).not.toMatch(/NaN/);
      expect(text).not.toMatch(/null/);
    }

    expect(embed.title).toBe("Pi Session Status");
    expect(Number.isInteger(embed.color)).toBe(true);
  });
});

// ─── redactSecret: the bot token never reaches a log line ──────────────────

describe("redactSecret", () => {
  const TOKEN = "MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.fF-fF_fF-fF";

  it("replaces the token with a placeholder", () => {
    const redacted = redactSecret(`request failed with token ${TOKEN}`, TOKEN);

    expect(redacted).not.toContain(TOKEN);
    expect(redacted).toContain("***");
    expect(redacted).toContain("request failed with token");
  });

  it("replaces every occurrence of the token", () => {
    const redacted = redactSecret(`${TOKEN} and again ${TOKEN}`, TOKEN);

    expect(redacted).not.toContain(TOKEN);
    expect(redacted!.match(/\*\*\*/g)).toHaveLength(2);
  });

  it("suppresses the detail when no token is known", () => {
    // Without a redaction key the text cannot be sanitised reliably, so it
    // must be dropped instead of printed (e.g. a turn that failed after a
    // disconnect cleared the connection state).
    expect(redactSecret("some provider detail", null)).toBeNull();
    expect(redactSecret("some provider detail", "")).toBeNull();
    expect(redactSecret("some provider detail", "   ")).toBeNull();
  });

  it("caps the redacted text at 500 characters", () => {
    const redacted = redactSecret("x".repeat(900), TOKEN);

    expect(redacted).not.toBeNull();
    expect(redacted!.length).toBeLessThanOrEqual(501);
    expect(redacted!.endsWith("…")).toBe(true);
  });
});
