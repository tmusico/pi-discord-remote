/**
 * Pure status view model for the Discord `/pi-status` slash command.
 *
 * Deliberately free of any discord.js import: this module is plain data +
 * formatting so it can be unit-tested without a Discord connection
 * (see `extensions/__tests__/status.test.ts`).
 */

import { basename } from "node:path";

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Canonical session states reported by `/pi-status`.
 *
 * `waiting` has priority over `working`: once the agent is blocked on a
 * Discord answer it is no longer "working", so the caller resolves the
 * state *before* calling {@link buildStatusView}.
 */
export type SessionState = "no_session" | "idle" | "working" | "waiting" | "error";

/** Raw snapshot of everything `/pi-status` knows about the live session. */
export interface StatusState {
  /** Current state. Missing/null is treated as `"no_session"`. */
  state?: SessionState | null;
  /** Full model id, e.g. `"openai-codex/gpt-6.1-sol"`. */
  modelId?: string | null;
  /** Friendly model name, e.g. `"GPT-6.1 Sol"`. */
  modelName?: string | null;
  /** Model provider, e.g. `"openai-codex"`. */
  modelProvider?: string | null;
  /** Thinking level, e.g. `"high"`. */
  thinkingLevel?: string | null;
  /** Working directory of the session. */
  cwd?: string | null;
  /** Current git branch. */
  gitBranch?: string | null;
  /** Short git SHA. */
  gitSha?: string | null;
  /** Number of modified/untracked files. */
  gitDirtyCount?: number | null;
  /** Tokens currently used in the context window. */
  contextTokens?: number | null;
  /** Total size of the context window. */
  contextWindow?: number | null;
  /** Pi session id. */
  sessionId?: string | null;
  /** Pi session name. */
  sessionName?: string | null;
  /** Number of entries in the session. */
  entryCount?: number | null;
  /** Discord channel name of the session channel. */
  channelName?: string | null;
  /** Discord channel id of the session channel. */
  channelId?: string | null;
  /** Discord bot tag, e.g. `"bot#1234"`. */
  botTag?: string | null;
  /** How many reconnect attempts were made so far. */
  reconnectAttempts?: number | null;
  /** When the last prompt was injected from Discord. */
  lastPromptAt?: Date | null;
  /** When the current agent run started. */
  runStartedAt?: Date | null;
  /** Name of the last tool that ran. */
  lastToolName?: string | null;
  /**
   * Safe label of the last failed turn (used by the `"error"` state).
   *
   * This is never the provider's raw error text — only a fixed label such as
   * `"aborted"` or `"turn failed"` — so a status reply can never leak request
   * details, credentials, prompt excerpts or tool output.
   */
  errorMessage?: string | null;
  /**
   * Name of the OptChat profile that owns this session, when an OptChat
   * owner is present in the same Pi process.
   *
   * Null (and every other `optchat*` field) means "no OptChat owner" — the
   * normal case for a plain Pi session.
   */
  optchatProfile?: string | null;
  /** The main agent's phase: idle / working / responding / awaiting-input / closing. */
  optchatPhase?: string | null;
  /** The tool the main agent is running right now — a sanitized name only. */
  optchatTool?: string | null;
  /** How many tools the main agent has in flight, or null when unknown. */
  optchatToolCount?: number | null;
  /** Whether Pi reports queued (pending) user messages. */
  optchatPending?: boolean | null;
  /** How many background agents are active. */
  optchatAgentsActive?: number | null;
  /** How many background agents the profile knows about in total. */
  optchatAgentsTotal?: number | null;
}

/** One rendered embed field. */
export interface StatusViewField {
  name: string;
  value: string;
  inline: boolean;
}

/** Normalized, render-ready status snapshot. */
export interface StatusView {
  /** Canonical state the view was built from. */
  state: SessionState;
  /** One-line state headline, e.g. `"🟢 Idle — ready for instructions"`. */
  headline: string;
  /** Optional secondary hint (e.g. how to start a session). */
  hint: string | null;
  /** Ordered display fields — State, Model, Project, Context, Session, Activity, Discord. */
  fields: StatusViewField[];
  /** Discord embed color for the current state. */
  color: number;
}

/** Plain embed object — safe to pass straight to `channel.send({ embeds: [obj] })`. */
export interface StatusEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

/** Plain embed object — safe to pass straight to `channel.send({ embeds: [obj] })`. */
export interface StatusEmbed {
  title: string;
  description: string;
  fields: StatusEmbedField[];
  color: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Placeholder used whenever a value is missing. */
export const UNKNOWN = "unknown";

/** Embed title used for every status embed. */
export const EMBED_TITLE = "Pi Session Status";

/** Discord limits (see https://discord.com/developers/docs/resources/channel). */
export const EMBED_TITLE_MAX = 256;
export const EMBED_DESCRIPTION_MAX = 4096;
export const EMBED_FIELD_NAME_MAX = 256;
export const EMBED_FIELD_VALUE_MAX = 1024;
export const EMBED_MAX_FIELDS = 25;

/** Embed color per state (decimal integers). */
export const STATE_COLORS: Record<SessionState, number> = {
  no_session: 0xf59e0b, // amber
  idle: 0x22c55e, // green
  working: 0xef4444, // red
  waiting: 0xeab308, // yellow
  error: 0xdc2626, // dark red
};

/** Short human label per state (used for the "State" field). */
const STATE_LABELS: Record<SessionState, string> = {
  no_session: "No session",
  idle: "Idle",
  working: "Working",
  waiting: "Waiting for your answer",
  error: "Error",
};

/** Headline per state. `working` gets its elapsed time appended separately. */
const STATE_HEADLINES: Record<SessionState, string> = {
  no_session: "🟠 No Pi session connected",
  idle: "🟢 Idle — ready for instructions",
  working: "🔴 Working",
  waiting: "⏸ Waiting for your answer to a question",
  error: "⚠️ Error",
};

/** Hint shown when no Pi session is bound (hub mode). */
const NO_SESSION_HINT =
  "Start a Pi session with /pi-discord-remote start to see live status.";

// ─── Small helpers ───────────────────────────────────────────────────────────

/**
 * Replace JS artifacts ("undefined", "NaN", "null") with "unknown" so a
 * rendered value never leaks an internal placeholder.
 */
function sanitize(raw: string): string {
  return raw.replace(/\bundefined\b|\bNaN\b|\bnull\b/g, UNKNOWN);
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

/** Valid Date, or null. */
function date(raw: unknown): Date | null {
  return raw instanceof Date && Number.isFinite(raw.getTime()) ? raw : null;
}

/** Truncate to `max` characters, appending an ellipsis when shortened. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Format a token count: 42100 → "42.1k", 200000 → "200k". */
function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  const k = value / 1000;
  const fixed = k.toFixed(1);
  return fixed.endsWith(".0") ? `${fixed.slice(0, -2)}k` : `${fixed}k`;
}

/** Compact duration: 42000ms → "42s", 5min → "5m", 2h → "2h". */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return UNKNOWN;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Relative time: "12m ago", "3h ago", "2d ago". */
function formatRelative(when: Date, now: Date): string {
  const diff = now.getTime() - when.getTime();
  if (!Number.isFinite(diff)) return UNKNOWN;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ─── Per-field builders ──────────────────────────────────────────────────────

function buildModelValue(state: StatusState): string | null {
  const id = clean(state.modelId);
  const name = clean(state.modelName);
  const provider = clean(state.modelProvider);
  const thinking = clean(state.thinkingLevel);

  let label = id ?? name ?? provider ?? null;
  if (label && provider && !label.includes(provider)) {
    label = `${provider}/${label}`;
  }
  if (!label && !thinking) return null;

  const parts: string[] = [label ?? UNKNOWN];
  if (thinking) parts.push(`thinking: ${thinking}`);
  return sanitize(parts.join(" · "));
}

function buildProjectValue(state: StatusState): string | null {
  const cwd = clean(state.cwd);
  const branch = clean(state.gitBranch);
  const sha = clean(state.gitSha);
  const dirty = num(state.gitDirtyCount);

  const gitBits: string[] = [];
  if (branch) gitBits.push(branch);
  if (sha) gitBits.push(`@ ${sha}`);
  if (dirty !== null && dirty > 0) {
    gitBits.push(`(${dirty} ${dirty === 1 ? "file" : "files"} dirty)`);
  }
  const hasGit = gitBits.length > 0;

  // Nothing known at all → the whole field is unknown → skip it.
  if (!cwd && !hasGit) return null;

  const project = cwd ? basename(cwd) : UNKNOWN;
  const git = hasGit ? gitBits.join(" ") : "not a git repo";
  return sanitize(`${project} · ${git}`);
}

function buildContextValue(state: StatusState): string | null {
  const tokens = num(state.contextTokens);
  const windowSize = num(state.contextWindow);
  if (tokens === null && windowSize === null) return null;

  if (tokens !== null && windowSize !== null) {
    const percent =
      windowSize > 0 ? Math.min(100, Math.round((tokens / windowSize) * 100)) : null;
    const base = `${formatTokenCount(tokens)} / ${formatTokenCount(windowSize)} tokens`;
    return sanitize(percent === null ? base : `${base} (${percent}%)`);
  }
  if (tokens !== null) return sanitize(`${formatTokenCount(tokens)} tokens`);
  return sanitize(`unknown / ${formatTokenCount(windowSize as number)} tokens`);
}

function buildSessionValue(state: StatusState): string | null {
  const id = clean(state.sessionId);
  const name = clean(state.sessionName);
  const entries = num(state.entryCount);

  const parts: string[] = [];
  if (id) parts.push(id.slice(0, 7));
  if (name) parts.push(name);
  if (entries !== null) parts.push(`${entries} ${entries === 1 ? "entry" : "entries"}`);
  if (parts.length === 0) return null;
  return sanitize(parts.join(" · "));
}

function buildActivityValue(state: StatusState, now: Date): string | null {
  const parts: string[] = [];

  const lastPrompt = date(state.lastPromptAt);
  if (lastPrompt) parts.push(`last prompt ${formatRelative(lastPrompt, now)}`);

  const runStarted = date(state.runStartedAt);
  if (runStarted) {
    parts.push(`running for ${formatDuration(now.getTime() - runStarted.getTime())}`);
  }

  const tool = clean(state.lastToolName);
  if (tool) parts.push(`last tool ${tool}`);

  if (parts.length === 0) return null;
  return sanitize(parts.join(" · "));
}

function buildDiscordValue(state: StatusState): string | null {
  const parts: string[] = [];

  const channelName = clean(state.channelName);
  const channelId = clean(state.channelId);
  if (channelName) parts.push(`#${channelName}`);
  else if (channelId) parts.push(`channel ${channelId}`);

  const tag = clean(state.botTag);
  if (tag) parts.push(`as ${tag}`);

  const attempts = num(state.reconnectAttempts);
  if (attempts !== null) parts.push(`reconnect attempts ${attempts}`);

  if (parts.length === 0) return null;
  return sanitize(parts.join(" · "));
}

/**
 * Render the OptChat owner's view of this session.
 *
 * Entirely optional: when no OptChat owner is present every field is unknown
 * and the whole field is dropped, so the status reply looks exactly as it did
 * before this integration existed.
 */
function buildOptchatValue(state: StatusState): string | null {
  const parts: string[] = [];

  const profile = clean(state.optchatProfile);
  if (profile) parts.push(profile);

  const phase = clean(state.optchatPhase);
  if (phase) parts.push(phase);

  const tool = clean(state.optchatTool);
  const toolCount = num(state.optchatToolCount);
  if (tool) {
    // The count is the number of observed tools; the tool itself is one of
    // them, so only the *extra* ones are worth mentioning.
    parts.push(toolCount !== null && toolCount > 1 ? `${tool} (+${toolCount - 1})` : tool);
  }

  const active = num(state.optchatAgentsActive);
  const total = num(state.optchatAgentsTotal);
  if (total !== null) {
    if (active !== null && active !== total) parts.push(`${active}/${total} agents`);
    else parts.push(`${total} agent${total === 1 ? "" : "s"}`);
  }

  if (state.optchatPending === true) parts.push("pending");

  if (parts.length === 0) return null;
  return sanitize(parts.join(" · "));
}

// ─── View builder ────────────────────────────────────────────────────────────

function normalizeState(raw: unknown): SessionState {
  return raw === "idle" ||
    raw === "working" ||
    raw === "waiting" ||
    raw === "error" ||
    raw === "no_session"
    ? raw
    : "no_session";
}

/**
 * Normalize a raw {@link StatusState} into a render-ready {@link StatusView}.
 *
 * Missing values become `"unknown"`; fields where *every* value is unknown
 * are dropped entirely.
 */
export function buildStatusView(state: StatusState): StatusView {
  const snapshot: StatusState = state ?? {};
  const current = normalizeState(snapshot.state);
  const now = new Date();

  // Headline (+ hint) for the current state.
  let headline = STATE_HEADLINES[current];
  let hint: string | null = null;

  if (current === "no_session") {
    hint = NO_SESSION_HINT;
  } else if (current === "working") {
    const runStarted = date(snapshot.runStartedAt);
    if (runStarted) {
      const elapsed = formatDuration(now.getTime() - runStarted.getTime());
      if (elapsed !== UNKNOWN) headline = `${headline} — ${elapsed}`;
    }
  } else if (current === "error") {
    const message = clean(snapshot.errorMessage);
    if (message) headline = `${headline} — ${sanitize(message)}`;
  }

  const fields: StatusViewField[] = [];
  const push = (name: string, value: string | null): void => {
    if (value === null) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    fields.push({ name, value: trimmed, inline: false });
  };

  push("State", sanitize(STATE_LABELS[current]));
  push("Model", buildModelValue(snapshot));
  push("Project", buildProjectValue(snapshot));
  push("Context", buildContextValue(snapshot));
  push("Session", buildSessionValue(snapshot));
  push("Activity", buildActivityValue(snapshot, now));
  push("OptChat", buildOptchatValue(snapshot));
  push("Discord", buildDiscordValue(snapshot));

  return {
    state: current,
    headline: sanitize(headline),
    hint: hint ? sanitize(hint) : null,
    fields,
    color: STATE_COLORS[current],
  };
}

// ─── Renderers ───────────────────────────────────────────────────────────────

/**
 * Build a plain embed object for `channel.send({ embeds: [embed] })`.
 *
 * Respects Discord's limits: ≤25 fields, field value ≤1024 chars,
 * description ≤4096 chars, title ≤256 chars.
 */
export function buildStatusEmbed(view: StatusView): StatusEmbed {
  const descriptionParts: string[] = [view.headline];
  if (view.hint) descriptionParts.push(view.hint);

  const fields: StatusEmbedField[] = view.fields.slice(0, EMBED_MAX_FIELDS).map((field) => ({
    name: truncate(field.name, EMBED_FIELD_NAME_MAX),
    value: truncate(field.value, EMBED_FIELD_VALUE_MAX),
    inline: field.inline,
  }));

  return {
    title: truncate(EMBED_TITLE, EMBED_TITLE_MAX),
    description: truncate(descriptionParts.join("\n"), EMBED_DESCRIPTION_MAX),
    fields,
    color: view.color,
  };
}

/** Plain-text rendering of the same content (logs / non-embed contexts). */
export function formatStatusText(view: StatusView): string {
  const lines: string[] = [view.headline];
  if (view.hint) lines.push(view.hint);
  for (const field of view.fields) {
    lines.push(`${field.name}: ${field.value}`);
  }
  return lines.join("\n");
}
