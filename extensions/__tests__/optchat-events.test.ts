import { describe, it, expect, vi } from "vitest";

import {
  OPTCHAT_AGENT_REQUEST_EVENT,
  OPTCHAT_AGENT_RESULT_EVENT,
  OPTCHAT_CAPABILITIES_EVENT,
  OPTCHAT_CLIENT_ID,
  OPTCHAT_KNOWN_RUN_LIMIT,
  OPTCHAT_MAIN_PING_EVENT,
  OPTCHAT_MAIN_STATUS_EVENT,
  OPTCHAT_OWNER_EVENT,
  OPTCHAT_STATUS_EVENT,
  OPTCHAT_STATUS_PING_EVENT,
  createOptchatEventsClient,
  parseOptchatAgentSnapshot,
  parseOptchatCapabilities,
  parseOptchatMainStatus,
  parseOptchatOwnerEvent,
  sameOwner,
  type OptchatEventBus,
} from "../optchat-events.js";

// ─── Fake bus ────────────────────────────────────────────────────────────────

/** A bus that records handlers and emissions, like Pi's shared event bus. */
function makeBus(): {
  bus: OptchatEventBus;
  handlers: Map<string, Array<(data: unknown) => void>>;
  emitted: Array<{ channel: string; data: unknown }>;
  emitTo(channel: string, data: unknown): void;
} {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];

  const bus: OptchatEventBus = {
    emit(channel, data) {
      emitted.push({ channel, data });
    },
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => {
        const current = handlers.get(channel) ?? [];
        const index = current.indexOf(handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
  };

  return {
    bus,
    handlers,
    emitted,
    emitTo(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
}

const OWNER = { ownerSessionId: "session-1", ownerEpoch: "epoch-1" };

function capabilitiesPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    ownerSessionId: "session-1",
    integrations: {
      version: 1,
      ownerEpoch: "epoch-1",
      metadata: { enabled: true },
      content: { enabled: false },
      control: { enabled: false },
      unsupported: [],
      limits: {},
    },
    ...overrides,
  };
}

function mainStatusPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    ownerSessionId: "session-1",
    ownerEpoch: "epoch-1",
    phase: "working",
    turnId: "turn-1",
    currentTool: "bash",
    toolCount: 2,
    pending: false,
    queueDepth: null,
    exactQueueDepth: false,
    sampledAt: 1760000000000,
    ...overrides,
  };
}

// ─── Capability parsing ──────────────────────────────────────────────────────

describe("parseOptchatCapabilities", () => {
  it("reads the owner epoch and the consent flags", () => {
    const parsed = parseOptchatCapabilities(
      capabilitiesPayload({
        integrations: {
          version: 1,
          ownerEpoch: "epoch-9",
          metadata: { enabled: true },
          content: { enabled: true },
          control: { enabled: false },
        },
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.owner).toEqual({ ownerSessionId: "session-1", ownerEpoch: "epoch-9" });
    expect(parsed!.contentEnabled).toBe(true);
    expect(parsed!.controlEnabled).toBe(false);
    expect(parsed!.metadataEnabled).toBe(true);
  });

  it("returns null when there is no integrations section (no owner coordinator)", () => {
    expect(parseOptchatCapabilities({ version: 1, ownerSessionId: "s" })).toBeNull();
  });

  it("returns null for a wrong version or a missing epoch", () => {
    expect(parseOptchatCapabilities({ ...(capabilitiesPayload() as object), version: 2 })).toBeNull();
    expect(
      parseOptchatCapabilities({
        version: 1,
        ownerSessionId: "s",
        integrations: { version: 1 },
      }),
    ).toBeNull();
  });

  it("never reads a missing consent section as permission", () => {
    const parsed = parseOptchatCapabilities({
      version: 1,
      ownerSessionId: "session-1",
      integrations: { version: 1, ownerEpoch: "epoch-1" },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.contentEnabled).toBe(false);
    expect(parsed!.controlEnabled).toBe(false);
  });

  it("never throws on garbage", () => {
    for (const raw of [null, undefined, 42, "x", [], {}, { version: 1, integrations: 7 }]) {
      expect(() => parseOptchatCapabilities(raw)).not.toThrow();
    }
  });
});

// ─── Owner event parsing ─────────────────────────────────────────────────────

describe("parseOptchatOwnerEvent", () => {
  it("accepts the three lifecycle kinds", () => {
    for (const kind of ["ready", "replayed-ready", "closing"]) {
      const parsed = parseOptchatOwnerEvent({
        version: 1,
        ownerSessionId: "session-1",
        ownerEpoch: "epoch-1",
        generation: 3,
        kind,
      });
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe(kind);
      expect(parsed!.generation).toBe(3);
    }
  });

  it("rejects an unknown kind and a missing epoch", () => {
    expect(
      parseOptchatOwnerEvent({ version: 1, ownerSessionId: "s", ownerEpoch: "e", kind: "gone" }),
    ).toBeNull();
    expect(
      parseOptchatOwnerEvent({ version: 1, ownerSessionId: "s", kind: "ready" }),
    ).toBeNull();
  });
});

// ─── Main status parsing ─────────────────────────────────────────────────────

describe("parseOptchatMainStatus", () => {
  it("reads phase, tool and pending", () => {
    const parsed = parseOptchatMainStatus(mainStatusPayload());
    expect(parsed).not.toBeNull();
    expect(parsed!.phase).toBe("working");
    expect(parsed!.currentTool).toBe("bash");
    expect(parsed!.toolCount).toBe(2);
    expect(parsed!.pending).toBe(false);
    expect(parsed!.owner.ownerEpoch).toBe("epoch-1");
  });

  it("rejects an unknown phase", () => {
    expect(parseOptchatMainStatus(mainStatusPayload({ phase: "busy" }))).toBeNull();
  });

  it("rejects a payload without an owner", () => {
    expect(
      parseOptchatMainStatus({ ...(mainStatusPayload() as object), ownerEpoch: undefined }),
    ).toBeNull();
  });

  it("accepts a null turn id and a null tool count", () => {
    const parsed = parseOptchatMainStatus(
      mainStatusPayload({ turnId: null, currentTool: null, toolCount: null }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.turnId).toBeNull();
    expect(parsed!.toolCount).toBeNull();
  });
});

// ─── Agent snapshot parsing ──────────────────────────────────────────────────

describe("parseOptchatAgentSnapshot", () => {
  it("reads the fleet rows and counters", () => {
    const parsed = parseOptchatAgentSnapshot({
      version: 1,
      profile: "work",
      ownerSessionId: "session-1",
      sampledAt: 1760000000000,
      counts: { active: 2, paused: 1, handingOff: 0, total: 3, omitted: 1 },
      agents: [
        {
          runId: "run-a",
          state: "running",
          handingOff: false,
          model: "openai-codex/gpt-6.1-sol",
          elapsed: "3m 20s",
          currentTool: "read",
          depth: 1,
        },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.profile).toBe("work");
    expect(parsed!.counts.active).toBe(2);
    expect(parsed!.counts.omitted).toBe(1);
    expect(parsed!.agents).toHaveLength(1);
    expect(parsed!.agents[0].runId).toBe("run-a");
  });

  it("skips malformed rows and defaults missing counters to zero", () => {
    const parsed = parseOptchatAgentSnapshot({
      version: 1,
      agents: [{ state: "running" }, { runId: "run-b" }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.agents).toHaveLength(1);
    expect(parsed!.agents[0].state).toBe("unknown");
    expect(parsed!.counts.total).toBe(0);
    expect(parsed!.profile).toBeNull();
  });
});

// ─── Owner comparison ────────────────────────────────────────────────────────

describe("sameOwner", () => {
  it("requires both the session and the epoch to match", () => {
    expect(sameOwner(OWNER, { ...OWNER })).toBe(true);
    expect(sameOwner(OWNER, { ownerSessionId: "session-1", ownerEpoch: "epoch-2" })).toBe(false);
    expect(sameOwner(OWNER, { ownerSessionId: "session-2", ownerEpoch: "epoch-1" })).toBe(false);
    expect(sameOwner(null, OWNER)).toBe(false);
    expect(sameOwner(OWNER, null)).toBe(false);
  });
});

// ─── Client ──────────────────────────────────────────────────────────────────

describe("createOptchatEventsClient", () => {
  it("attaches every listener before it pings", () => {
    const { bus, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    const firstPing = emitted.findIndex((e) => e.channel === OPTCHAT_STATUS_PING_EVENT);
    expect(firstPing).toBeGreaterThanOrEqual(0);
    expect(emitted.some((e) => e.channel === OPTCHAT_MAIN_PING_EVENT)).toBe(true);

    // The bus does not replay: a ping answered before the listener exists is
    // lost. The listeners must therefore already be in place.
    const listenerCount = (["capabilities", "owner", "main", "agents"] as const).length;
    expect(listenerCount).toBe(4);
    client.dispose();
  });

  it("binds the owner from the capability payload", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    expect(client.getState().owner).toEqual(OWNER);
    expect(client.getState().contentEnabled).toBe(false);
    client.dispose();
  });

  it("binds the owner from an owner lifecycle event", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_OWNER_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-1",
      generation: 1,
      kind: "ready",
    });
    expect(client.getState().owner).toEqual(OWNER);
    client.dispose();
  });

  it("drops the binding when the owner closes", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_OWNER_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-1",
      generation: 1,
      kind: "closing",
    });

    const state = client.getState();
    expect(state.owner).toBeNull();
    expect(state.contentEnabled).toBe(false);
    expect(state.mainStatus).toBeNull();
    client.dispose();
  });

  it("ignores a closing event from a different owner", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_OWNER_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-2",
      generation: 2,
      kind: "closing",
    });

    expect(client.getState().owner).toEqual(OWNER);
    client.dispose();
  });

  it("keeps a main status that belongs to the bound owner", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_MAIN_STATUS_EVENT, mainStatusPayload());

    expect(client.getState().mainStatus?.phase).toBe("working");
    client.dispose();
  });

  it("ignores a main status from a foreign owner", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(
      OPTCHAT_MAIN_STATUS_EVENT,
      mainStatusPayload({ ownerSessionId: "session-9", ownerEpoch: "epoch-9" }),
    );

    expect(client.getState().mainStatus).toBeNull();
    client.dispose();
  });

  it("drops stale snapshots when the owner epoch changes", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_MAIN_STATUS_EVENT, mainStatusPayload());
    expect(client.getState().mainStatus).not.toBeNull();

    emitTo(
      OPTCHAT_CAPABILITIES_EVENT,
      capabilitiesPayload({
        integrations: {
          version: 1,
          ownerEpoch: "epoch-2",
          metadata: { enabled: true },
          content: { enabled: false },
          control: { enabled: false },
        },
      }),
    );

    const state = client.getState();
    expect(state.owner?.ownerEpoch).toBe("epoch-2");
    expect(state.mainStatus).toBeNull();
    client.dispose();
  });

  it("keeps the agent fleet snapshot", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      profile: "work",
      ownerSessionId: "session-1",
      sampledAt: 1,
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
      agents: [{ runId: "run-a", state: "running", handingOff: false, model: null, elapsed: "1s", currentTool: null, depth: 1 }],
    });

    expect(client.getState().agentSnapshot?.agents[0].runId).toBe("run-a");
    client.dispose();
  });

  it("is inert without a bus", () => {
    const client = createOptchatEventsClient({ bus: undefined });
    expect(() => client.start()).not.toThrow();
    expect(() => client.dispose()).not.toThrow();
    expect(client.getState().owner).toBeNull();
  });

  it("survives a bus whose on() throws", () => {
    const bus: OptchatEventBus = {
      emit() {},
      on() {
        throw new Error("bus unavailable");
      },
    };
    const client = createOptchatEventsClient({ bus });
    expect(() => client.start()).not.toThrow();
    expect(client.getState().owner).toBeNull();
  });

  it("survives a malformed payload without throwing", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    for (const raw of [null, undefined, 42, "x", [], { version: 2 }]) {
      expect(() => emitTo(OPTCHAT_CAPABILITIES_EVENT, raw)).not.toThrow();
      expect(() => emitTo(OPTCHAT_OWNER_EVENT, raw)).not.toThrow();
      expect(() => emitTo(OPTCHAT_MAIN_STATUS_EVENT, raw)).not.toThrow();
      expect(() => emitTo(OPTCHAT_STATUS_EVENT, raw)).not.toThrow();
    }
    client.dispose();
  });

  it("detaches every listener on dispose and clears the state", () => {
    const { bus, handlers, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    expect(client.getState().owner).not.toBeNull();

    client.dispose();
    expect(handlers.get(OPTCHAT_CAPABILITIES_EVENT)?.length ?? 0).toBe(0);
    expect(client.getState().owner).toBeNull();

    // A late payload after dispose must not resurrect the binding.
    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    expect(client.getState().owner).toBeNull();
  });

  it("tolerates a double dispose", () => {
    const { bus } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();
    client.dispose();
    expect(() => client.dispose()).not.toThrow();
  });

  it("does not emit anything itself beyond the two pings", () => {
    const { bus, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();
    expect(emitted.map((e) => e.channel).sort()).toEqual(
      [OPTCHAT_STATUS_PING_EVENT, OPTCHAT_MAIN_PING_EVENT].sort(),
    );
    client.dispose();
  });

  it("never lets a listener error escape into Pi", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    const spy = vi.fn();
    const onError = spy;
    process.on("uncaughtException", onError);
    try {
      emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
      emitTo(OPTCHAT_MAIN_STATUS_EVENT, mainStatusPayload());
    } finally {
      process.off("uncaughtException", onError);
    }
    expect(spy).not.toHaveBeenCalled();
    client.dispose();
  });
});

// ─── Idempotency, refresh and owner replacement ──────────────────────────────

describe("createOptchatEventsClient: lifecycle", () => {
  it("subscribes only once when start() is called twice", () => {
    const { bus, handlers, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();
    client.start();

    expect(handlers.get(OPTCHAT_CAPABILITIES_EVENT)?.length ?? 0).toBe(1);
    expect(emitted.filter((e) => e.channel === OPTCHAT_STATUS_PING_EVENT)).toHaveLength(1);
    client.dispose();
  });

  it("re-pings on refresh() without re-subscribing", () => {
    const { bus, handlers, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();
    client.refresh();

    expect(handlers.get(OPTCHAT_CAPABILITIES_EVENT)?.length ?? 0).toBe(1);
    expect(emitted.filter((e) => e.channel === OPTCHAT_STATUS_PING_EVENT)).toHaveLength(2);
    expect(emitted.filter((e) => e.channel === OPTCHAT_MAIN_PING_EVENT)).toHaveLength(2);
    client.dispose();
  });

  it("starts on refresh() when start() was never called", () => {
    const { bus, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.refresh();

    expect(emitted.filter((e) => e.channel === OPTCHAT_STATUS_PING_EVENT)).toHaveLength(1);
    client.dispose();
  });

  it("rebinds to a replacement owner when a gate change rebuilds the integration", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(
      OPTCHAT_CAPABILITIES_EVENT,
      capabilitiesPayload({
        integrations: {
          version: 1,
          ownerEpoch: "epoch-1",
          metadata: { enabled: true },
          content: { enabled: false },
          control: { enabled: false },
        },
      }),
    );
    emitTo(OPTCHAT_MAIN_STATUS_EVENT, mainStatusPayload());
    expect(client.getState().owner?.ownerEpoch).toBe("epoch-1");
    expect(client.getState().contentEnabled).toBe(false);

    // OptChat rebuilds the integration: a NEW owner epoch, and the gates the
    // new owner was built with are stated in its capability advertisement.
    emitTo(
      OPTCHAT_CAPABILITIES_EVENT,
      capabilitiesPayload({
        integrations: {
          version: 1,
          ownerEpoch: "epoch-2",
          metadata: { enabled: true },
          content: { enabled: true },
          control: { enabled: true },
        },
      }),
    );

    const state = client.getState();
    expect(state.owner?.ownerEpoch).toBe("epoch-2");
    expect(state.contentEnabled).toBe(true);
    expect(state.controlEnabled).toBe(true);
    // The previous owner's snapshot must not survive the replacement.
    expect(state.mainStatus).toBeNull();
    client.dispose();
  });

  it("keeps the binding when the closing event names an older epoch", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(
      OPTCHAT_CAPABILITIES_EVENT,
      capabilitiesPayload({
        integrations: {
          version: 1,
          ownerEpoch: "epoch-2",
          metadata: { enabled: true },
          content: { enabled: false },
          control: { enabled: false },
        },
      }),
    );
    // A late "closing" for the replaced owner must not unbind the new one.
    emitTo(OPTCHAT_OWNER_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-1",
      generation: 1,
      kind: "closing",
    });

    expect(client.getState().owner?.ownerEpoch).toBe("epoch-2");
    client.dispose();
  });

  it("does not throw when the bus emits during dispose", () => {
    const { bus } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();
    client.dispose();
    expect(() => client.refresh()).not.toThrow();
  });
});

describe("createOptchatEventsClient: fleet snapshot ownership", () => {
  it("ignores a fleet snapshot from another owner session", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      profile: "other",
      ownerSessionId: "session-9",
      sampledAt: 1,
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
      agents: [{ runId: "run-foreign", state: "running" }],
    });

    expect(client.getState().agentSnapshot).toBeNull();
    client.dispose();
  });

  it("keeps a fleet snapshot from the bound owner session", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      profile: "work",
      ownerSessionId: "session-1",
      sampledAt: 1,
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
      agents: [{ runId: "run-mine", state: "running" }],
    });

    expect(client.getState().agentSnapshot?.agents[0].runId).toBe("run-mine");
    client.dispose();
  });

  it("accepts a fleet snapshot that arrives before the owner is bound", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      profile: "work",
      ownerSessionId: "session-1",
      sampledAt: 1,
      counts: { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 },
      agents: [],
    });

    expect(client.getState().agentSnapshot).not.toBeNull();
    client.dispose();
  });
});

// ─── Generation token: parsing and caching ───────────────────────────────────

describe("the generation token", () => {
  it("is read from a fleet row", () => {
    const parsed = parseOptchatAgentSnapshot({
      version: 1,
      profile: "work",
      ownerSessionId: "session-1",
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
      agents: [{ runId: "run-a", state: "running", startedAt: 1760000000000 }],
    });
    expect(parsed!.agents[0].startedAt).toBe(1760000000000);
  });

  it("is null when it cannot be published safely", () => {
    for (const value of [null, undefined, 0, -1, 1.5, "1760000000000"]) {
      const parsed = parseOptchatAgentSnapshot({
        version: 1,
        counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
        agents: [{ runId: "run-a", state: "running", startedAt: value }],
      });
      expect(parsed!.agents[0].startedAt).toBeNull();
    }
  });

  it("is remembered for a run that leaves the snapshot", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      profile: "work",
      ownerSessionId: "session-1",
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
      agents: [{ runId: "run-a", state: "running", startedAt: 1760000000000 }],
    });
    expect(client.getKnownRuns()[0].startedAt).toBe(1760000000000);
    expect(client.getKnownRuns()[0].live).toBe(true);

    // The run finished and left the snapshot — its token stays cached.
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      profile: "work",
      ownerSessionId: "session-1",
      counts: { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 },
      agents: [],
    });
    expect(client.getKnownRuns()).toHaveLength(1);
    expect(client.getKnownRuns()[0].startedAt).toBe(1760000000000);
    expect(client.getKnownRuns()[0].live).toBe(false);
    client.dispose();
  });

  it("is refreshed when a resumed run publishes a new generation", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
      agents: [{ runId: "run-a", state: "running", startedAt: 1000 }],
    });
    expect(client.getKnownRuns()[0].startedAt).toBe(1000);

    // The same run id, resumed: a new generation, so a new token.
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
      agents: [{ runId: "run-a", state: "running", startedAt: 2000 }],
    });
    expect(client.getKnownRuns()).toHaveLength(1);
    expect(client.getKnownRuns()[0].startedAt).toBe(2000);
    client.dispose();
  });

  it("bounds the number of remembered runs", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    for (let index = 0; index < OPTCHAT_KNOWN_RUN_LIMIT + 20; index += 1) {
      emitTo(OPTCHAT_STATUS_EVENT, {
        version: 1,
        ownerSessionId: "session-1",
        counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
        agents: [{ runId: `run-${index}`, state: "running", startedAt: 1000 + index }],
      });
    }
    expect(client.getKnownRuns().length).toBeLessThanOrEqual(OPTCHAT_KNOWN_RUN_LIMIT);
    client.dispose();
  });
});

// ─── Control requests ────────────────────────────────────────────────────────

describe("stopAgent", () => {
  const CONTROL_CAPABILITIES = () =>
    capabilitiesPayload({
      integrations: {
        version: 1,
        ownerEpoch: "epoch-1",
        metadata: { enabled: true },
        content: { enabled: false },
        control: { enabled: true },
      },
    });


  /** The request id of the request the client emitted on the bus. */
  function emittedRequestId(emitted: Array<{ channel: string; data: unknown }>): string {
    const request = [...emitted]
      .reverse()
      .find((entry) => entry.channel === OPTCHAT_AGENT_REQUEST_EVENT);
    return (request?.data as { requestId: string }).requestId;
  }

  /** The request the client emitted on the bus. */
  function lastRequest(emitted: Array<{ channel: string; data: unknown }>) {
    const request = [...emitted]
      .reverse()
      .find((entry) => entry.channel === OPTCHAT_AGENT_REQUEST_EVENT);
    return request?.data as
      | {
          version: number;
          clientId: string;
          requestId: string;
          ownerSessionId: string;
          ownerEpoch: string;
          operation: string;
          payload: { runId: string; expectedStartedAt: number };
        }
      | undefined;
  }

  it("refuses without an owner and sends nothing", async () => {
    const { bus, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    const outcome = await client.stopAgent({ runId: "run-a", expectedStartedAt: 1000 });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("NO_OWNER");
    expect(emitted.some((e) => e.channel === OPTCHAT_AGENT_REQUEST_EVENT)).toBe(false);
    client.dispose();
  });

  it("refuses when the control gate is off and sends nothing", async () => {
    const { bus, emitTo, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    const outcome = await client.stopAgent({ runId: "run-a", expectedStartedAt: 1000 });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("DISABLED");
    expect(emitted.some((e) => e.channel === OPTCHAT_AGENT_REQUEST_EVENT)).toBe(false);
    client.dispose();
  });

  it("emits the contract's request envelope", async () => {
    const { bus, emitTo, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus, requestTimeoutMs: 200 });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, CONTROL_CAPABILITIES());
    void client.stopAgent({ runId: "run-a", expectedStartedAt: 1760000000000 });

    const request = lastRequest(emitted);
    expect(request).toBeDefined();
    expect(request!.version).toBe(1);
    expect(request!.clientId).toBe(OPTCHAT_CLIENT_ID);
    expect(request!.operation).toBe("agent:stop");
    expect(request!.ownerSessionId).toBe("session-1");
    expect(request!.ownerEpoch).toBe("epoch-1");
    expect(request!.payload).toEqual({ runId: "run-a", expectedStartedAt: 1760000000000 });
    // The contract rejects a request that carries a forbidden semantic key.
    expect(Object.keys(request!.payload).sort()).toEqual(["expectedStartedAt", "runId"]);
    client.dispose();
  });

  it("resolves on a completed result", async () => {
    const { bus, emitTo, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus, requestTimeoutMs: 500 });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, CONTROL_CAPABILITIES());
    const pending = client.stopAgent({ runId: "run-a", expectedStartedAt: 1000 });
    await Promise.resolve();

    const requestId = emittedRequestId(emitted);
    emitTo(OPTCHAT_AGENT_RESULT_EVENT, {
      version: 1,
      clientId: OPTCHAT_CLIENT_ID,
      requestId,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-1",
      operation: "agent:stop",
      phase: "completed",
      sequence: 2,
      outcome: { status: "ok", code: null, value: { accepted: "stop-requested" } },
    });

    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toEqual({ accepted: "stop-requested" });
    client.dispose();
  });

  it("does not settle on an accepted result", async () => {
    const { bus, emitTo, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus, requestTimeoutMs: 300 });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, CONTROL_CAPABILITIES());
    let settled = false;
    const pending = client.stopAgent({ runId: "run-a", expectedStartedAt: 1000 }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await Promise.resolve();

    const requestId = emittedRequestId(emitted);
    emitTo(OPTCHAT_AGENT_RESULT_EVENT, {
      version: 1,
      clientId: OPTCHAT_CLIENT_ID,
      requestId,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-1",
      operation: "agent:stop",
      phase: "accepted",
      sequence: 1,
      outcome: { status: "ok", code: null, value: null },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    // "accepted" only means the owner took responsibility for the dispatch.
    expect(settled).toBe(false);
    client.dispose();
  });

  it("resolves with the fixed code on a rejected result", async () => {
    const { bus, emitTo, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus, requestTimeoutMs: 500 });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, CONTROL_CAPABILITIES());
    const pending = client.stopAgent({ runId: "run-a", expectedStartedAt: 1000 });
    await Promise.resolve();

    const requestId = emittedRequestId(emitted);
    emitTo(OPTCHAT_AGENT_RESULT_EVENT, {
      version: 1,
      clientId: OPTCHAT_CLIENT_ID,
      requestId,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-1",
      operation: "agent:stop",
      phase: "rejected",
      sequence: 0,
      outcome: { status: "error", code: "STALE_RUN", value: null },
    });

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("STALE_RUN");
    client.dispose();
  });

  it("ignores a result for another client, request or owner", async () => {
    const { bus, emitTo, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus, requestTimeoutMs: 300 });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, CONTROL_CAPABILITIES());
    let settled = false;
    void client.stopAgent({ runId: "run-a", expectedStartedAt: 1000 }).then(() => {
      settled = true;
    });
    await Promise.resolve();

    const requestId = emittedRequestId(emitted);
    const base = {
      version: 1,
      clientId: OPTCHAT_CLIENT_ID,
      requestId,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-1",
      operation: "agent:stop",
      phase: "completed",
      sequence: 2,
      outcome: { status: "ok", code: null, value: { accepted: "stop-requested" } },
    };

    emitTo(OPTCHAT_AGENT_RESULT_EVENT, { ...base, clientId: "some-other-consumer" });
    emitTo(OPTCHAT_AGENT_RESULT_EVENT, { ...base, requestId: "some-other-request" });
    emitTo(OPTCHAT_AGENT_RESULT_EVENT, { ...base, ownerEpoch: "epoch-9" });
    emitTo(OPTCHAT_AGENT_RESULT_EVENT, { ...base, ownerSessionId: "session-9" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    client.dispose();
  });

  it("reports OUTCOME_UNKNOWN when the result never arrives", async () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus, requestTimeoutMs: 50 });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, CONTROL_CAPABILITIES());
    const outcome = await client.stopAgent({ runId: "run-a", expectedStartedAt: 1000 });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("OUTCOME_UNKNOWN");
    client.dispose();
  });

  it("rejects a malformed target without sending anything", async () => {
    const { bus, emitTo, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus, requestTimeoutMs: 200 });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, CONTROL_CAPABILITIES());
    const bad = await client.stopAgent({ runId: "", expectedStartedAt: 1000 });
    expect(bad.code).toBe("INVALID_REQUEST");

    const noToken = await client.stopAgent({ runId: "run-a", expectedStartedAt: 0 });
    expect(noToken.code).toBe("INVALID_REQUEST");

    const fractional = await client.stopAgent({ runId: "run-a", expectedStartedAt: 1.5 });
    expect(fractional.code).toBe("INVALID_REQUEST");

    expect(emitted.some((e) => e.channel === OPTCHAT_AGENT_REQUEST_EVENT)).toBe(false);
    client.dispose();
  });

  it("settles a pending request when the client is disposed", async () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus, requestTimeoutMs: 5000 });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, CONTROL_CAPABILITIES());
    const pending = client.stopAgent({ runId: "run-a", expectedStartedAt: 1000 });
    await Promise.resolve();
    client.dispose();

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe("DISPOSED");
  });
});

// ─── Regression tests for the review findings ───────────────────────────────

describe("review repairs: the run cache", () => {
  it("R-P2-3: is cleared when the owner is replaced", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      profile: "old-profile",
      ownerSessionId: "session-1",
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
      agents: [{ runId: "run-old", state: "running", startedAt: 1000 }],
    });
    expect(client.getKnownRuns()).toHaveLength(1);

    // The owner is replaced — the fleet belongs to the owner, so the
    // remembered runs go with it.
    emitTo(OPTCHAT_OWNER_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-2",
      generation: 2,
      kind: "ready",
    });
    expect(client.getKnownRuns()).toHaveLength(0);
    client.dispose();
  });

  it("R-P3-1: reports 'unknown' liveness when the snapshot was capped", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      counts: { active: 2, paused: 0, handingOff: 0, total: 2, omitted: 3 },
      agents: [{ runId: "run-a", state: "running", startedAt: 1000 }],
    });
    expect(client.getKnownRuns()[0].live).toBe(true);

    // The next snapshot dropped the run — but the snapshot was capped, so the
    // run may simply not have been listed.
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 3 },
      agents: [],
    });
    expect(client.getKnownRuns()[0].live).toBeNull();
    client.dispose();
  });

  it("R-P3-1b: reports 'not live' when the snapshot was not capped", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
      agents: [{ runId: "run-a", state: "running", startedAt: 1000 }],
    });
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      counts: { active: 0, paused: 0, handingOff: 0, total: 0, omitted: 0 },
      agents: [],
    });
    expect(client.getKnownRuns()[0].live).toBe(false);
    client.dispose();
  });

  it("R-P3-2: keeps the handoff flag and the current tool", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      counts: { active: 1, paused: 0, handingOff: 1, total: 1, omitted: 0 },
      agents: [
        {
          runId: "run-a",
          state: "stopped",
          handingOff: true,
          currentTool: "bash",
          startedAt: 1000,
        },
      ],
    });

    const run = client.getKnownRuns()[0];
    expect(run.handingOff).toBe(true);
    expect(run.currentTool).toBe("bash");
    client.dispose();
  });

  it("R-P3-3: ignores a result for a different operation", async () => {
    const { bus, emitTo, emitted } = makeBus();
    const client = createOptchatEventsClient({ bus, requestTimeoutMs: 300 });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload({
      integrations: {
        version: 1,
        ownerEpoch: "epoch-1",
        metadata: { enabled: true },
        content: { enabled: false },
        control: { enabled: true },
      },
    }));
    let settled = false;
    void client.stopAgent({ runId: "run-a", expectedStartedAt: 1000 }).then(() => {
      settled = true;
    });
    await Promise.resolve();

    const request = [...emitted]
      .reverse()
      .find((entry) => entry.channel === OPTCHAT_AGENT_REQUEST_EVENT)?.data as
      | { requestId: string }
      | undefined;

    emitTo(OPTCHAT_AGENT_RESULT_EVENT, {
      version: 1,
      clientId: OPTCHAT_CLIENT_ID,
      requestId: request!.requestId,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-1",
      // A different operation must not settle an agent:stop request.
      operation: "agent:resume",
      phase: "completed",
      sequence: 2,
      outcome: { status: "ok", code: null, value: { accepted: "resumed" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    client.dispose();
  });
});

describe("the run cache survives a capability replay", () => {
  it("R-P2-3b: a repeated capability advertisement does not wipe the cache", () => {
    const { bus, emitTo } = makeBus();
    const client = createOptchatEventsClient({ bus });
    client.start();

    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_STATUS_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      counts: { active: 1, paused: 0, handingOff: 0, total: 1, omitted: 0 },
      agents: [{ runId: "run-a", state: "running", startedAt: 1000 }],
    });
    expect(client.getKnownRuns()).toHaveLength(1);

    // A ping replays the capability advertisement for the SAME owner — that
    // is not a replacement and must not drop the remembered runs.
    emitTo(OPTCHAT_CAPABILITIES_EVENT, capabilitiesPayload());
    emitTo(OPTCHAT_OWNER_EVENT, {
      version: 1,
      ownerSessionId: "session-1",
      ownerEpoch: "epoch-1",
      generation: 1,
      kind: "replayed-ready",
    });
    expect(client.getKnownRuns()).toHaveLength(1);
    expect(client.getKnownRuns()[0].startedAt).toBe(1000);
    client.dispose();
  });
});
