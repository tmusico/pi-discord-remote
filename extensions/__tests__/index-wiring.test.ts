import { describe, it, expect, vi } from "vitest";

import {
  abortSessionRun,
  describeErrorName,
  findModelByQualifiedId,
  isContextUsable,
  performModelSwitch,
  qualifiedModelId,
  readAvailableModelsSafe,
  readCurrentModelSafe,
  readModelScopeSafe,
  readModelsSafe,
  readRawModelsSafe,
  readScopedModelsSafe,
  resolveAbortOutcome,
  resolveCurrentModelId,
  routePiInteraction,
  toModelLike,
} from "../index.js";
import { MODEL_SCOPE_NOTE_UNAVAILABLE } from "../model-control.js";
import {
  PI_MODEL_AUTOCOMPLETE_MAX,
  PI_MODEL_COMMAND,
  handlePiModelAutocomplete,
  handlePiModelInteraction,
  registerPiCommands,
  type PiAutocompleteChoice,
  type PiModelAutocompleteInteraction,
  type PiStatusInteraction,
} from "../slash.js";

// ─── Fakes (no Discord, no live Pi session) ─────────────────────────────────

/** A ctx that throws on every access — a session that was replaced. */
function makeStaleCtx(): unknown {
  return {
    get model(): never {
      throw new Error("stale context");
    },
    get modelRegistry(): never {
      throw new Error("stale context");
    },
    get scopedModels(): never {
      throw new Error("stale context");
    },
    isIdle(): boolean {
      throw new Error("stale context");
    },
    abort(): void {
      throw new Error("stale context");
    },
  };
}

/** A live ctx with a scoped list, a registry and a current model. */
function makeLiveCtx(options: {
  scoped?: unknown[];
  available?: unknown[];
  authFor?: (model: unknown) => boolean;
  model?: unknown;
  idle?: boolean;
} = {}) {
  return {
    model: options.model ?? {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    },
    scopedModels: options.scoped,
    modelRegistry: {
      getAvailable: () => options.available ?? [],
      hasConfiguredAuth: (model: unknown) =>
        options.authFor ? options.authFor(model) : true,
    },
    isIdle: () => options.idle ?? true,
    abort: () => {
      /* no-op */
    },
  };
}

const ANTHROPIC = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" };
const CODEX = { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };

/** A secret that must never end up in a log line or a reply. */
const SECRET = "super-secret-bot-token";

/**
 * A ctx of an older Pi: the `scopedModels` property does not exist at all.
 */
function makeLegacyCtx(options: {
  available?: unknown[];
  authFor?: (model: unknown) => boolean;
  model?: unknown;
  idle?: boolean;
} = {}) {
  return {
    model: options.model ?? ANTHROPIC,
    modelRegistry: {
      getAvailable: () => options.available ?? [],
      hasConfiguredAuth: (model: unknown) =>
        options.authFor ? options.authFor(model) : true,
    },
    isIdle: () => options.idle ?? true,
    abort: () => {
      /* no-op */
    },
  };
}

// ─── Guarded ctx reads ──────────────────────────────────────────────────────

describe("guarded ctx reads", () => {
  it("never throws for a stale ctx — it degrades to an empty list", () => {
    const ctx = makeStaleCtx();

    expect(() => readScopedModelsSafe(ctx)).not.toThrow();
    expect(readScopedModelsSafe(ctx)).toEqual([]);
    expect(() => readAvailableModelsSafe(ctx)).not.toThrow();
    expect(readAvailableModelsSafe(ctx)).toEqual([]);
    expect(() => readRawModelsSafe(ctx)).not.toThrow();
    expect(readRawModelsSafe(ctx)).toEqual([]);
    expect(() => readModelsSafe(ctx)).not.toThrow();
    expect(readModelsSafe(ctx)).toEqual([]);
    expect(() => readCurrentModelSafe(ctx)).not.toThrow();
    expect(readCurrentModelSafe(ctx)).toBeNull();
  });

  it("never throws for a missing ctx", () => {
    expect(readScopedModelsSafe(null)).toEqual([]);
    expect(readAvailableModelsSafe(undefined)).toEqual([]);
    expect(readModelsSafe(null)).toEqual([]);
    expect(readCurrentModelSafe(null)).toBeNull();
    expect(isContextUsable(null)).toBe(false);
  });

  it("detects a stale ctx without letting the error escape", () => {
    expect(isContextUsable(makeStaleCtx())).toBe(false);
    expect(isContextUsable(makeLiveCtx())).toBe(true);
    expect(isContextUsable({})).toBe(false);
  });
});

// ─── Scoped models vs. available models ─────────────────────────────────────

describe("readModelsSafe", () => {
  it("prefers the scoped models over the registry's available models", () => {
    const ctx = makeLiveCtx({
      scoped: [{ model: ANTHROPIC, thinkingLevel: "high" }],
      available: [CODEX],
    });

    expect(readModelsSafe(ctx)).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    ]);
  });

  it("falls back to the available models when the scope is empty", () => {
    const ctx = makeLiveCtx({ scoped: [], available: [ANTHROPIC, CODEX] });

    expect(readModelsSafe(ctx)).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
      { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    ]);
  });

  it("filters the available models by the configured auth", () => {
    const ctx = makeLiveCtx({
      available: [ANTHROPIC, CODEX],
      authFor: (model) => (model as { provider: string }).provider === "anthropic",
    });

    expect(readAvailableModelsSafe(ctx)).toEqual([ANTHROPIC]);
    expect(readModelsSafe(ctx)).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    ]);
  });

  it("never offers a model without a configured auth", () => {
    const ctx = makeLiveCtx({ available: [ANTHROPIC], authFor: () => false });

    expect(readAvailableModelsSafe(ctx)).toEqual([]);
    expect(readModelsSafe(ctx)).toEqual([]);
  });

  it("maps the scoped entries to their model object", () => {
    const ctx = makeLiveCtx({ scoped: [{ model: ANTHROPIC, thinkingLevel: "high" }] });

    expect(readScopedModelsSafe(ctx)).toEqual([ANTHROPIC]);
  });

  it("skips models without a provider or an id", () => {
    const ctx = makeLiveCtx({
      available: [{ id: "no-provider" }, { provider: "no-id" }, ANTHROPIC],
    });

    expect(readModelsSafe(ctx)).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    ]);
  });

  it("falls back to the model id when the model has no name", () => {
    const ctx = makeLiveCtx({ available: [{ provider: "anthropic", id: "claude-sonnet-4-5" }] });

    expect(readModelsSafe(ctx)).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5" },
    ]);
  });
});

// ─── The registry receiver ──────────────────────────────────────────────────

describe("readAvailableModelsSafe", () => {
  it("keeps the registry as the receiver of hasConfiguredAuth", () => {
    // The real `ModelRegistry.hasConfiguredAuth()` reads `this.authStorage`
    // and `this.providerRequestConfigs`. An unbound call throws, the guarded
    // call swallows it and **every** model would be filtered out — so the
    // fake below uses a normal method that depends on `this`.
    const registry = {
      authStorage: { hasAuth: () => true },
      models: [ANTHROPIC],
      getAvailable(this: { models: unknown[] }) {
        return this.models;
      },
      hasConfiguredAuth(
        this: { authStorage: { hasAuth: (provider: string) => boolean } },
        model: unknown,
      ) {
        return this.authStorage.hasAuth((model as { provider: string }).provider);
      },
    };

    const ctx = { modelRegistry: registry, isIdle: () => true };

    expect(readAvailableModelsSafe(ctx)).toEqual([ANTHROPIC]);
  });

  it("still filters a model whose provider has no credentials", () => {
    const registry = {
      authStorage: { hasAuth: (provider: string) => provider === "anthropic" },
      models: [ANTHROPIC, CODEX],
      getAvailable(this: { models: unknown[] }) {
        return this.models;
      },
      hasConfiguredAuth(
        this: { authStorage: { hasAuth: (provider: string) => boolean } },
        model: unknown,
      ) {
        return this.authStorage.hasAuth((model as { provider: string }).provider);
      },
    };

    const ctx = { modelRegistry: registry, isIdle: () => true };

    expect(readAvailableModelsSafe(ctx)).toEqual([ANTHROPIC]);
  });
});

// ─── Qualified id formatting ────────────────────────────────────────────────

describe("qualified model id", () => {
  it("formats provider/model-id", () => {
    expect(qualifiedModelId(ANTHROPIC)).toBe("anthropic/claude-sonnet-4-5");
    expect(qualifiedModelId({ provider: "openai-codex", id: "gpt-6.1-sol" })).toBe(
      "openai-codex/gpt-6.1-sol",
    );
  });

  it("is null for a model without a provider or an id", () => {
    expect(qualifiedModelId(null)).toBeNull();
    expect(qualifiedModelId({ id: "gpt-6.1-sol" })).toBeNull();
    expect(qualifiedModelId({ provider: "openai-codex" })).toBeNull();
    expect(qualifiedModelId("anthropic/claude-sonnet-4-5")).toBeNull();
  });

  it("prefers the live model over the tracked one", () => {
    expect(
      resolveCurrentModelId(
        { provider: "anthropic", id: "claude-sonnet-4-5" },
        { provider: "openai-codex", id: "gpt-6.1-sol" },
      ),
    ).toBe("anthropic/claude-sonnet-4-5");
  });

  it("falls back to the tracked model when the live one is unavailable", () => {
    expect(
      resolveCurrentModelId(null, { provider: "openai-codex", id: "gpt-6.1-sol" }),
    ).toBe("openai-codex/gpt-6.1-sol");
  });

  it("is null when neither the live nor the tracked model is known", () => {
    expect(resolveCurrentModelId(null, null)).toBeNull();
    expect(resolveCurrentModelId(null, { provider: "openai-codex" })).toBeNull();
  });

  it("reads the live model of the ctx", () => {
    expect(readCurrentModelSafe(makeLiveCtx())).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    });
  });
});

// ─── Model lookup (for the switch path) ─────────────────────────────────────

describe("findModelByQualifiedId", () => {
  it("finds the model object of a qualified id (case-insensitive)", () => {
    const models = [ANTHROPIC, CODEX];

    expect(findModelByQualifiedId(models, "anthropic/claude-sonnet-4-5")).toBe(ANTHROPIC);
    expect(findModelByQualifiedId(models, "ANTHROPIC/Claude-Sonnet-4-5")).toBe(ANTHROPIC);
    expect(findModelByQualifiedId(models, " openai-codex/gpt-6.1-sol ")).toBe(CODEX);
  });

  it("is null for an unknown or empty id", () => {
    expect(findModelByQualifiedId([ANTHROPIC], "anthropic/nope")).toBeNull();
    expect(findModelByQualifiedId([ANTHROPIC], "")).toBeNull();
    expect(findModelByQualifiedId([], "anthropic/claude-sonnet-4-5")).toBeNull();
  });
});

// ─── Abort outcome mapping ──────────────────────────────────────────────────

describe("resolveAbortOutcome", () => {
  const idle = { hasSession: true, ctxUsable: true, agentBusy: false, agentIdle: true };

  it("reports no_session when no session is connected", () => {
    expect(resolveAbortOutcome({ ...idle, hasSession: false })).toEqual({ kind: "no_session" });
  });

  it("reports unsupported when the captured ctx is gone", () => {
    expect(resolveAbortOutcome({ ...idle, ctxUsable: false })).toEqual({
      kind: "unsupported",
    });
  });

  it("reports idle when nothing is running", () => {
    expect(resolveAbortOutcome(idle)).toEqual({ kind: "idle" });
  });

  it("reports aborted when the agent is busy", () => {
    expect(resolveAbortOutcome({ ...idle, agentBusy: true })).toEqual({ kind: "aborted" });
  });

  it("reports aborted when the ctx says the agent is not idle", () => {
    expect(resolveAbortOutcome({ ...idle, agentIdle: false })).toEqual({ kind: "aborted" });
  });

  it("prefers no_session over every other state", () => {
    expect(
      resolveAbortOutcome({
        hasSession: false,
        ctxUsable: false,
        agentBusy: true,
        agentIdle: false,
      }),
    ).toEqual({ kind: "no_session" });
  });

  it("prefers unsupported over idle", () => {
    expect(
      resolveAbortOutcome({
        hasSession: true,
        ctxUsable: false,
        agentBusy: false,
        agentIdle: true,
      }),
    ).toEqual({ kind: "unsupported" });
  });
});

// ─── Model mapping ──────────────────────────────────────────────────────────

describe("toModelLike", () => {
  it("maps a raw model object", () => {
    expect(toModelLike(ANTHROPIC)).toEqual({
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
    });
  });

  it("is null for anything that is not a usable model", () => {
    expect(toModelLike(null)).toBeNull();
    expect(toModelLike("anthropic/claude-sonnet-4-5")).toBeNull();
    expect(toModelLike({ provider: "anthropic" })).toBeNull();
  });
});

// ─── End-to-end: the model option → registration → handler ──────────────────

/** A whole lot of models — more than one embed can show. */
function makeManyModels(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    provider: `provider-${index % 4}`,
    id: `model-${String(index).padStart(2, "0")}`,
    name: `Model ${index}`,
  }));
}

function makeFakeInteraction(optionValue: string | null = null) {
  const edits: unknown[] = [];
  const interaction: PiStatusInteraction = {
    user: { id: "user-1" },
    options: {
      getString: (name: string) => (name === "model" ? optionValue : null),
    },
    async deferReply() {
      /* no-op */
    },
    async editReply(options) {
      edits.push(options);
    },
    async reply() {
      /* no-op */
    },
  };
  return { interaction, edits };
}

function makeFakeAutocomplete(focused: string) {
  const responses: PiAutocompleteChoice[][] = [];
  const interaction: PiModelAutocompleteInteraction = {
    user: { id: "user-1" },
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

describe("/pi-model end to end", () => {
  it("registers the autocomplete option in the command body", async () => {
    const bodies: unknown[] = [];
    const client = {
      application: {
        id: "app-1",
        commands: {
          async fetch() {
            return [];
          },
          async create(body: unknown) {
            bodies.push(body);
            return { id: "1", name: "pi-model" };
          },
          async edit() {
            return { id: "1", name: "pi-model" };
          },
        },
      },
    };

    await registerPiCommands(client, "token", "guild-1", [PI_MODEL_COMMAND]);

    expect(bodies).toHaveLength(1);
    const body = bodies[0] as {
      name: string;
      options?: { name: string; type: number; autocomplete?: boolean }[];
    };
    expect(body.name).toBe("pi-model");
    expect(body.options).toEqual([
      {
        name: "model",
        description: "provider/model-id to switch to; omit to list",
        type: 3,
        required: false,
        autocomplete: true,
      },
    ]);
  });

  it("answers the autocomplete with at most 25 filtered choices", async () => {
    const ctx = makeLiveCtx({ available: makeManyModels(40) });
    const { interaction, responses } = makeFakeAutocomplete("model-1");

    const result = await handlePiModelAutocomplete(interaction, {
      listModels: () => readModelsSafe(ctx),
      currentModelId: () => resolveCurrentModelId(readCurrentModelSafe(ctx), null),
    });

    expect(result.ok).toBe(true);
    expect(responses).toHaveLength(1);
    expect(responses[0].length).toBeLessThanOrEqual(PI_MODEL_AUTOCOMPLETE_MAX);
    expect(responses[0].length).toBeGreaterThan(0);
    for (const choice of responses[0]) {
      expect(choice.name.length).toBeLessThanOrEqual(100);
      expect(choice.value.length).toBeLessThanOrEqual(100);
      expect(choice.value).toContain("/");
    }
  });

  it("marks the current model, states the total count and respects the embed limits", async () => {
    const models = makeManyModels(40);
    const ctx = makeLiveCtx({ available: models, model: models[3] });
    const { interaction, edits } = makeFakeInteraction(null);

    await handlePiModelInteraction(interaction, {
      listModels: () => readModelsSafe(ctx),
      currentModelId: () => resolveCurrentModelId(readCurrentModelSafe(ctx), null),
      switchModel: async () => ({ kind: "failed" }),
    });

    expect(edits).toHaveLength(1);
    const embed = (edits[0] as { embeds?: Record<string, unknown>[] }).embeds?.[0];
    expect(embed).toBeDefined();
    const payload = embed as {
      title?: string;
      description?: string;
      fields?: { name: string; value: string }[];
    };
    expect(payload.title?.length ?? 0).toBeLessThanOrEqual(256);
    expect(payload.description?.length ?? 0).toBeLessThanOrEqual(4096);
    expect(payload.fields?.length ?? 0).toBeLessThanOrEqual(25);
    // The current model is marked and the total count is stated.
    expect(payload.description).toContain("Current model:");
    expect(payload.description).toContain("40 models available");
    expect(payload.fields?.[0]?.name).toContain("✅");
  });
});

// ─── Model scope: feature-detected, never assumed ───────────────────────────

describe("readModelScopeSafe", () => {
  it("uses exactly the scoped models when the scope is not empty", () => {
    const ctx = makeLiveCtx({
      scoped: [{ model: ANTHROPIC, thinkingLevel: "high" }],
      available: [CODEX],
    });

    const scope = readModelScopeSafe(ctx);

    expect(scope.kind).toBe("scoped");
    expect(scope.models).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    ]);
    expect(scope.note).toBeUndefined();
  });

  it("falls back to the authenticated models when the scope is empty", () => {
    const ctx = makeLiveCtx({ scoped: [], available: [ANTHROPIC, CODEX] });

    const scope = readModelScopeSafe(ctx);

    // An empty scope means "no scoping configured" — not a missing API.
    expect(scope.kind).toBe("unscoped");
    expect(scope.models).toHaveLength(2);
    expect(scope.note).toBeUndefined();
  });

  it("falls back to the authenticated models when the scope API is missing (older Pi)", () => {
    const ctx = makeLegacyCtx({ available: [ANTHROPIC, CODEX] });

    const scope = readModelScopeSafe(ctx);

    expect(scope.kind).toBe("unavailable");
    expect(scope.models).toHaveLength(2);
    // The list is not scope-filtered — the reply has to say so.
    expect(scope.note).toBe(MODEL_SCOPE_NOTE_UNAVAILABLE);
  });

  it("never offers a model without a configured auth in the fallback", () => {
    const ctx = makeLegacyCtx({
      available: [ANTHROPIC, CODEX],
      authFor: (model) => (model as { provider: string }).provider === "anthropic",
    });

    expect(readModelScopeSafe(ctx).models).toEqual([
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    ]);
  });

  it("reports no note when the session has no model at all", () => {
    const scope = readModelScopeSafe(makeLegacyCtx({ available: [] }));

    expect(scope.kind).toBe("unavailable");
    expect(scope.models).toHaveLength(0);
    expect(scope.note).toBeUndefined();
  });

  it("degrades to an empty list for a stale ctx", () => {
    const scope = readModelScopeSafe(makeStaleCtx());

    expect(scope.models).toHaveLength(0);
    expect(scope.note).toBeUndefined();
  });
});

// ─── Runtime seams ──────────────────────────────────────────────────────────

describe("abortSessionRun", () => {
  it("rejects the pending question before it aborts the run", () => {
    const calls: string[] = [];
    const ctx = {
      isIdle: () => false,
      abort: () => calls.push("abort"),
    };

    const outcome = abortSessionRun({
      hasSession: () => true,
      isBusy: () => true,
      ctx,
      cancelQuestion: () => calls.push("cancelQuestion"),
    });

    expect(outcome).toEqual({ kind: "aborted" });
    expect(calls).toEqual(["cancelQuestion", "abort"]);
  });

  it("never aborts when nothing is running", () => {
    const calls: string[] = [];
    const ctx = {
      isIdle: () => true,
      abort: () => calls.push("abort"),
    };

    const outcome = abortSessionRun({
      hasSession: () => true,
      isBusy: () => false,
      ctx,
      cancelQuestion: () => calls.push("cancelQuestion"),
    });

    expect(outcome).toEqual({ kind: "idle" });
    expect(calls).toEqual([]);
  });

  it("never aborts without a session", () => {
    const calls: string[] = [];
    const ctx = {
      isIdle: () => false,
      abort: () => calls.push("abort"),
    };

    const outcome = abortSessionRun({
      hasSession: () => false,
      isBusy: () => true,
      ctx,
      cancelQuestion: () => calls.push("cancelQuestion"),
    });

    expect(outcome).toEqual({ kind: "no_session" });
    expect(calls).toEqual([]);
  });

  it("never aborts when the captured ctx is gone", () => {
    const calls: string[] = [];
    const ctx = {
      isIdle: () => {
        throw new Error("stale context");
      },
      abort: () => calls.push("abort"),
    };

    const outcome = abortSessionRun({
      hasSession: () => true,
      isBusy: () => true,
      ctx,
      cancelQuestion: () => calls.push("cancelQuestion"),
    });

    expect(outcome).toEqual({ kind: "unsupported" });
    expect(calls).toEqual([]);
  });

  it("logs only the error name when the abort itself fails", () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    try {
      const ctx = {
        isIdle: () => false,
        abort: () => {
          throw new Error(`token ${SECRET}`);
        },
      };

      const outcome = abortSessionRun({
        hasSession: () => true,
        isBusy: () => true,
        ctx,
        cancelQuestion: () => {},
      });

      expect(outcome).toEqual({ kind: "aborted" });
      const text = JSON.stringify(logged);
      expect(text).not.toContain(SECRET);
      expect(text).toContain("Error");
    } finally {
      spy.mockRestore();
    }
  });

  it("never logs a secret carried by the error's name", () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    try {
      const err = new Error("boom");
      // `name` is a writable property — a provider error could carry any
      // text in it.
      err.name = SECRET;

      const ctx = {
        isIdle: () => false,
        abort: () => {
          throw err;
        },
      };

      abortSessionRun({
        hasSession: () => true,
        isBusy: () => true,
        ctx,
        cancelQuestion: () => {},
      });

      expect(JSON.stringify(logged)).not.toContain(SECRET);
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── The leak-free error category ───────────────────────────────────────────

describe("describeErrorName", () => {
  it("never returns the error's own name — it may carry a secret", () => {
    const err = new Error("boom");
    err.name = SECRET;

    expect(describeErrorName(err)).toBe("Error");
  });

  it("recognizes the built-in error classes", () => {
    expect(describeErrorName(new TypeError("x"))).toBe("TypeError");
    expect(describeErrorName(new RangeError("x"))).toBe("RangeError");
    expect(describeErrorName(new ReferenceError("x"))).toBe("ReferenceError");
    expect(describeErrorName(new SyntaxError("x"))).toBe("SyntaxError");
    expect(describeErrorName("boom")).toBe("Error");
    expect(describeErrorName(undefined)).toBe("unknown_error");
  });
});

describe("performModelSwitch", () => {
  it("switches to an exactly resolved id", async () => {
    const calls: unknown[] = [];

    const outcome = await performModelSwitch({
      setModel: (model) => {
        calls.push(model);
        return true;
      },
      candidates: [ANTHROPIC, CODEX],
      qualifiedId: "anthropic/claude-sonnet-4-5",
    });

    expect(calls).toEqual([ANTHROPIC]);
    expect(outcome).toEqual({
      kind: "switched",
      model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
    });
  });

  it("never switches for an unknown id", async () => {
    let called = false;

    const outcome = await performModelSwitch({
      setModel: () => {
        called = true;
        return true;
      },
      candidates: [ANTHROPIC],
      qualifiedId: "anthropic/does-not-exist",
    });

    expect(called).toBe(false);
    expect(outcome).toEqual({ kind: "failed" });
  });

  it("reports a missing API key when the switch answers false", async () => {
    const outcome = await performModelSwitch({
      setModel: () => false,
      candidates: [ANTHROPIC],
      qualifiedId: "anthropic/claude-sonnet-4-5",
    });

    expect(outcome).toEqual({ kind: "no_auth", modelId: "anthropic/claude-sonnet-4-5" });
  });

  it("reports a failed switch without leaking the raw provider error", async () => {
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });

    try {
      const outcome = await performModelSwitch({
        setModel: () => {
          throw new Error(`provider said: ${SECRET}`);
        },
        candidates: [ANTHROPIC],
        qualifiedId: "anthropic/claude-sonnet-4-5",
      });

      expect(outcome).toEqual({ kind: "failed" });
      expect(JSON.stringify(outcome)).not.toContain(SECRET);
      expect(JSON.stringify(logged)).not.toContain(SECRET);
    } finally {
      spy.mockRestore();
    }
  });

  it("never switches in hub mode", async () => {
    let called = false;

    const outcome = await performModelSwitch({
      hasSession: () => false,
      setModel: () => {
        called = true;
        return true;
      },
      candidates: [ANTHROPIC],
      qualifiedId: "anthropic/claude-sonnet-4-5",
    });

    expect(called).toBe(false);
    expect(outcome).toEqual({ kind: "no_session" });
  });
});

describe("routePiInteraction", () => {
  const handlers = () => {
    const calls: string[] = [];
    return {
      calls,
      handlers: {
        status: () => calls.push("status"),
        abort: () => calls.push("abort"),
        model: () => calls.push("model"),
        modelAutocomplete: () => calls.push("autocomplete"),
      },
    };
  };

  it("dispatches the autocomplete branch before the chat-input branch", async () => {
    const { calls, handlers: fake } = handlers();

    await routePiInteraction(
      {
        // A fake that claims both — the autocomplete branch must win.
        isAutocomplete: () => true,
        isChatInputCommand: () => true,
        commandName: "pi-model",
      },
      fake,
    );

    expect(calls).toEqual(["autocomplete"]);
  });

  it("ignores the autocomplete of an unknown command", async () => {
    const { calls, handlers: fake } = handlers();

    await routePiInteraction(
      {
        isAutocomplete: () => true,
        isChatInputCommand: () => true,
        commandName: "some-other-command",
      },
      fake,
    );

    expect(calls).toEqual([]);
  });

  it("dispatches every known chat-input command", async () => {
    const { calls, handlers: fake } = handlers();

    for (const commandName of ["pi-status", "pi-abort", "pi-model"]) {
      await routePiInteraction(
        {
          isAutocomplete: () => false,
          isChatInputCommand: () => true,
          commandName,
        },
        fake,
      );
    }

    expect(calls).toEqual(["status", "abort", "model"]);
  });

  it("ignores an unknown command", async () => {
    const { calls, handlers: fake } = handlers();

    await routePiInteraction(
      {
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        commandName: "some-other-command",
      },
      fake,
    );

    expect(calls).toEqual([]);
  });

  it("ignores an interaction that is neither autocomplete nor chat input", async () => {
    const { calls, handlers: fake } = handlers();

    await routePiInteraction(
      {
        isAutocomplete: () => false,
        isChatInputCommand: () => false,
        commandName: "pi-model",
      },
      fake,
    );

    expect(calls).toEqual([]);
  });
});
