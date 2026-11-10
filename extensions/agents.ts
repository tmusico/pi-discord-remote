/**
 * Pure view model for the Discord `/pi-agents` command.
 *
 * Renders the background-agent fleet an OptChat owner publishes on
 * `optchat:status:v1` (see `extensions/optchat-events.ts`).
 *
 * Deliberately free of any discord.js or Pi import: this module is plain data
 * + formatting so it can be unit-tested without a Discord connection, an
 * OptChat owner or a live Pi session.
 *
 * Every value in a snapshot is already sanitized by OptChat — the fleet
 * snapshot carries no task text, no title, no path, no transcript, no tool
 * arguments and no tool output. This module renders what it is given and
 * never invents a value.
 */

// ─── Public types ────────────────────────────────────────────────────────────

/** One background run, as published by the fleet snapshot. */
export interface AgentRow {
  /** The run's opaque id. */
  runId: string;
  /** OptChat's own run state (`running`, `paused`, …). */
  state: string;
  /** The run ended but its handoff summary has not reached the main agent yet. */
  handingOff: boolean;
  /** The model the run uses, or null when it cannot be published safely. */
  model: string | null;
  /** How long the run has been going, e.g. `"3m 20s"`. */
  elapsed: string | null;
  /** The tool the run is running right now, or null. Never its arguments. */
  currentTool: string | null;
  /** How deep the run is: 1 for a child of the main agent. */
  depth: number | null;
  /**
   * The run's generation token: when it started, in epoch milliseconds.
   *
   * It is sent back as `expectedStartedAt` to say which generation of a run
   * a request means. Null when the value cannot be published safely — a run
   * without a token cannot be targeted.
   */
  startedAt: number | null;
  /**
   * True while the run is in the current fleet snapshot, false when it has
   * left it, and **null** when the snapshot was capped — then the run may
   * still be running, it just was not listed.
   */
  live: boolean | null;
}

/** How a run was resolved from what the user typed. */
export type RunSelection =
  | { kind: "exact"; run: AgentRow }
  | { kind: "ambiguous"; query: string; candidates: AgentRow[] }
  | { kind: "unknown"; query: string; suggestions: AgentRow[] }
  | { kind: "no_token"; query: string; run: AgentRow };

/** Fleet counters. `omitted` counts runs the snapshot's cap left out. */
export interface AgentCounts {
  active: number;
  paused: number;
  handingOff: number;
  total: number;
  omitted: number;
}

/** The raw snapshot the renderer consumes. */
export interface AgentFleet {
  /** The OptChat profile's name, or null when it is unknown. */
  profile: string | null;
  /** The counters from the snapshot. */
  counts: AgentCounts;
  /** The runs in the snapshot. */
  agents: AgentRow[];
  /**
   * True when an owner is bound but its fleet snapshot has not arrived yet.
   *
   * This is a short window right after the owner binds; it must not be
   * reported as "the profile has no agents".
   */
  pending?: boolean;
}

/** One rendered agent line. */
export interface AgentViewRow {
  /** The short, displayable run id. */
  runId: string;
  /** The run state, e.g. `"running"`. */
  state: string;
  /** The model, or null when unknown. */
  model: string | null;
  /** The elapsed time, or null when unknown. */
  elapsed: string | null;
  /** The tool running right now, or null. */
  currentTool: string | null;
  /** The run depth, or null when unknown. */
  depth: number | null;
  /** True when the run ended but still owes a handoff. */
  handingOff: boolean;
}

/** Normalized, render-ready fleet. */
export interface AgentFleetView {
  /** The profile name, or null. */
  profile: string | null;
  /** The headline, e.g. `"2 active · 1 paused · 3 total"`. */
  headline: string;
  /** The rendered rows (already capped). */
  rows: AgentViewRow[];
  /** How many runs the snapshot left out. */
  omitted: number;
  /** True when rows were dropped by the cap. */
  truncated: boolean;
  /** One-line summary, used when there is nothing to list. */
  empty: string | null;
}

/** Plain embed object — safe to pass straight to `channel.send({ embeds: [obj] })`. */
export interface AgentEmbed {
  title: string;
  description: string;
  fields: { name: string; value: string; inline: boolean }[];
  color: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Embed title used for the fleet. */
export const AGENTS_EMBED_TITLE = "Pi Background Agents";

/** Discord limits (see https://discord.com/developers/docs/resources/channel). */
export const AGENTS_EMBED_DESCRIPTION_MAX = 4096;
export const AGENTS_EMBED_FIELD_NAME_MAX = 256;
export const AGENTS_EMBED_FIELD_VALUE_MAX = 1024;
export const AGENTS_EMBED_MAX_FIELDS = 25;

/** How many runs are listed at most. */
export const AGENTS_ROW_LIMIT = 20;

/** How many characters of a run id are shown. */
export const AGENTS_RUN_ID_LENGTH = 8;

/** Maximum number of ambiguous candidates / unknown suggestions. */
export const AGENTS_CANDIDATE_LIMIT = 5;

/** Embed color when the fleet has active runs (green). */
export const AGENTS_COLOR_ACTIVE = 0x22c55e;

/** Embed color when every run is idle or paused (amber). */
export const AGENTS_COLOR_IDLE = 0xf59e0b;

// ─── Small helpers ───────────────────────────────────────────────────────────

/**
 * Replace JS artifacts ("undefined", "NaN", "null") so a rendered value never
 * leaks an internal placeholder.
 */
function sanitize(raw: string): string {
  return raw.replace(/\bundefined\b|\bNaN\b|\bnull\b/g, "unknown");
}

/** Trimmed non-empty string, or null. */
function clean(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Finite number, or null. */
function num(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** Truncate `text` to `max` characters, appending an ellipsis when shortened. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

// ─── Run selection ───────────────────────────────────────────────────────────

/**
 * Resolve what the user typed into one run.
 *
 * The order mirrors the `/pi-model` selection: an exact run id, then a
 * unique prefix of a run id. The run id shown in `/pi-agents` is a shortened
 * prefix, so the short form must resolve.
 *
 * A run whose generation token is unknown cannot be targeted, so it is
 * reported separately (`no_token`) rather than as an exact match.
 */
export function resolveRunSelection(runs: AgentRow[], query: string): RunSelection {
  const rows = Array.isArray(runs) ? runs : [];
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (trimmed.length === 0) {
    return { kind: "unknown", query: trimmed, suggestions: [] };
  }

  const lower = trimmed.toLowerCase();

  const exact = rows.filter((row) => row.runId.toLowerCase() === lower);
  if (exact.length === 1) return withToken(trimmed, exact[0]);
  if (exact.length > 1) {
    return { kind: "ambiguous", query: trimmed, candidates: exact.slice(0, AGENTS_CANDIDATE_LIMIT) };
  }

  const prefix = rows.filter((row) => row.runId.toLowerCase().startsWith(lower));
  if (prefix.length === 1) return withToken(trimmed, prefix[0]);
  if (prefix.length > 1) {
    return { kind: "ambiguous", query: trimmed, candidates: prefix.slice(0, AGENTS_CANDIDATE_LIMIT) };
  }

  // Nothing matched: suggest the runs that contain the query, so a near-miss
  // is still recoverable.
  const suggestions = rows
    .filter((row) => row.runId.toLowerCase().includes(lower))
    .slice(0, AGENTS_CANDIDATE_LIMIT);

  return { kind: "unknown", query: trimmed, suggestions };
}

/** A matched run is only usable when its generation token is published. */
function withToken(query: string, run: AgentRow): RunSelection {
  if (run.startedAt === null) return { kind: "no_token", query, run };
  return { kind: "exact", run };
}

// ─── View builder ────────────────────────────────────────────────────────────

/**
 * Build the headline: how many runs are active, paused and known in total.
 *
 * Only the counters that are actually known are shown — a snapshot without
 * counters renders just the total.
 */
function buildHeadline(counts: AgentCounts): string {
  const parts: string[] = [];

  const active = num(counts.active);
  const paused = num(counts.paused);
  const total = num(counts.total);

  if (active !== null) parts.push(`${active} active`);
  if (paused !== null && paused > 0) parts.push(`${paused} paused`);
  if (total !== null) parts.push(`${total} total`);

  if (parts.length === 0) return "no background agents";
  return parts.join(" · ");
}

/**
 * Build the one-line summary used when there is nothing to list.
 *
 * It distinguishes "no OptChat owner is bound" from "the owner has no
 * background agents", because those are very different situations for the
 * person reading the reply.
 */
export function buildAgentsEmptyMessage(
  fleet: AgentFleet | null | undefined,
  hasOwner: boolean,
): string {
  if (!hasOwner) {
    return (
      "ℹ️ No OptChat owner is bound to this session.\n" +
      "The agent list is only available when OptChat runs in this same Pi process " +
      "with a profile open."
    );
  }
  if (fleet?.pending) {
    return "ℹ️ The agent list is not available yet — try again in a moment.";
  }
  if (!fleet || fleet.agents.length === 0) {
    const profile = clean(fleet?.profile);
    return profile
      ? `ℹ️ No background agents in the "${sanitize(profile)}" profile.`
      : "ℹ️ No background agents in this profile.";
  }
  return "ℹ️ No background agents.";
}

/**
 * Normalize a raw fleet into a render-ready view.
 *
 * `null` (no owner) and an empty fleet are distinguished by the `empty`
 * field, which carries the message to show instead of the rows.
 */
export function buildAgentFleetView(
  fleet: AgentFleet | null | undefined,
  hasOwner: boolean,
): AgentFleetView {
  const profile = clean(fleet?.profile) ?? null;
  const counts: AgentCounts = fleet?.counts ?? {
    active: 0,
    paused: 0,
    handingOff: 0,
    total: 0,
    omitted: 0,
  };

  const agents = Array.isArray(fleet?.agents) ? fleet!.agents : [];

  if (agents.length === 0) {
    return {
      profile,
      headline: hasOwner ? buildHeadline(counts) : "no OptChat owner",
      rows: [],
      omitted: num(counts.omitted) ?? 0,
      truncated: false,
      empty: buildAgentsEmptyMessage(fleet, hasOwner),
    };
  }

  const visible = agents.slice(0, AGENTS_ROW_LIMIT);
  const rows: AgentViewRow[] = visible.map((agent) => {
    // The run id is an opaque identifier, not prose: it is shortened with a
    // plain slice (no ellipsis) so it stays copy-pasteable.
    const runId = clean(agent.runId) ?? "unknown";
    return {
      runId: runId.length > AGENTS_RUN_ID_LENGTH ? runId.slice(0, AGENTS_RUN_ID_LENGTH) : runId,
      state: clean(agent.state) ?? "unknown",
      model: clean(agent.model),
      elapsed: clean(agent.elapsed),
      currentTool: clean(agent.currentTool),
      depth: num(agent.depth),
      handingOff: agent.handingOff === true,
    };
  });

  return {
    profile,
    headline: buildHeadline(counts),
    rows,
    omitted: num(counts.omitted) ?? 0,
    truncated: rows.length < agents.length,
    empty: null,
  };
}

/**
 * Render one agent row as a single readable line.
 *
 * The format is fixed and compact: `id · state · model · elapsed · tool`.
 * Missing parts are simply left out — a line never shows a placeholder for
 * something that is merely unknown.
 */
export function formatAgentRow(row: AgentViewRow): string {
  const parts: string[] = [];

  parts.push(`\`${row.runId}\``);
  parts.push(row.handingOff ? `${row.state} (handoff pending)` : row.state);

  const model = clean(row.model);
  if (model) parts.push(model);

  const elapsed = clean(row.elapsed);
  if (elapsed) parts.push(elapsed);

  const tool = clean(row.currentTool);
  if (tool) parts.push(`🔧 ${tool}`);

  const depth = num(row.depth);
  if (depth !== null) parts.push(`depth ${depth}`);

  return sanitize(parts.join(" · "));
}

/**
 * Build the plain embed payload for the fleet.
 *
 * Respects Discord's limits: ≤25 fields, field value ≤1024 chars,
 * description ≤4096 chars, title ≤256 chars.
 */
export function buildAgentFleetEmbed(view: AgentFleetView): AgentEmbed {
  const descriptionParts: string[] = [view.headline];
  if (view.profile) descriptionParts.push(`profile: ${sanitize(view.profile)}`);
  if (view.empty) descriptionParts.push(view.empty);

  const fields: { name: string; value: string; inline: boolean }[] = [];

  for (const row of view.rows) {
    fields.push({
      name: truncate(`${row.state}`, AGENTS_EMBED_FIELD_NAME_MAX),
      value: truncate(formatAgentRow(row), AGENTS_EMBED_FIELD_VALUE_MAX),
      inline: false,
    });
  }

  if (view.omitted > 0) {
    fields.push({
      name: "Omitted",
      value: truncate(
        `${view.omitted} more run${view.omitted === 1 ? "" : "s"} not shown`,
        AGENTS_EMBED_FIELD_VALUE_MAX,
      ),
      inline: false,
    });
  }

  if (view.truncated) {
    fields.push({
      name: "Truncated",
      value: truncate(`Only the first ${AGENTS_ROW_LIMIT} runs are listed`, AGENTS_EMBED_FIELD_VALUE_MAX),
      inline: false,
    });
  }

  const active = view.rows.some((row) => row.state === "running");

  return {
    title: truncate(AGENTS_EMBED_TITLE, 256),
    description: truncate(descriptionParts.join("\n"), AGENTS_EMBED_DESCRIPTION_MAX),
    fields: fields.slice(0, AGENTS_EMBED_MAX_FIELDS),
    color: active ? AGENTS_COLOR_ACTIVE : AGENTS_COLOR_IDLE,
  };
}

/** Plain-text rendering of the same content (logs / non-embed contexts). */
export function formatAgentFleetText(view: AgentFleetView): string {
  const lines: string[] = [view.headline];
  if (view.profile) lines.push(`profile: ${view.profile}`);
  if (view.empty) {
    lines.push(view.empty);
    return lines.join("\n");
  }
  for (const row of view.rows) lines.push(formatAgentRow(row));
  if (view.omitted > 0) lines.push(`${view.omitted} more runs not shown`);
  if (view.truncated) lines.push(`only the first ${AGENTS_ROW_LIMIT} runs are listed`);
  return lines.join("\n");
}
