import { describe, it, expect } from "vitest";

import {
  AGENTS_COLOR_ACTIVE,
  AGENTS_COLOR_IDLE,
  AGENTS_EMBED_MAX_FIELDS,
  AGENTS_ROW_LIMIT,
  buildAgentFleetEmbed,
  buildAgentFleetView,
  buildAgentsEmptyMessage,
  formatAgentFleetText,
  formatAgentRow,
  resolveRunSelection,
  type AgentFleet,
  type AgentRow,
} from "../agents.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FLEET: AgentFleet = {
  profile: "work",
  counts: { active: 2, paused: 1, handingOff: 0, total: 3, omitted: 0 },
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
    {
      runId: "fedcba9876543210",
      state: "paused",
      handingOff: false,
      model: null,
      elapsed: "1m",
      currentTool: null,
      depth: 2,
      startedAt: 1760000000000,
      live: true,
    },
  ],
};

/** Every rendered value of an embed — used for the "no JS artifacts" check. */
function renderedValues(embed: ReturnType<typeof buildAgentFleetEmbed>): string[] {
  return [
    embed.title,
    embed.description,
    ...embed.fields.map((field) => `${field.name}: ${field.value}`),
  ];
}

// ─── Empty messages ──────────────────────────────────────────────────────────

describe("buildAgentsEmptyMessage", () => {
  it("distinguishes 'no owner' from 'no agents'", () => {
    const noOwner = buildAgentsEmptyMessage(null, false);
    expect(noOwner).toContain("No OptChat owner");

    const noAgents = buildAgentsEmptyMessage(
      { profile: "work", counts: { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 }, agents: [] },
      true,
    );
    expect(noAgents).toContain("No background agents");
    expect(noAgents).toContain("work");
  });

  it("never renders undefined/NaN/null", () => {
    const message = buildAgentsEmptyMessage(undefined, false);
    expect(message).not.toMatch(/\bundefined\b|\bNaN\b|\bnull\b/);
  });
});

// ─── View builder ────────────────────────────────────────────────────────────

describe("buildAgentFleetView", () => {
  it("builds the headline from the counters", () => {
    const view = buildAgentFleetView(FLEET, true);
    expect(view.headline).toBe("2 active · 1 paused · 3 total");
    expect(view.profile).toBe("work");
    expect(view.empty).toBeNull();
  });

  it("omits a zero pause count", () => {
    const view = buildAgentFleetView(
      { ...FLEET, counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 } },
      true,
    );
    expect(view.headline).toBe("1 active · 1 total");
  });

  it("shortens the run id", () => {
    const view = buildAgentFleetView(FLEET, true);
    expect(view.rows[0].runId).toBe("abcdef01");
  });

  it("marks an empty fleet with the empty message", () => {
    const view = buildAgentFleetView(
      { profile: "work", counts: { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 }, agents: [] },
      true,
    );
    expect(view.rows).toHaveLength(0);
    expect(view.empty).not.toBeNull();
  });

  it("marks a missing owner with the empty message", () => {
    const view = buildAgentFleetView(null, false);
    expect(view.empty).not.toBeNull();
    expect(view.headline).toBe("no OptChat owner");
  });

  it("caps the rows and reports the truncation", () => {
    const many: AgentFleet = {
      ...FLEET,
      counts: { active: 30, paused: 0, handingOff: 0, total: 30, omitted: 0 },
      agents: Array.from({ length: 30 }, (_unused, index) => ({
        runId: `run-${index}`,
        state: "running",
        handingOff: false,
        model: null,
        elapsed: null,
        currentTool: null,
        depth: 1,
        startedAt: 1760000000000,
        live: true,
      })),
    };
    const view = buildAgentFleetView(many, true);
    expect(view.rows).toHaveLength(AGENTS_ROW_LIMIT);
    expect(view.truncated).toBe(true);
  });

  it("surfaces the omitted count", () => {
    const view = buildAgentFleetView(
      { ...FLEET, counts: { ...FLEET.counts, omitted: 5 } },
      true,
    );
    expect(view.omitted).toBe(5);
  });
});

// ─── Row rendering ───────────────────────────────────────────────────────────

describe("formatAgentRow", () => {
  it("renders the known parts and leaves out the unknown ones", () => {
    const view = buildAgentFleetView(FLEET, true);
    const first = formatAgentRow(view.rows[0]);
    expect(first).toContain("abcdef01");
    expect(first).toContain("running");
    expect(first).toContain("openai-codex/gpt-6.1-sol");
    expect(first).toContain("3m 20s");
    expect(first).toContain("bash");
    expect(first).toContain("depth 1");

    const second = formatAgentRow(view.rows[1]);
    expect(second).toContain("paused");
    // The model and the tool are unknown — no placeholder is shown.
    expect(second).not.toContain("unknown");
  });

  it("marks a pending handoff", () => {
    const view = buildAgentFleetView(
      {
        ...FLEET,
        agents: [{ ...FLEET.agents[0], handingOff: true }],
      },
      true,
    );
    expect(formatAgentRow(view.rows[0])).toContain("handoff pending");
  });

  it("never renders undefined/NaN/null", () => {
    const view = buildAgentFleetView(
      {
        ...FLEET,
        agents: [
          {
            runId: "run-1",
            state: "running",
            handingOff: false,
            model: null,
            elapsed: null,
            currentTool: null,
            depth: null,
            startedAt: 1760000000000,
            live: true,
          },
        ],
      },
      true,
    );
    expect(formatAgentRow(view.rows[0])).not.toMatch(/\bundefined\b|\bNaN\b|\bnull\b/);
  });
});

// ─── Embed ───────────────────────────────────────────────────────────────────

describe("buildAgentFleetEmbed", () => {
  it("renders one field per run", () => {
    const embed = buildAgentFleetEmbed(buildAgentFleetView(FLEET, true));
    expect(embed.title).toBe("Pi Background Agents");
    expect(embed.description).toContain("2 active · 1 paused · 3 total");
    expect(embed.description).toContain("profile: work");
    expect(embed.fields).toHaveLength(2);
  });

  it("adds an omitted note when runs were left out", () => {
    const embed = buildAgentFleetEmbed(
      buildAgentFleetView({ ...FLEET, counts: { ...FLEET.counts, omitted: 3 } }, true),
    );
    expect(embed.fields.some((field) => field.name === "Omitted")).toBe(true);
    expect(embed.fields.some((field) => field.name === "Omitted")).toBe(true);
  });

  it("adds a truncated note when the row cap was hit", () => {
    const many: AgentFleet = {
      ...FLEET,
      agents: Array.from({ length: AGENTS_ROW_LIMIT + 5 }, (_unused, index) => ({
        runId: `run-${index}`,
        state: "running",
        handingOff: false,
        model: null,
        elapsed: null,
        currentTool: null,
        depth: 1,
        startedAt: 1760000000000,
        live: true,
      })),
    };
    const embed = buildAgentFleetEmbed(buildAgentFleetView(many, true));
    expect(embed.fields.some((field) => field.name === "Truncated")).toBe(true);
  });

  it("respects Discord's field limit", () => {
    const many: AgentFleet = {
      ...FLEET,
      agents: Array.from({ length: 60 }, (_unused, index) => ({
        runId: `run-${index}`,
        state: "running",
        handingOff: false,
        model: null,
        elapsed: null,
        currentTool: null,
        depth: 1,
        startedAt: 1760000000000,
        live: true,
      })),
      counts: { active: 60, paused: 0, handingOff: 0, total: 60, omitted: 0 },
    };
    const embed = buildAgentFleetEmbed(buildAgentFleetView(many, true));
    expect(embed.fields.length).toBeLessThanOrEqual(AGENTS_EMBED_MAX_FIELDS);
  });

  it("uses the active color only when a run is running", () => {
    expect(buildAgentFleetEmbed(buildAgentFleetView(FLEET, true)).color).toBe(AGENTS_COLOR_ACTIVE);
    expect(
      buildAgentFleetEmbed(
        buildAgentFleetView(
          {
            ...FLEET,
            agents: [{ ...FLEET.agents[0], state: "paused" }],
          },
          true,
        ),
      ).color,
    ).toBe(AGENTS_COLOR_IDLE);
  });

  it("never renders undefined/NaN/null", () => {
    const embed = buildAgentFleetEmbed(buildAgentFleetView(FLEET, true));
    for (const value of renderedValues(embed)) {
      expect(value).not.toMatch(/\bundefined\b|\bNaN\b|\bnull\b/);
    }
  });
});

// ─── Plain text ──────────────────────────────────────────────────────────────

describe("formatAgentFleetText", () => {
  it("renders the headline and one line per run", () => {
    const text = formatAgentFleetText(buildAgentFleetView(FLEET, true));
    expect(text).toContain("2 active · 1 paused · 3 total");
    expect(text).toContain("profile: work");
    expect(text.split("\n").length).toBeGreaterThanOrEqual(4);
  });

  it("renders the empty message when there is nothing to list", () => {
    const text = formatAgentFleetText(buildAgentFleetView(null, false));
    expect(text).toContain("No OptChat owner");
  });
});

// ─── Pending snapshot ────────────────────────────────────────────────────────

describe("buildAgentsEmptyMessage: pending snapshot", () => {
  it("does not claim the profile has no agents when the snapshot has not arrived", () => {
    const message = buildAgentsEmptyMessage(
      {
        profile: null,
        counts: { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 },
        agents: [],
        pending: true,
      },
      true,
    );
    expect(message).toContain("not available yet");
    expect(message).not.toContain("No background agents");
  });

  it("renders the pending message through the view", () => {
    const view = buildAgentFleetView(
      {
        profile: null,
        counts: { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 },
        agents: [],
        pending: true,
      },
      true,
    );
    expect(view.empty).toContain("not available yet");
    expect(view.rows).toHaveLength(0);
  });
});

// ─── Run selection ───────────────────────────────────────────────────────────

describe("resolveRunSelection", () => {
  const RUNS: AgentRow[] = [
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
    {
      runId: "abc9999876543210",
      state: "paused",
      handingOff: false,
      model: null,
      elapsed: null,
      currentTool: null,
      depth: 1,
      startedAt: 1760000000001,
      live: true,
    },
  ];

  it("resolves an exact run id", () => {
    const selection = resolveRunSelection(RUNS, "abcdef0123456789");
    expect(selection.kind).toBe("exact");
    if (selection.kind === "exact") expect(selection.run.runId).toBe("abcdef0123456789");
  });

  it("resolves the short prefix /pi-agents shows", () => {
    const selection = resolveRunSelection(RUNS, "abcdef01");
    expect(selection.kind).toBe("exact");
    if (selection.kind === "exact") expect(selection.run.runId).toBe("abcdef0123456789");
  });

  it("is case insensitive", () => {
    expect(resolveRunSelection(RUNS, "ABCDEF01").kind).toBe("exact");
  });

  it("reports an ambiguous prefix", () => {
    const selection = resolveRunSelection(RUNS, "abc");
    expect(selection.kind).toBe("ambiguous");
    if (selection.kind === "ambiguous") expect(selection.candidates).toHaveLength(2);
  });

  it("reports an unknown run", () => {
    const selection = resolveRunSelection(RUNS, "zzz");
    expect(selection.kind).toBe("unknown");
  });

  it("suggests near-misses", () => {
    const selection = resolveRunSelection(RUNS, "3456789");
    expect(selection.kind).toBe("unknown");
    if (selection.kind === "unknown") expect(selection.suggestions).toHaveLength(1);
  });

  it("reports a run whose generation token is unknown", () => {
    const selection = resolveRunSelection(
      [{ ...RUNS[0], startedAt: null }],
      "abcdef01",
    );
    expect(selection.kind).toBe("no_token");
  });

  it("treats an empty query as unknown", () => {
    expect(resolveRunSelection(RUNS, "   ").kind).toBe("unknown");
  });

  it("tolerates a missing run list", () => {
    expect(resolveRunSelection(undefined as unknown as AgentRow[], "x").kind).toBe("unknown");
  });
});
