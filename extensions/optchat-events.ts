import { randomUUID } from "node:crypto";

/**
 * Client for the OptChat `pi.events` contract.
 *
 * OptChat (`pi-optchat`) is another Pi extension. When it is installed in the
 * **same** Pi process and has a profile open, it publishes a small, versioned
 * event contract on Pi's shared in-process event bus (`pi.events`). This
 * module binds that contract and exposes what this extension cares about:
 *
 *   • `optchat:main:status:v1` — the main agent's phase, current tool and
 *     pending-message flag.
 *   • `optchat:status:v1`      — the profile's background-agent fleet, with
 *     each run's generation token.
 *
 * **What this module may do:** listen, and issue the control requests the
 * contract allows. The only one implemented is `agent:stop`, and it is
 * governed by OptChat's **control gate** (`--optchat-events-control`, or the
 * profile's "Events control" setting). With the gate off, nothing is emitted
 * at all — the request is refused locally rather than sent and refused.
 *
 * Deliberately **not** implemented here (see `.pi/plans/optchat-events/PLAN.md`):
 *
 *   • Assistant-output subscriptions (live streaming was rejected — this
 *     extension keeps posting the final reply it already builds from
 *     `message_end` / `agent_end`).
 *   • The other agent controls (`agent:spawn` / `steer` / `resume`) and the
 *     history reads, which need OptChat's `--optchat-events-content` consent
 *     flag and carry no durable-delivery guarantee.
 *
 * Everything it sends is a **bounded, versioned request** addressed to the
 * current owner epoch; it never carries Discord identifiers, credentials or
 * file contents. It degrades to "no OptChat" when the contract is absent,
 * which is the normal case for a plain Pi session.
 *
 * No discord.js and no Pi imports: the parsers and the client are plain data
 * + a tiny bus interface, so they are unit-testable without a live session
 * (see `extensions/__tests__/optchat-events.test.ts`).
 */

// ─── Channel names ───────────────────────────────────────────────────────────

/** Additive capability advertisement (carries the owner epoch + consent flags). */
export const OPTCHAT_CAPABILITIES_EVENT = "optchat:capabilities:v1";
/** Bounded background-agent fleet snapshot. */
export const OPTCHAT_STATUS_EVENT = "optchat:status:v1";
/** Payload-free request for a fresh capabilities + fleet replay. */
export const OPTCHAT_STATUS_PING_EVENT = "optchat:status:ping:v1";
/** Bounded main-agent activity snapshot. */
export const OPTCHAT_MAIN_STATUS_EVENT = "optchat:main:status:v1";
/** Payload-free request for a fresh main-activity snapshot. */
export const OPTCHAT_MAIN_PING_EVENT = "optchat:main:ping:v1";
/** Owner lifecycle fact (`ready` / `replayed-ready` / `closing`). */
export const OPTCHAT_OWNER_EVENT = "optchat:owner:event:v1";
/** A control request (`agent:stop` / `steer` / `resume` / `spawn`). */
export const OPTCHAT_AGENT_REQUEST_EVENT = "optchat:agent:request:v1";
/** The terminal (or interim `accepted`) result of a control request. */
export const OPTCHAT_AGENT_RESULT_EVENT = "optchat:agent:result:v1";

/**
 * This extension's client id on the bus.
 *
 * The contract routes results by `clientId` + `requestId`, so it must be
 * stable and unique per consumer — never shared with another extension.
 */
export const OPTCHAT_CLIENT_ID = "pi-discord-remote";

/**
 * How long a control request waits for its terminal result.
 *
 * The owner's own operation deadline is 30 s; this is deliberately shorter so
 * a Discord reply never hangs. A request that runs out of time is reported as
 * `OUTCOME_UNKNOWN` — which is honest: the stop may or may not have happened.
 */
export const OPTCHAT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * How many run generations are remembered.
 *
 * A run leaves the fleet snapshot when it finishes, but its generation token
 * stays valid for a later `agent:resume` or `history:result` — so the token is
 * cached for a while after the run disappears.
 */
export const OPTCHAT_KNOWN_RUN_LIMIT = 64;

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * The slice of Pi's event bus this module needs.
 *
 * Structurally identical to `pi.events` on every Pi version that has one
 * (`emit(channel, data): void`, `on(channel, handler): () => void`), so the
 * real bus can be passed straight in without a cast.
 */
export interface OptchatEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/** The owner identity a request or snapshot belongs to. */
export interface OptchatOwner {
  /** The owner session's opaque id. */
  ownerSessionId: string;
  /**
   * The owner's opaque epoch.
   *
   * A **new** epoch means a **new** owner: never retarget a pending request
   * across an epoch change.
   */
  ownerEpoch: string;
}

/** What the capability payload says about the current owner. */
export interface OptchatCapabilities {
  owner: OptchatOwner;
  /** Metadata (status snapshots) are available. Always true for a real owner. */
  metadataEnabled: boolean;
  /** Assistant content may be read (OptChat's `--optchat-events-content`). */
  contentEnabled: boolean;
  /** Background agents may be controlled (OptChat's `--optchat-events-control`). */
  controlEnabled: boolean;
}

/** The main agent's lifecycle phase. */
export type OptchatMainPhase =
  | "idle"
  | "working"
  | "responding"
  | "awaiting-input"
  | "closing";

/** A bounded snapshot of what the main agent is doing. */
export interface OptchatMainStatus {
  owner: OptchatOwner;
  phase: OptchatMainPhase;
  /** One id for the current agent activity; not a provider turn number. */
  turnId: string | null;
  /** The sanitized name of the tool running now — never its arguments. */
  currentTool: string | null;
  /** How many tools were observed, or null when the bounded set overflowed. */
  toolCount: number | null;
  /** Whether Pi reports pending (queued) user messages. */
  pending: boolean;
  /** When the snapshot was taken, in epoch milliseconds. */
  sampledAt: number | null;
}

/** One background run in the fleet snapshot. */
export interface OptchatAgentRow {
  runId: string;
  /** OptChat's own run state (`running`, `paused`, …). */
  state: string;
  /** The run ended but its handoff summary has not reached the main agent yet. */
  handingOff: boolean;
  model: string | null;
  elapsed: string | null;
  currentTool: string | null;
  depth: number | null;
  /**
   * The run's generation token: when it started, in epoch milliseconds.
   *
   * It is sent back as `expectedStartedAt` to say which generation of a run
   * a request means. Null when the value cannot be published safely.
   */
  startedAt: number | null;
}

/**
 * A run this client has seen, with the generation token it was seen with.
 *
 * A resumed run keeps its id but starts a new generation, so the token is
 * refreshed from every snapshot rather than assumed to be fixed per run id.
 */
export interface OptchatKnownRun {
  runId: string;
  startedAt: number | null;
  state: string;
  /** The run ended but its handoff summary has not reached the main agent yet. */
  handingOff: boolean;
  model: string | null;
  elapsed: string | null;
  currentTool: string | null;
  depth: number | null;
  /**
   * True while the run is in the current fleet snapshot, false when it has
   * left it, and **null** when the snapshot was capped — then the run may
   * still be running, it just was not listed.
   */
  live: boolean | null;
  /** When this entry was last refreshed from a snapshot. */
  seenAt: number;
}

/**
 * The outcome of a control request.
 *
 * `code` is always one of the contract's fixed error codes — never an
 * exception message, a provider error or a path.
 */
export interface OptchatRequestOutcome {
  ok: boolean;
  /** The fixed error code when `ok` is false (e.g. `"STALE_RUN"`). */
  code: string | null;
  /** The result value when `ok` is true (e.g. `{ accepted: "stop-requested" }`). */
  value: unknown;
}

/** Fleet counters. `omitted` counts runs the snapshot's cap left out. */
export interface OptchatAgentCounts {
  active: number;
  paused: number;
  handingOff: number;
  total: number;
  omitted: number;
}

/** A bounded snapshot of the profile's background agents. */
export interface OptchatAgentSnapshot {
  profile: string | null;
  ownerSessionId: string | null;
  counts: OptchatAgentCounts;
  agents: OptchatAgentRow[];
  sampledAt: number | null;
}

/** The owner's lifecycle fact. */
export type OptchatOwnerEventKind = "ready" | "replayed-ready" | "closing";

/** A parsed owner lifecycle event. */
export interface OptchatOwnerEvent {
  kind: OptchatOwnerEventKind;
  owner: OptchatOwner;
  /** Increments when OptChat creates a replacement owner. Not an epoch. */
  generation: number | null;
}

/** Everything this client currently knows. */
export interface OptchatEventsState {
  /** The bound owner, or null when no OptChat owner is present. */
  owner: OptchatOwner | null;
  contentEnabled: boolean;
  controlEnabled: boolean;
  mainStatus: OptchatMainStatus | null;
  agentSnapshot: OptchatAgentSnapshot | null;
}

// ─── Small parsing helpers ───────────────────────────────────────────────────

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

function asNonEmptyString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return raw.trim().length > 0 ? raw : null;
}

function asFiniteNumber(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function asBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** Read an owner identity out of a flat payload. */
function readOwner(record: Record<string, unknown>): OptchatOwner | null {
  const ownerSessionId = asNonEmptyString(record.ownerSessionId);
  const ownerEpoch = asNonEmptyString(record.ownerEpoch);
  if (!ownerSessionId || !ownerEpoch) return null;
  return { ownerSessionId, ownerEpoch };
}

/** Do two owner identities refer to the same owner? */
export function sameOwner(a: OptchatOwner | null, b: OptchatOwner | null): boolean {
  if (!a || !b) return false;
  return a.ownerSessionId === b.ownerSessionId && a.ownerEpoch === b.ownerEpoch;
}

// ─── Parsers (never throw) ───────────────────────────────────────────────────

/**
 * Parse the `optchat:capabilities:v1` payload.
 *
 * Returns null when the payload is not a v1 capability advertisement, or when
 * it carries no `integrations` object — the latter means the publisher has no
 * owner coordinator, so there is no event contract to bind to.
 */
export function parseOptchatCapabilities(raw: unknown): OptchatCapabilities | null {
  const record = asRecord(raw);
  if (!record || record.version !== 1) return null;

  const ownerSessionId = asNonEmptyString(record.ownerSessionId);
  if (!ownerSessionId) return null;

  const integrations = asRecord(record.integrations);
  if (!integrations || integrations.version !== 1) return null;

  const ownerEpoch = asNonEmptyString(integrations.ownerEpoch);
  if (!ownerEpoch) return null;

  const metadata = asRecord(integrations.metadata);
  const content = asRecord(integrations.content);
  const control = asRecord(integrations.control);

  return {
    owner: { ownerSessionId, ownerEpoch },
    // Metadata is unconditional for a real owner; treat a missing section as
    // enabled rather than silently hiding the status snapshots.
    metadataEnabled: metadata ? metadata.enabled !== false : true,
    // Consent flags default to OFF: an absent or malformed section must never
    // be read as permission.
    contentEnabled: content ? content.enabled === true : false,
    controlEnabled: control ? control.enabled === true : false,
  };
}

/** Parse the `optchat:owner:event:v1` payload. */
export function parseOptchatOwnerEvent(raw: unknown): OptchatOwnerEvent | null {
  const record = asRecord(raw);
  if (!record || record.version !== 1) return null;

  const kind = record.kind;
  if (kind !== "ready" && kind !== "replayed-ready" && kind !== "closing") return null;

  const owner = readOwner(record);
  if (!owner) return null;

  return { kind, owner, generation: asFiniteNumber(record.generation) };
}

const MAIN_PHASES: readonly OptchatMainPhase[] = [
  "idle",
  "working",
  "responding",
  "awaiting-input",
  "closing",
];

/** Parse the `optchat:main:status:v1` payload. */
export function parseOptchatMainStatus(raw: unknown): OptchatMainStatus | null {
  const record = asRecord(raw);
  if (!record || record.version !== 1) return null;

  const owner = readOwner(record);
  if (!owner) return null;

  const phase = record.phase;
  if (typeof phase !== "string" || !MAIN_PHASES.includes(phase as OptchatMainPhase)) {
    return null;
  }

  return {
    owner,
    phase: phase as OptchatMainPhase,
    turnId: asNonEmptyString(record.turnId),
    currentTool: asNonEmptyString(record.currentTool),
    toolCount: asFiniteNumber(record.toolCount),
    pending: asBoolean(record.pending, false),
    sampledAt: asFiniteNumber(record.sampledAt),
  };
}

/** Parse one row of the background-agent fleet. */
function parseAgentRow(raw: unknown): OptchatAgentRow | null {
  const record = asRecord(raw);
  if (!record) return null;

  const runId = asNonEmptyString(record.runId);
  if (!runId) return null;

  // The generation token is a whole positive millisecond — that is all the
  // contract's request parser accepts.
  const startedAt = asFiniteNumber(record.startedAt);

  return {
    runId,
    state: asNonEmptyString(record.state) ?? "unknown",
    handingOff: asBoolean(record.handingOff, false),
    model: asNonEmptyString(record.model),
    elapsed: asNonEmptyString(record.elapsed),
    currentTool: asNonEmptyString(record.currentTool),
    depth: asFiniteNumber(record.depth),
    startedAt:
      startedAt !== null && Number.isSafeInteger(startedAt) && startedAt > 0 ? startedAt : null,
  };
}

/** Parse the `optchat:status:v1` payload (the background-agent fleet). */
export function parseOptchatAgentSnapshot(raw: unknown): OptchatAgentSnapshot | null {
  const record = asRecord(raw);
  if (!record || record.version !== 1) return null;

  const rawAgents = Array.isArray(record.agents) ? record.agents : [];
  const agents: OptchatAgentRow[] = [];
  for (const rawAgent of rawAgents) {
    const row = parseAgentRow(rawAgent);
    if (row) agents.push(row);
  }

  const counts = asRecord(record.counts);
  const count = (key: string): number => asFiniteNumber(counts?.[key]) ?? 0;

  return {
    profile: asNonEmptyString(record.profile),
    ownerSessionId: asNonEmptyString(record.ownerSessionId),
    counts: {
      active: count("active"),
      paused: count("paused"),
      handingOff: count("handingOff"),
      total: count("total"),
      omitted: count("omitted"),
    },
    agents,
    sampledAt: asFiniteNumber(record.sampledAt),
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

/** Options for {@link createOptchatEventsClient}. */
export interface OptchatEventsClientOptions {
  /**
   * Pi's shared event bus, or null/undefined when this Pi has none.
   *
   * A missing bus is normal (an older Pi) and simply disables the client.
   */
  bus: OptchatEventBus | null | undefined;
  /**
   * How long a control request waits for its terminal result.
   *
   * Defaults to {@link OPTCHAT_REQUEST_TIMEOUT_MS}; tests use a short one.
   */
  requestTimeoutMs?: number;
}

/** The bound client. */
export interface OptchatEventsClient {
  /**
   * Attach the bus listeners and ask for a first snapshot.
   *
   * Listeners are attached **before** the pings, because Pi's bus does not
   * replay: a ping answered before the listener exists is lost.
   *
   * Idempotent — calling it twice does not subscribe twice.
   *
   * Never throws — a Pi without an event bus, or one whose extension is no
   * longer active, leaves the client inert.
   */
  start(): void;
  /**
   * Ask the owner for a fresh snapshot without touching the subscriptions.
   *
   * Used after a session start, when the owner may already have been open
   * before this extension attached its listeners.
   *
   * Never throws.
   */
  refresh(): void;
  /**
   * Detach the bus listeners.
   *
   * Never throws. Safe to call twice.
   */
  dispose(): void;
  /** The current state. Always safe to read. */
  getState(): OptchatEventsState;
  /**
   * The runs this client has seen, with the generation token they were seen
   * with.
   *
   * A run leaves the fleet snapshot when it finishes, but its token stays
   * valid for a later `agent:resume` — so the entry is kept (and bounded).
   */
  getKnownRuns(): OptchatKnownRun[];
  /**
   * Ask the owner to stop one background run.
   *
   * The target must carry the run's generation token; the owner rejects a
   * mismatch with `STALE_RUN`.
   *
   * Resolves with the contract's fixed error codes only. Never throws.
   */
  stopAgent(target: OptchatAgentTarget): Promise<OptchatRequestOutcome>;
}

/** The target of a control request: a run and the generation it means. */
export interface OptchatAgentTarget {
  runId: string;
  /** The run's generation token, echoed back as `expectedStartedAt`. */
  expectedStartedAt: number;
}

/**
 * Create the OptChat event client.
 *
 * The client listens to the owner's snapshots and can issue the control
 * requests the contract allows. It never touches Discord state.
 */
export function createOptchatEventsClient(
  options: OptchatEventsClientOptions,
): OptchatEventsClient {
  const bus = options.bus;
  const requestTimeoutMs =
    typeof options.requestTimeoutMs === "number" && options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : OPTCHAT_REQUEST_TIMEOUT_MS;
  const unsubscribes: Array<() => void> = [];
  let disposed = false;
  let started = false;

  let owner: OptchatOwner | null = null;
  let contentEnabled = false;
  let controlEnabled = false;
  let mainStatus: OptchatMainStatus | null = null;
  let agentSnapshot: OptchatAgentSnapshot | null = null;

  /** Runs this client has seen, keyed by run id. */
  const knownRuns = new Map<string, OptchatKnownRun>();
  /** Control requests waiting for their terminal result. */
  const pendingRequests = new Map<
    string,
    {
      resolve: (outcome: OptchatRequestOutcome) => void;
      timer: ReturnType<typeof setTimeout>;
      ownerSessionId: string;
      ownerEpoch: string;
      operation: string;
    }
  >();

  /**
   * Bind (or rebind) the owner.
   *
   * A different epoch means a different owner, so every snapshot belonging to
   * the previous owner is dropped — a stale phase or a stale agent list is
   * worse than no data at all.
   */
  const bindOwner = (next: OptchatOwner): void => {
    if (sameOwner(owner, next)) return;
    owner = next;
    mainStatus = null;
    agentSnapshot = null;
    // The fleet belongs to the owner, so the remembered runs belong to it
    // too. A replacement owner may be a different profile entirely, and a
    // stale run must never be offered as a target. The new owner's snapshot
    // republishes the tokens.
    knownRuns.clear();
  };

  /** Drop the binding entirely (the owner closed). */
  const clearOwner = (): void => {
    owner = null;
    contentEnabled = false;
    controlEnabled = false;
    mainStatus = null;
    agentSnapshot = null;
  };

  const handleCapabilities = (raw: unknown): void => {
    const capabilities = parseOptchatCapabilities(raw);
    if (!capabilities) return;
    bindOwner(capabilities.owner);
    contentEnabled = capabilities.contentEnabled;
    controlEnabled = capabilities.controlEnabled;
  };

  const handleOwnerEvent = (raw: unknown): void => {
    const event = parseOptchatOwnerEvent(raw);
    if (!event) return;
    if (event.kind === "closing") {
      // Only the owner we are actually bound to may close us.
      if (sameOwner(owner, event.owner)) clearOwner();
      return;
    }
    bindOwner(event.owner);
  };

  const handleMainStatus = (raw: unknown): void => {
    const status = parseOptchatMainStatus(raw);
    if (!status) return;
    // Ignore a snapshot that belongs to a different (or unknown) owner.
    if (!sameOwner(owner, status.owner)) return;
    mainStatus = status;
  };

  const handleAgentSnapshot = (raw: unknown): void => {
    const snapshot = parseOptchatAgentSnapshot(raw);
    if (!snapshot) return;
    // The fleet snapshot carries the owner session id but no epoch (it comes
    // from OptChat's original status contract), so it can only be matched at
    // session level. A snapshot from another session is not ours.
    if (owner && snapshot.ownerSessionId && snapshot.ownerSessionId !== owner.ownerSessionId) {
      return;
    }
    agentSnapshot = snapshot;
    rememberRuns(snapshot.agents, snapshot.counts.omitted);
  };

  /**
   * Remember the runs in a fleet snapshot, with the generation token they
   * were seen with.
   *
   * The token is refreshed on **every** snapshot: a resumed run keeps its id
   * but starts a new generation, so its token changes. A run that leaves the
   * snapshot keeps its entry (and its token) until the cache evicts it — the
   * token stays valid for a later `agent:resume` on that same generation.
   */
  const rememberRuns = (rows: OptchatAgentRow[], omitted: number): void => {
    const seenAt = Date.now();
    for (const row of rows) {
      knownRuns.set(row.runId, {
        runId: row.runId,
        startedAt: row.startedAt,
        state: row.state,
        handingOff: row.handingOff,
        model: row.model,
        elapsed: row.elapsed,
        currentTool: row.currentTool,
        depth: row.depth,
        live: true,
        seenAt,
      });
    }
    // Runs that are no longer in the snapshot stay cached, but are no longer
    // live — unless the snapshot was capped, in which case a missing run may
    // simply not have been listed.
    const capped = omitted > 0;
    for (const entry of knownRuns.values()) {
      if (rows.some((row) => row.runId === entry.runId)) continue;
      entry.live = capped ? null : false;
    }

    // Bound the cache: the least recently seen entry goes first.
    while (knownRuns.size > OPTCHAT_KNOWN_RUN_LIMIT) {
      let oldest: OptchatKnownRun | undefined;
      for (const entry of knownRuns.values()) {
        if (!oldest || entry.seenAt < oldest.seenAt) oldest = entry;
      }
      if (!oldest) break;
      knownRuns.delete(oldest.runId);
    }
  };

  const listen = (channel: string, handler: (raw: unknown) => void): void => {
    try {
      const off = bus!.on(channel, (data: unknown) => {
        // Pi logs whatever a listener throws, so every handler swallows its
        // own errors — a malformed payload must never become a Pi log line.
        try {
          handler(data);
        } catch {
          /* a malformed payload is simply ignored */
        }
      });
      if (typeof off === "function") unsubscribes.push(off);
    } catch {
      /* the bus is not usable — the client stays inert */
    }
  };

  const ping = (channel: string): void => {
    try {
      bus!.emit(channel, {});
    } catch {
      /* the extension may no longer be active — nothing to do */
    }
  };

  // ─── Control requests ──────────────────────────────────────────────────────

  /**
   * Handle the result of a control request.
   *
   * A result is matched on **all** of: the client id, the request id, and
   * the owner identity the request was addressed to. A result for another
   * consumer, another request or another owner is never consumed.
   *
   * `accepted` is **not** terminal — it only means the owner took
   * responsibility for the dispatch. The request stays pending until a
   * `rejected` or `completed` result arrives.
   */
  const handleAgentResult = (raw: unknown): void => {
    const record = asRecord(raw);
    if (!record || record.version !== 1) return;
    if (record.clientId !== OPTCHAT_CLIENT_ID) return;

    const requestId = asNonEmptyString(record.requestId);
    if (!requestId) return;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;

    // The result must come from the owner the request was addressed to.
    if (record.ownerSessionId !== pending.ownerSessionId) return;
    if (record.ownerEpoch !== pending.ownerEpoch) return;
    // …and it must be the answer to *this* request's operation.
    if (record.operation !== pending.operation) return;

    const phase = record.phase;
    if (phase === "accepted") return; // not terminal
    if (phase !== "rejected" && phase !== "completed") return;

    const outcome = asRecord(record.outcome);
    const status = outcome?.status;
    const code = asNonEmptyString(outcome?.code);
    const value = outcome?.value ?? null;

    settleRequest(
      requestId,
      status === "ok"
        ? { ok: true, code: null, value }
        : { ok: false, code: code ?? "INTERNAL_ERROR", value: null },
    );
  };

  /** Resolve a pending request and clear its timer. */
  const settleRequest = (requestId: string, outcome: OptchatRequestOutcome): void => {
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    pendingRequests.delete(requestId);
    try {
      clearTimeout(pending.timer);
    } catch {
      /* the timer may already be gone */
    }
    pending.resolve(outcome);
  };

  /**
   * Ask the owner to stop one background run.
   *
   * The request carries the run's generation token, so a run that was
   * resumed in the meantime is rejected with `STALE_RUN` instead of being
   * stopped by mistake.
   */
  const stopAgent = (target: OptchatAgentTarget): Promise<OptchatRequestOutcome> => {
    if (disposed) {
      return Promise.resolve({ ok: false, code: "DISPOSED", value: null });
    }
    if (!owner) {
      return Promise.resolve({ ok: false, code: "NO_OWNER", value: null });
    }
    if (!controlEnabled) {
      // The owner's control gate is off — the request would be refused with
      // DISABLED anyway. Say so without sending it.
      return Promise.resolve({ ok: false, code: "DISABLED", value: null });
    }
    if (!bus) {
      return Promise.resolve({ ok: false, code: "NO_BUS", value: null });
    }
    if (
      typeof target?.runId !== "string" ||
      target.runId.length === 0 ||
      !Number.isSafeInteger(target.expectedStartedAt) ||
      target.expectedStartedAt <= 0
    ) {
      return Promise.resolve({ ok: false, code: "INVALID_REQUEST", value: null });
    }

    const requestId = `stop-${randomUUID()}`;
    const ownerSessionId = owner.ownerSessionId;
    const ownerEpoch = owner.ownerEpoch;

    return new Promise<OptchatRequestOutcome>((resolve) => {
      const timer = setTimeout(() => {
        // The owner's own deadline is 30 s. Running out of time here means the
        // outcome is unknown — the stop may or may not have happened.
        settleRequest(requestId, { ok: false, code: "OUTCOME_UNKNOWN", value: null });
      }, requestTimeoutMs);
      // A pending request must never keep the process alive.
      (timer as unknown as { unref?: () => void }).unref?.();

      pendingRequests.set(requestId, {
        resolve,
        timer,
        ownerSessionId,
        ownerEpoch,
        operation: "agent:stop",
      });

      try {
        bus.emit(OPTCHAT_AGENT_REQUEST_EVENT, {
          version: 1,
          clientId: OPTCHAT_CLIENT_ID,
          requestId,
          ownerSessionId,
          ownerEpoch,
          operation: "agent:stop",
          // Only the two fields the contract defines — the contract rejects a
          // request that carries a forbidden semantic key.
          payload: { runId: target.runId, expectedStartedAt: target.expectedStartedAt },
        });
      } catch {
        settleRequest(requestId, { ok: false, code: "INTERNAL_ERROR", value: null });
      }
    });
  };

  return {
    start(): void {
      if (disposed || started || !bus) return;
      if (typeof bus.on !== "function" || typeof bus.emit !== "function") return;
      started = true;

      listen(OPTCHAT_CAPABILITIES_EVENT, handleCapabilities);
      listen(OPTCHAT_OWNER_EVENT, handleOwnerEvent);
      listen(OPTCHAT_MAIN_STATUS_EVENT, handleMainStatus);
      listen(OPTCHAT_STATUS_EVENT, handleAgentSnapshot);
      listen(OPTCHAT_AGENT_RESULT_EVENT, handleAgentResult);

      // The capabilities ping replays the capability payload (and therefore
      // the owner epoch); the main ping asks for a fresh activity snapshot.
      // Both are emitted after the listeners exist, because the bus does not
      // replay anything on its own.
      ping(OPTCHAT_STATUS_PING_EVENT);
      ping(OPTCHAT_MAIN_PING_EVENT);
    },

    refresh(): void {
      if (disposed || !bus) return;
      // A ping is only useful once the listeners are attached.
      if (!started) {
        this.start();
        return;
      }
      ping(OPTCHAT_STATUS_PING_EVENT);
      ping(OPTCHAT_MAIN_PING_EVENT);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      while (unsubscribes.length > 0) {
        const off = unsubscribes.pop();
        try {
          off?.();
        } catch {
          /* the bus may already be gone */
        }
      }
      // Every waiting request must settle — a caller must never hang on a
      // promise that will never resolve.
      for (const requestId of [...pendingRequests.keys()]) {
        settleRequest(requestId, { ok: false, code: "DISPOSED", value: null });
      }
      clearOwner();
    },

    getState(): OptchatEventsState {
      return {
        owner: owner ? { ...owner } : null,
        contentEnabled,
        controlEnabled,
        mainStatus,
        agentSnapshot,
      };
    },

    getKnownRuns(): OptchatKnownRun[] {
      return [...knownRuns.values()].map((entry) => ({ ...entry }));
    },

    stopAgent,
  };
}
