/**
 * pi-discord-remote — control this Pi session from Discord
 *
 * Each /pi-discord-remote start creates a fresh text channel named after the
 * current working directory + date (e.g. "kaleidoscope-may09").  On stop
 * (or session shutdown) the channel is deleted to stay within Discord's
 * per-server channel limit.
 *
 * Bot permissions required:
 *   • Read/Send Messages, Add Reactions  (existing)
 *   • Manage Channels                    (new — for create + rename)
 *
 * Commands:
 *   /pi-discord-remote setup       — interactive setup (token, guildId, categoryId, allowed users)
 *   /pi-discord-remote start       — create channel + connect
 *   /pi-discord-remote stop        — delete channel, stay online for /pi-status (hub mode)
 *   /pi-discord-remote disconnect  — delete channel + disconnect completely
 *   /pi-discord-remote status      — show connection state
 *   /pi-discord-remote open-config — edit config.json in the editor
 *
 * Discord slash command (guild-scoped, ephemeral replies):
 *   /pi-status                     — live snapshot of the Pi session
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Client,
  ChannelType,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from "discord.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { execFile } from "node:child_process";

import { loadConfig, saveConfig, CONFIG_FILE, defaultConfigTemplate } from "./config.js";
import type { Config } from "./config.js";
import {
  makeChannelName,
  splitMessage,
  toolLabel,
  isAbortLikeError,
  sleep,
  withTimeout,
} from "./helpers.js";
import { buildStatusView, type SessionState, type StatusState } from "./status.js";
import {
  handlePiStatusInteraction,
  registerPiStatusCommand,
  PI_STATUS_COMMAND_NAME,
} from "./slash.js";

// ─── Reconnection constants ──────────────────────────────────────────────────
const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
const RECONNECT_MAX_ATTEMPTS = 10;

// ─── Git lookup constants (for /pi-status) ───────────────────────────────────
/** Hard timeout of a single git invocation. */
const GIT_TIMEOUT_MS = 2_000;
/** How long a git snapshot is reused before it is looked up again. */
const GIT_CACHE_TTL_MS = 5_000;

// ─── Status helpers (pure — unit-tested) ─────────────────────────────────────

/**
 * Signals the `/pi-status` state machine is based on.
 *
 * The precedence is fixed: `waiting` > `error` > `working` > `idle` >
 * `no_session`. An outstanding Discord question blocks every other state, a
 * failed (or aborted) turn outranks "still working", and `no_session` is
 * only reported when nothing else applies and no session channel is bound.
 */
export interface SessionStateInput {
  /** Is a Pi session bound (i.e. does an active session channel exist)? */
  hasSession: boolean;
  /** Is an answer to a `discord_ask_user_question` outstanding? */
  questionPending: boolean;
  /** Did the Discord reconnect give up? */
  reconnectFailed: boolean;
  /** Safe label of the last failed turn (null = the last turn was fine). */
  lastError: string | null;
  /** Is the agent currently running a turn? */
  agentBusy: boolean;
}

/** Resolve the canonical `/pi-status` state from the tracked signals. */
export function resolveSessionState(input: SessionStateInput): SessionState {
  if (input.questionPending) return "waiting";
  if (input.reconnectFailed || input.lastError) return "error";
  if (input.agentBusy) return "working";
  if (input.hasSession) return "idle";
  return "no_session";
}

/** Git information of the session's project directory. */
export interface GitStatusInfo {
  /** Current branch (null = unknown / not a git repo). */
  branch: string | null;
  /** Short commit SHA (null = unknown / not a git repo). */
  sha: string | null;
  /** Changed files (null = unknown, 0 = clean working tree). */
  dirtyCount: number | null;
}

/**
 * Parse the output of `git status --porcelain=v2 --branch`.
 *
 * The single invocation yields the branch, the commit oid and the changed
 * entries:
 *
 * ```
 * # branch.oid 4bea19a1c0...
 * # branch.head main
 * # branch.upstream origin/main
 * # branch.ab +0 -0
 * 1 .M N... 100644 100644 100644 <sha> <sha> src/App.tsx
 * ? untracked.txt
 * ```
 *
 * * branch  — the `# branch.head` value (`"(detached)"` for a detached HEAD)
 * * sha     — the `# branch.oid` value, shortened to 7 chars (`null` for an
 *             unborn branch, whose oid is `"(initial)"`)
 * * dirty   — the number of non-empty lines that do not start with `#`
 *
 * An empty output (or a `fatal:` line) means git failed — everything is
 * unknown.
 */
export function parseGitStatusV2(output: string): GitStatusInfo {
  const unknown: GitStatusInfo = { branch: null, sha: null, dirtyCount: null };
  if (typeof output !== "string" || output.trim().length === 0) return unknown;

  let branch: string | null = null;
  let sha: string | null = null;
  let dirtyCount = 0;
  let sawEntry = false;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line.startsWith("#")) {
      const match = /^#\s+branch\.(head|oid)\s+(\S+)/.exec(line);
      if (!match) continue;
      const value = match[2];
      if (match[1] === "head") {
        branch = value;
      } else {
        // "(initial)" = an unborn branch — there is no commit yet.
        sha = value === "(initial)" ? null : value.slice(0, 7);
      }
      continue;
    }

    // git failed (e.g. "fatal: not a git repository") — nothing is known.
    if (line.startsWith("fatal:")) return unknown;

    dirtyCount++;
    sawEntry = true;
  }

  if (branch === null && sha === null && !sawEntry) return unknown;
  return { branch, sha, dirtyCount };
}

/** Run one git command — resolves to null when git is missing or fails. */
function runGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        args,
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          resolve(typeof stdout === "string" ? stdout : null);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Look up branch / sha / dirty count of `cwd` (never throws).
 *
 * Exactly **one** git invocation is used — `git status --porcelain=v2
 * --branch` — which keeps the lookup inside the plan's "≤2 invocations" bound.
 *
 * `runner` is a test seam: it receives the git arguments and resolves to the
 * command output (or `null` when the command failed).
 */
export async function collectGitInfo(
  cwd: string,
  runner: (args: string[]) => Promise<string | null> = (args) => runGit(args, cwd),
): Promise<GitStatusInfo> {
  try {
    const output = await runner(["status", "--porcelain=v2", "--branch"]);
    if (output === null || output === undefined) {
      return { branch: null, sha: null, dirtyCount: null };
    }
    return parseGitStatusV2(output);
  } catch {
    return { branch: null, sha: null, dirtyCount: null };
  }
}

/**
 * Safe label of an aborted turn (the only labels ever rendered in Discord).
 */
const TURN_FAILURE_ABORTED = "aborted";

/**
 * Safe label of a failed turn (the only labels ever rendered in Discord).
 */
const TURN_FAILURE_ERROR = "turn failed";

/** Does the raw provider text look like an aborted turn? */
function looksAborted(text: string): boolean {
  return text.toLowerCase().includes("abort");
}

/**
 * Describe how the last agent run ended.
 *
 * Returns a **fixed safe label** when the run failed or was aborted and
 * `null` when it ended normally.
 *
 * The provider's raw `errorMessage` is deliberately *not* returned: it can
 * contain request details, credentials, prompt excerpts or tool output, and
 * this value is rendered in Discord. The raw text stays in the local log
 * (see the `agent_end` handler).
 */
export function describeTurnFailure(event: unknown): string | null {
  try {
    const messages = (event as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as {
        role?: unknown;
        stopReason?: unknown;
        errorMessage?: unknown;
      };
      if (!message || message.role !== "assistant") continue;

      const stopReason =
        typeof message.stopReason === "string" ? message.stopReason.trim() : "";
      const errorMessage =
        typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";

      // `stopReason` is a closed enum — map it to a fixed label.
      if (stopReason === "aborted") return TURN_FAILURE_ABORTED;
      if (stopReason === "error") return TURN_FAILURE_ERROR;

      // A provider error without an explicit "error" stop reason is still a
      // failed turn. Only its *classification* is used — never its text.
      if (errorMessage.length > 0) {
        return looksAborted(errorMessage) ? TURN_FAILURE_ABORTED : TURN_FAILURE_ERROR;
      }

      // The last assistant message ended normally — the run was fine.
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The raw provider error text of the last assistant message.
 *
 * Used for the **local** log only — it is never rendered in Discord and never
 * part of the status snapshot.
 */
function rawTurnErrorDetail(event: unknown): string | null {
  try {
    const messages = (event as { messages?: unknown })?.messages;
    if (!Array.isArray(messages)) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as { role?: unknown; errorMessage?: unknown };
      if (!message || message.role !== "assistant") continue;
      const text = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
      return text.length > 0 ? text : null;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Context readers (stale-ctx safe — unit-tested) ──────────────────────────

/**
 * Remove a secret from a local log line.
 *
 * Returns `null` when the text cannot be redacted (no secret known), so the
 * caller can suppress the detail instead of printing it unredacted.
 */
export function redactSecret(text: string, token: string | null): string | null {
  if (typeof text !== "string") return null;
  const secret = token?.trim();
  if (!secret) return null;
  const withoutSecret = text.split(secret).join("***");
  return withoutSecret.length > 500 ? `${withoutSecret.slice(0, 500)}…` : withoutSecret;
}

/** Call `fn` defensively — a captured ctx throws after a session reload. */
function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Context usage of a live session (null when unavailable).
 *
 * Accepts any ctx-like object: a stale ctx (one that throws after
 * `ctx.newSession()` / `ctx.reload()`) degrades to the null fallback instead
 * of throwing inside a Discord interaction.
 */
export function readContextUsageSafe(ctx: unknown): {
  tokens: number | null;
  contextWindow: number | null;
} {
  const empty = { tokens: null, contextWindow: null };
  if (!ctx) return empty;
  const usage = safeCall(
    () => (ctx as { getContextUsage?: () => unknown }).getContextUsage?.(),
    undefined,
  );
  if (!usage || typeof usage !== "object") return empty;
  const u = usage as { tokens?: unknown; contextWindow?: unknown };
  return {
    tokens: typeof u.tokens === "number" && Number.isFinite(u.tokens) ? u.tokens : null,
    contextWindow:
      typeof u.contextWindow === "number" && Number.isFinite(u.contextWindow)
        ? u.contextWindow
        : null,
  };
}

/**
 * Identity of a live session (null when unavailable).
 *
 * Like {@link readContextUsageSafe} this never throws on a stale ctx.
 */
export function readSessionIdentitySafe(ctx: unknown): {
  id: string | null;
  name: string | null;
  entries: number | null;
} {
  const empty = { id: null, name: null, entries: null };
  if (!ctx) return empty;
  const manager = safeCall(() => (ctx as { sessionManager?: unknown }).sessionManager, undefined);
  if (!manager || typeof manager !== "object") return empty;

  const m = manager as {
    getSessionId?: () => unknown;
    getSessionName?: () => unknown;
    getEntries?: () => unknown;
  };
  const id = safeCall(() => m.getSessionId?.(), null);
  const name = safeCall(() => m.getSessionName?.() ?? null, null);
  const entries = safeCall(() => {
    const list = m.getEntries?.();
    return Array.isArray(list) ? list.length : null;
  }, null);

  return {
    id: typeof id === "string" && id.length > 0 ? id : null,
    name: typeof name === "string" && name.length > 0 ? name : null,
    entries: typeof entries === "number" ? entries : null,
  };
}

/**
 * Is the agent idle? (null when the ctx is stale/unavailable).
 *
 * Like {@link readContextUsageSafe} this never throws on a stale ctx.
 */
export function readAgentIdleSafe(ctx: unknown): boolean | null {
  if (!ctx) return null;
  const idle = safeCall(() => (ctx as { isIdle?: () => unknown }).isIdle?.(), null);
  return typeof idle === "boolean" ? idle : null;
}

// ─── Setup config (pure — unit-tested) ──────────────────────────────────────

/** Answers of the interactive `/pi-discord-remote setup` prompts. */
export interface SetupConfigInputs {
  token: string;
  guildId: string;
  categoryId?: string;
  allowedUserIds?: string[];
  toolResponses?: boolean;
}

/**
 * Build the configuration written by `/pi-discord-remote setup`.
 *
 * `keepOnline` is preserved from the existing config: re-running setup for an
 * unrelated change must not silently reset a user's `keepOnline: false`.
 */
export function buildSetupConfig(
  existing: Config | null,
  inputs: SetupConfigInputs,
): Config {
  const { token, guildId, categoryId, allowedUserIds } = inputs;
  return {
    token,
    guildId,
    ...(categoryId ? { categoryId } : {}),
    ...(allowedUserIds ? { allowedUserIds } : {}),
    reactions: true,
    toolResponses: inputs.toolResponses === true,
    keepOnline: existing?.keepOnline !== false,
  };
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  /** Mutable runtime state — never persisted to disk. */
  interface RuntimeState {
    /** The channel ID this session is listening on (created or fallback). */
    activeChannelId: string | null;
    /** Channel name at creation time (for display). */
    sessionChannelName: string | null;
  }

  let client: Client | null = null;
  let activeConfig: Config | null = null;
  const runtime: RuntimeState = { activeChannelId: null, sessionChannelName: null };

  let agentBusy = false;
  let pendingReplyChannelId: string | null = null;
  let pendingReplyUserId: string | null = null;
  let collectedAssistantText: string[] = [];
  let postedThinkingNotice = false;
  let lastImageArtifactPath: string | null = null;

  // ── Status tracking (for the /pi-status slash command) ────────────────
  /** Model of the current session (updated by the `model_select` event). */
  let activeModel: { provider?: string; id?: string; name?: string } | null = null;
  /** When the current agent run started (null = no run in flight). */
  let runStartedAt: Date | null = null;
  /** Name of the tool that is currently executing (null = none). */
  let lastToolName: string | null = null;
  /** When the last Discord prompt was injected into the session. */
  let lastPromptAt: Date | null = null;
  /** Safe label of the last failed turn (null = the last turn was fine). */
  let lastError: string | null = null;
  /** Working directory of the Discord session (captured on connect). */
  let sessionCwd: string | null = null;
  /** Captured extension context — becomes stale after a session reload. */
  let capturedCtx: ExtensionContext | null = null;
  /** Cached git snapshot (branch / sha / dirty count). */
  let gitCache: { at: number; cwd: string; info: GitStatusInfo } | null = null;
  /**
   * The bot token, kept ONLY so it can be redacted from local log lines.
   *
   * It deliberately outlives `activeConfig`: a turn can fail after
   * `disconnect` / `session_shutdown`, and the redaction must still work
   * then. It is never sent to Discord.
   */
  let redactionToken: string | null = null;
  /**
   * Is the current Discord session still wanted?
   *
   * Guards the connect race: in hub mode `stop` keeps the client alive, so a
   * `ready` event that arrives after the stop must not create a channel.
   */
  let sessionActive = false;

  // ── Reconnection state ────────────────────────────────────────────────
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let isShuttingDown = false;
  let reconnectFailed = false;
  // Captured at connect time so reconnect can reuse them
  let connectNotify: ((msg: string, level: "success" | "error" | "warning" | "info") => void) | null = null;
  let connectSetStatus: ((key: string, val: string | undefined) => void) | null = null;

  // ── Question-answering state (for overriding ask_user_question) ────────
  let questionResolver: ((answer: string) => void) | null = null;
  let questionRejecter: ((reason: Error) => void) | null = null;
  let questionChannelId: string | null = null;
  let questionTimeout: ReturnType<typeof setTimeout> | null = null;
  let questionAbortListener: (() => void) | null = null;
  let questionAbortSignal: AbortSignal | null = null;

  function clearQuestionState(): void {
    if (questionTimeout) {
      clearTimeout(questionTimeout);
      questionTimeout = null;
    }
    // Remove abort listener to prevent leak
    if (questionAbortListener && questionAbortSignal) {
      questionAbortSignal.removeEventListener("abort", questionAbortListener);
    }
    questionAbortListener = null;
    questionAbortSignal = null;
    questionResolver = null;
    questionRejecter = null;
    questionChannelId = null;
  }

  /**
   * Clear everything that belongs to the current Pi session.
   *
   * Used by `stop`, `disconnect` and `session_shutdown` so that a following
   * session never inherits the state of the previous one. The Discord
   * connection itself is *not* touched — that is what makes hub mode work.
   */
  function clearSessionState(): void {
    pendingReplyChannelId = null;
    pendingReplyUserId = null;
    collectedAssistantText = [];
    agentBusy = false;
    runStartedAt = null;
    lastToolName = null;
    lastError = null;
  }

  /** Abort a pending Discord question (if any) so no turn hangs. */
  function cancelPendingQuestion(): void {
    if (questionRejecter) {
      questionRejecter(new Error("Session ended"));
    }
    clearQuestionState();
  }

  // ── Shared send helpers ──────────────────────────────────────────────────

  async function sendToActiveChannel(text: string): Promise<void> {
    if (!client || !pendingReplyChannelId) return;
    try {
      const channel = (await client.channels.fetch(pendingReplyChannelId)) as TextChannel | null;
      if (!channel?.isTextBased()) return;
      await (channel as TextChannel).send(text);
    } catch (err) {
      console.error("[pi-discord-remote] Failed to send message:", err);
    }
  }

  function getTargetChannelId(overrideChannelId?: string): string | null {
    const override = overrideChannelId?.trim();
    return override || runtime.activeChannelId || activeConfig?.channelId || pendingReplyChannelId || null;
  }

  async function sendMessageViaDiscordRest(params: {
    channelId: string;
    token: string;
    content?: string;
    filename?: string;
    mediaType?: string;
    bytes?: Buffer;
  }): Promise<{ ok: boolean; error?: string }> {
    const url = `https://discord.com/api/v10/channels/${params.channelId}/messages`;
    const form = new FormData();

    if (params.bytes) {
      const fileName = params.filename ?? "image.png";
      const type = params.mediaType ?? "image/png";
      const payload = {
        content: params.content ?? "",
        attachments: [{ id: 0, filename: fileName }],
      };
      form.append("payload_json", JSON.stringify(payload));
      form.append("files[0]", new Blob([new Uint8Array(params.bytes)], { type }), fileName);
    } else {
      form.append("content", params.content ?? "");
    }

    const resp = await withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bot ${params.token}`,
        },
        body: form,
      }),
      20_000,
      "discord_rest_send",
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      if (resp.status === 404) return { ok: false, error: `unknown_channel:${params.channelId}` };
      return { ok: false, error: `discord_http_${resp.status}:${body.slice(0, 200)}` };
    }

    return { ok: true };
  }

  async function sendAttachmentToActiveChannel(params: {
    channelId?: string;
    path?: string;
    url?: string;
    base64?: string;
    mediaType?: string;
    filename?: string;
    caption?: string;
  }): Promise<{ ok: boolean; sentAs?: string; error?: string }> {
    const targetChannelId = getTargetChannelId(params.channelId);
    if (!client?.isReady()) {
      return { ok: false, error: "discord_not_connected" };
    }
    if (!targetChannelId) {
      return { ok: false, error: "no_active_channel" };
    }

    const sendOnce = async (): Promise<{ ok: boolean; sentAs?: string; error?: string }> => {
      const channel = (await withTimeout(
        client!.channels.fetch(targetChannelId),
        15_000,
        "fetch_channel",
      )) as TextChannel | null;
      if (!channel?.isTextBased()) return { ok: false, error: "channel_unavailable" };
      if (activeConfig?.guildId && "guildId" in channel && channel.guildId !== activeConfig.guildId) {
        return { ok: false, error: `wrong_guild:${targetChannelId}` };
      }

      const content = params.caption?.trim() || undefined;
      const token = activeConfig?.token?.trim();
      if (!token) return { ok: false, error: "missing_bot_token" };

      if (params.path) {
        const filePath = params.path.trim();
        if (!existsSync(filePath)) return { ok: false, error: `file_not_found:${filePath}` };
        const buffer = await withTimeout(readFile(filePath), 5_000, "read_file");
        const name = params.filename?.trim() || basename(filePath);
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content,
          filename: name,
          mediaType: "image/png",
          bytes: buffer,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_path_failed" };
        return { ok: true, sentAs: "path" };
      }

      if (params.url) {
        const body = content ? `${content}\n${params.url.trim()}` : params.url.trim();
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content: body,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_url_failed" };
        return { ok: true, sentAs: "url" };
      }

      if (params.base64) {
        const mediaType = params.mediaType?.trim() || "image/png";
        const ext = mediaType.split("/")[1] ?? "png";
        const buffer = Buffer.from(params.base64.trim(), "base64");
        const name = params.filename?.trim() || `image.${ext}`;
        const sent = await sendMessageViaDiscordRest({
          channelId: targetChannelId,
          token,
          content,
          filename: name,
          mediaType,
          bytes: buffer,
        });
        if (!sent.ok) return { ok: false, error: sent.error ?? "send_base64_failed" };
        return { ok: true, sentAs: "base64" };
      }

      return { ok: false, error: "missing_source" };
    };

    const toError = (err: any): string => {
      const msg = String(err?.message ?? "send_failed");
      const code = String(err?.code ?? "");
      if (code === "10003" || msg.toLowerCase().includes("unknown channel")) {
        return `unknown_channel:${targetChannelId}`;
      }
      return msg;
    };

    try {
      return await sendOnce();
    } catch (err: any) {
      if (isAbortLikeError(err)) {
        try {
          await sleep(300);
          return await sendOnce();
        } catch (retryErr: any) {
          return { ok: false, error: toError(retryErr) };
        }
      }
      return { ok: false, error: toError(err) };
    }
  }

  // ── Collect assistant output ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_start", async (_event: any, ctx: ExtensionContext) => {
    agentBusy = true;
    runStartedAt = new Date();
    // The captured context is refreshed on every run — an older one may have
    // been invalidated by a session replacement.
    capturedCtx = ctx;
    collectedAssistantText = [];
    postedThinkingNotice = false;
    lastImageArtifactPath = null;
  });

  // ── Session start: capture the context and seed the model ──────────────

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    capturedCtx = ctx;
    try {
      if (!sessionCwd) sessionCwd = ctx.cwd ?? null;
    } catch {
      // A context that already went stale — the tracked values stay.
    }
    const model = safeCall(() => ctx.model, undefined);
    if (model) {
      activeModel = {
        provider: typeof model.provider === "string" ? model.provider : undefined,
        id: typeof model.id === "string" ? model.id : undefined,
        name: typeof model.name === "string" ? model.name : undefined,
      };
    }
  });

  // ── Model selection: track the active model ────────────────────────────

  pi.on("model_select", async (event) => {
    const model = event.model;
    if (!model) return;
    activeModel = {
      provider: typeof model.provider === "string" ? model.provider : undefined,
      id: typeof model.id === "string" ? model.id : undefined,
      name: typeof model.name === "string" ? model.name : undefined,
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_result", async (event: any) => {
    // Capture latest browser image artifact path for follow-up discord_send_image calls.
    if (event.toolName === "agent_browser") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const artifacts: any[] = event.details?.artifacts ?? [];
      for (const artifact of artifacts) {
        if (artifact?.kind === "image") {
          const candidate = artifact.absolutePath ?? artifact.path;
          if (candidate && existsSync(candidate)) {
            lastImageArtifactPath = candidate;
          }
        }
      }
    }

    if (!pendingReplyChannelId) {
      return;
    }

    // Only send text summaries if toolResponses is enabled
    if (!activeConfig?.toolResponses) return;

    // Build a label like "↩️ bash: ..." or "↩️ read: ..."
    const emoji = event.isError ? "❌" : "↩️";
    const detailLabel = event.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => String(c.text ?? "").trim())
      .join("")
      .slice(0, 300) ?? "";

    // Send a compact summary line for each tool result
    const label = `${emoji} _${event.toolName}_`;
    if (detailLabel) {
      const truncated = detailLabel.length > 400 ? detailLabel.slice(0, 400) + "…" : detailLabel;
      await sendToActiveChannel(`${label}:\n\`\`\`\n${truncated}\n\`\`\``);
    } else {
      await sendToActiveChannel(label);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_update", async (event: any) => {
    if (!pendingReplyChannelId || postedThinkingNotice) return;
    if (event.message.role !== "assistant") return;
    const hasThinking = (event.message.content as Array<{ type: string }>)
      .some((c) => c.type === "thinking");
    if (hasThinking) {
      postedThinkingNotice = true;
      await sendToActiveChannel("💭 _Thinking…_");
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("tool_execution_start", async (event: any) => {
    lastToolName = event.toolName ?? null;
    if (!pendingReplyChannelId) return;
    // discord_ask_user_question is handled by our tool (formatted output)
    if (event.toolName === "discord_ask_user_question") return;
    await sendToActiveChannel(toolLabel(event.toolName, event.args));
  });

  pi.on("tool_execution_end", async () => {
    lastToolName = null;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("message_end", async (event: any) => {
    if (!pendingReplyChannelId) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content = event.message.content as Array<any>;

    // Collect text from assistant messages
    if (event.message.role === "assistant") {
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (text.trim()) collectedAssistantText.push(text);
    }
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pi.on("agent_end", async (event: any) => {
    agentBusy = false;
    runStartedAt = null;
    // A failed/aborted turn is surfaced as the "error" state until the next
    // successful run clears it. Only a fixed, safe label is kept — the raw
    // provider text goes to the local log only, never to Discord.
    lastError = describeTurnFailure(event);
    const failureDetail = rawTurnErrorDetail(event);
    if (failureDetail) {
      const redacted = redactToken(failureDetail);
      console.error(
        redacted === null
          ? `[pi-discord-remote] Turn failed (${lastError ?? "unknown"}) — details suppressed (no redaction key)`
          : `[pi-discord-remote] Turn failed (${lastError ?? "unknown"}): ${redacted}`,
      );
    }

    if (!pendingReplyChannelId || !client) {
      pendingReplyChannelId = null;
      collectedAssistantText = [];
      return;
    }

    const text = collectedAssistantText.join("\n\n").trim();
    // Clear state before sending so sendToActiveChannel still sees the channel ID
    collectedAssistantText = [];
    // pendingReplyChannelId cleared after send below

    if (!text) {
      pendingReplyChannelId = null;
      pendingReplyUserId = null;
      return;
    }

    const chunks = splitMessage(text);
    // Prepend a mention to the last chunk so the sender is notified when work is done
    const mention = pendingReplyUserId ? `<@${pendingReplyUserId}> ` : "";
    const lastIdx = chunks.length - 1;
    chunks[lastIdx] = mention + chunks[lastIdx];

    for (const chunk of chunks) {
      await sendToActiveChannel(chunk);
    }
    pendingReplyChannelId = null;
    pendingReplyUserId = null;
  });

  // ── Cleanup helper ───────────────────────────────────────────────────────

  async function deleteSessionChannel(
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    if (!client || !runtime.activeChannelId) return;
    try {
      const channel = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
      if (channel) await channel.delete("Pi session ended");
    } catch (err) {
      console.error("[pi-discord-remote] Failed to delete channel:", err);
    }
    runtime.activeChannelId = null;
    runtime.sessionChannelName = null;
    setStatusFn("pi-discord-remote", undefined);
  }

  // ── Reconnect logic ────────────────────────────────────────────────────────

  function clearReconnectTimer(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    clearReconnectTimer();
    reconnectAttempt++;

    if (reconnectAttempt > RECONNECT_MAX_ATTEMPTS) {
      console.error(
        `[pi-discord-remote] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached. Giving up.`,
      );
      reconnectFailed = true;
      connectNotify?.(
        `❌ Discord reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Run /pi-discord-remote start to retry.`,
        "error",
      );
      connectSetStatus?.("pi-discord-remote", "❌ Discord: reconnect failed");
      return;
    }

    // Exponential backoff with jitter: 2s, 4s, 8s, 16s, … up to 60s
    const baseDelay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_DELAY_MS);
    const jitter = Math.random() * 1_000;
    const delay = baseDelay + jitter;

    console.log(
      `[pi-discord-remote] Reconnect attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS} in ${Math.round(delay)}ms`,
    );
    connectSetStatus?.("pi-discord-remote", `🔄 Discord: reconnecting (${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})…`);

    reconnectTimer = setTimeout(async () => {
      if (isShuttingDown) return;
      await attemptReconnect();
    }, delay);
  }

  async function attemptReconnect(): Promise<void> {
    if (!activeConfig) return;

    // Destroy the old client if it still exists
    if (client) {
      await client.destroy().catch(() => {});
      client = null;
    }

    const cfg = activeConfig;
    const notify = connectNotify ?? ((_m: string, _l: any) => {});
    const setStatus = connectSetStatus ?? ((_k: string, _v: any) => {});

    console.log("[pi-discord-remote] Reconnecting to Discord…");

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on("messageCreate", buildMessageHandler());
    attachInteractionHandler(client);
    client.on("error", (err) => {
      console.error("[pi-discord-remote] Discord client error:", err);
      setStatus("pi-discord-remote", "⚠️ Discord: error");
    });
    client.on("shardDisconnect", () => {
      if (isShuttingDown) return;
      console.error("[pi-discord-remote] Discord WebSocket disconnected during reconnect, retrying…");
      setStatus("pi-discord-remote", "🔄 Discord: reconnecting…");
      scheduleReconnect();
    });

    try {
      await client.login(cfg.token);
      // Wait for ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("ready timeout")), 30_000);
        client!.once("ready", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // The guild command may have been deleted meanwhile — re-registering is
      // idempotent and never replaces the guild's other commands.
      await registerStatusCommand(client, cfg, notify, setStatus);

      // Successfully reconnected — restore channel reference
      reconnectAttempt = 0;
      const channelLabel =
        runtime.sessionChannelName ?? runtime.activeChannelId ?? "hub (no session)";
      console.log(`[pi-discord-remote] Reconnected successfully → #${channelLabel}`);
      notify(`✅ Discord reconnected → #${channelLabel}`, "success");
      setStatus("pi-discord-remote", `🔌 Discord: #${channelLabel}`);

      // Post a notice in the channel so the user knows we're back
      if (runtime.activeChannelId) {
        try {
          const ch = (await client.channels.fetch(runtime.activeChannelId)) as TextChannel | null;
          if (ch?.isTextBased()) {
            await ch.send("🔌 _Reconnected — ready for commands._").catch(() => {});
          }
        } catch {
          // Channel may have been deleted — that's fine
        }
      }
    } catch (err: any) {
      console.error("[pi-discord-remote] Reconnect failed:", err.message);
      scheduleReconnect();
    }
  }

  function buildMessageHandler() {
    return async (message: Message) => {
      if (!activeConfig) return;
      if (message.author.bot) return;
      // Without an active session channel (hub mode) no message is injected:
      // `runtime.activeChannelId` is null, so the comparison is true for
      // every real channel id.
      if (message.channelId !== runtime.activeChannelId) return;

      if (
        activeConfig.allowedUserIds?.length &&
        !activeConfig.allowedUserIds.includes(message.author.id)
      ) {
        await message.reply("❌ Your user ID is not on the allow-list.").catch(() => {});
        return;
      }

      // If waiting for a question answer, route this message to the resolver
      if (questionResolver && message.channelId === questionChannelId) {
        if (activeConfig.reactions !== false) {
          await message.react("✅").catch(() => {});
        }
        const resolve = questionResolver;
        resolve(message.content);
        return;
      }

      if (agentBusy) {
        await message.reply("⏳ Still processing the previous message — please wait.").catch(() => {});
        return;
      }

      if (activeConfig.reactions !== false) {
        await message.react("⏳").catch(() => {});
      }

      pendingReplyChannelId = message.channelId;
      pendingReplyUserId = message.author.id;
      collectedAssistantText = [];
      lastPromptAt = new Date();
      pi.sendUserMessage(message.content);
    };
  }

  /**
   * Destroy the Discord client and clear every connection-scoped value.
   *
   * Used by `disconnect`, by `stop` (when `keepOnline` is false) and when a
   * new session is started while the bot is only online for `/pi-status`.
   */
  async function teardownClient(
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    isShuttingDown = true;
    sessionActive = false;
    clearReconnectTimer();
    reconnectAttempt = 0;
    reconnectFailed = false;
    cancelPendingQuestion();
    await deleteSessionChannel(setStatusFn);
    clearSessionState();

    if (client) {
      await client.destroy().catch(() => {});
      client = null;
    }
    activeConfig = null;
    runtime.activeChannelId = null;
    runtime.sessionChannelName = null;
    connectNotify = null;
    connectSetStatus = null;
  }

  // ── Status snapshot (/pi-status) ─────────────────────────────────────────

  /**
   * Is Discord connected *and* bound to a Pi session?
   *
   * In hub mode (bot online, no session channel) the agent-facing Discord
   * features stay disabled — only `/pi-status` still works.
   */
  function hasActiveSession(): boolean {
    return Boolean(client?.isReady() && runtime.activeChannelId);
  }

  /**
   * Remove the bot token from a local log line.
   *
   * The raw turn-failure detail may contain request details — the token must
   * never end up in a log line, let alone in a Discord reply.
   *
   * `redactionToken` survives a teardown (the connection state does not), so
   * redaction still works for a turn that fails after `disconnect`. When no
   * token is known at all the detail cannot be redacted reliably, so it is
   * suppressed instead of printed.
   */
  function redactToken(text: string): string | null {
    const token = redactionToken ?? activeConfig?.token?.trim() ?? null;
    if (!token) return null;
    return redactSecret(text, token);
  }

  /** Current thinking level (null when unavailable). */
  function readThinkingLevel(): string | null {
    const level = safeCall(() => pi.getThinkingLevel(), null);
    return typeof level === "string" && level.length > 0 ? level : null;
  }

  /** Git info of the session directory, cached for a few seconds. */
  async function readGitInfo(cwd: string): Promise<GitStatusInfo> {
    const now = Date.now();
    if (gitCache && gitCache.cwd === cwd && now - gitCache.at < GIT_CACHE_TTL_MS) {
      return gitCache.info;
    }
    const info = await collectGitInfo(cwd);
    gitCache = { at: Date.now(), cwd, info };
    return info;
  }

  /**
   * Build the live snapshot rendered by `/pi-status` (and by the TUI
   * `status` command).
   *
   * Never throws: every access to the captured extension context is guarded
   * (a captured ctx throws after a session replacement or reload) and a
   * failure degrades to the values tracked by the extension itself.
   */
  async function buildStatusState(): Promise<StatusState> {
    let state: SessionState = "no_session";
    try {
      state = resolveSessionState({
        hasSession: runtime.activeChannelId !== null,
        questionPending: questionResolver !== null,
        reconnectFailed,
        lastError,
        agentBusy: agentBusy || readAgentIdleSafe(capturedCtx) === false,
      });

      const git = sessionCwd
        ? await readGitInfo(sessionCwd)
        : { branch: null, sha: null, dirtyCount: null };
      const usage = readContextUsageSafe(capturedCtx);
      const session = readSessionIdentitySafe(capturedCtx);

      return {
        state,
        modelId: activeModel?.id ?? null,
        modelName: activeModel?.name ?? null,
        modelProvider: activeModel?.provider ?? null,
        thinkingLevel: readThinkingLevel(),
        cwd: sessionCwd,
        gitBranch: git.branch,
        gitSha: git.sha,
        gitDirtyCount: git.dirtyCount,
        contextTokens: usage.tokens,
        contextWindow: usage.contextWindow,
        sessionId: session.id,
        sessionName: session.name,
        entryCount: session.entries,
        channelName: runtime.sessionChannelName,
        channelId: runtime.activeChannelId,
        botTag: client?.user?.tag ?? null,
        reconnectAttempts: reconnectAttempt,
        lastPromptAt,
        runStartedAt,
        lastToolName,
        errorMessage: lastError,
      };
    } catch (err) {
      console.error("[pi-discord-remote] Failed to build the status snapshot:", err);
      return { state, errorMessage: lastError };
    }
  }

  /**
   * Route Discord interactions to the `/pi-status` handler.
   *
   * Registered in exactly one place so both the initial connect and the
   * reconnect path get it. Every other interaction is ignored — the
   * extension never answers a command it does not know, and the
   * interaction is never injected into the Pi session.
   */
  function attachInteractionHandler(c: Client): void {
    c.on("interactionCreate", async (interaction) => {
      try {
        if (!interaction.isChatInputCommand()) return;
        if (interaction.commandName !== PI_STATUS_COMMAND_NAME) return;
        await handlePiStatusInteraction(interaction, {
          allowedUserIds: activeConfig?.allowedUserIds,
          buildState: buildStatusState,
        });
      } catch (err) {
        console.error("[pi-discord-remote] /pi-status interaction failed:", err);
      }
    });
  }

  /**
   * Register the `/pi-status` slash command in the configured guild.
   *
   * Idempotent — it edits the existing command instead of replacing the
   * guild's whole command set. A failure is never fatal: the extension keeps
   * working, it just cannot answer `/pi-status` until the bot has been
   * re-invited with the `applications.commands` scope.
   */
  async function registerStatusCommand(
    c: Client,
    cfg: Config,
    notifyFn: (msg: string, level: "success" | "error" | "warning" | "info") => void,
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    try {
      const result = await registerPiStatusCommand(c, cfg.token, cfg.guildId);
      if (result.ok) return;
      const detail = result.hint ? `${result.error} — ${result.hint}` : result.error;
      console.error(`[pi-discord-remote] Could not register /pi-status: ${detail}`);
      notifyFn(`⚠️ Could not register /pi-status: ${detail}`, "warning");
      setStatusFn("pi-discord-remote", "⚠️ Discord: /pi-status unavailable");
    } catch (err) {
      console.error("[pi-discord-remote] Could not register /pi-status:", err);
    }
  }

  // ── Session cleanup ───────────────────────────────────────────────────────

  pi.on("session_shutdown", async (event: any) => {
    // Reject any pending question so tool execution doesn't hang
    if (questionRejecter) {
      questionRejecter(new Error("Session shut down"));
    }
    clearQuestionState();
    clearReconnectTimer();
    isShuttingDown = true;
    // Don't destroy Discord client on reload — just re-register handlers
    if (event?.reason === "reload") {
      isShuttingDown = false;
      return;
    }
    if (client) {
      await deleteSessionChannel((_k, _v) => {});
      await client.destroy().catch(() => {});
      client = null;
      activeConfig = null;
      runtime.activeChannelId = null;
      runtime.sessionChannelName = null;
    }
    sessionActive = false;
    clearSessionState();
  });

  // Auto-connect removed — user must run /pi-discord-remote start explicitly.

  // ── Connect + channel-create helper ──────────────────────────────────────

  async function startClient(
    cfg: Config,
    cwd: string,
    notifyFn: (msg: string, level: "success" | "error" | "warning" | "info") => void,
    setStatusFn: (key: string, val: string | undefined) => void,
  ): Promise<void> {
    if (client) {
      notifyFn("Already connected to Discord.", "warning");
      return;
    }

    activeConfig = cfg;
    // Remember the token for log redaction only — it must survive a teardown.
    redactionToken = cfg.token?.trim() ?? null;
    isShuttingDown = false;
    reconnectAttempt = 0;
    reconnectFailed = false;
    clearReconnectTimer();

    // The project directory the session works in (used by /pi-status).
    sessionCwd = cwd;
    gitCache = null;
    sessionActive = true;

    // Capture closures for reconnect reuse
    connectNotify = notifyFn;
    connectSetStatus = setStatusFn;

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on("messageCreate", buildMessageHandler());
    attachInteractionHandler(client);

    // ── Reconnection handling (for post-connect disconnects only) ──────
    client.on("error", (err) => {
      console.error("[pi-discord-remote] Discord client error:", err);
      setStatusFn("pi-discord-remote", "⚠️ Discord: error");
    });

    client.on("shardDisconnect", () => {
      if (isShuttingDown) return;
      console.error("[pi-discord-remote] Discord WebSocket disconnected, starting reconnect…");
      setStatusFn("pi-discord-remote", "🔄 Discord: reconnecting…");
      scheduleReconnect();
    });

    // ── Await login + ready so we can surface immediate errors ─────────
    // Register the ready listener BEFORE login to avoid a race window
    // where ready fires before the Promise is constructed.
    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ready timeout (30s)")), 30_000);
      client!.once("ready", async (c) => {
        clearTimeout(timeout);
        if (!sessionActive) {
          // The session was stopped while the client was still connecting —
          // do not create a channel for it.
          resolve();
          return;
        }
        // Channel creation happens inside this single ready handler
        const channelName = makeChannelName(cwd);
        try {
          const guild = await c.guilds.fetch(cfg.guildId);
          const newChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            ...(cfg.categoryId ? { parent: cfg.categoryId } : {}),
            topic: `Pi session — ${cwd}`,
          });
          runtime.activeChannelId = newChannel.id;
          runtime.sessionChannelName = channelName;

          const label = `🔌 Discord: #${channelName}`;
          notifyFn(`Connected as ${c.user.tag} → #${channelName}`, "success");
          setStatusFn("pi-discord-remote", label);
        } catch (err) {
          // Channel creation failed — fall back to configured channelId
          console.error("[pi-discord-remote] Could not create channel:", err);
          notifyFn(
            `⚠️ Could not create channel (check Manage Channels permission). Falling back to configured channelId.`,
            "warning",
          );
          runtime.activeChannelId = cfg.channelId ?? null;
          setStatusFn("pi-discord-remote", `🔌 Discord: ${c.user.tag} (fallback)`);
        }
        resolve();
      });
    });

    try {
      setStatusFn("pi-discord-remote", "🔌 Discord: connecting…");
      await client.login(cfg.token);
      await readyPromise;

      // Register the /pi-status slash command (guild-scoped, idempotent).
      // A failure is not fatal — the extension keeps working without it.
      await registerStatusCommand(client, cfg, notifyFn, setStatusFn);
    } catch (err: any) {
      // Initial login failure — clean up and notify immediately
      console.error("[pi-discord-remote] Initial login failed:", err.message);
      sessionActive = false;
      await client.destroy().catch(() => {});
      client = null;
      activeConfig = null;
      connectNotify = null;
      connectSetStatus = null;
      notifyFn(`❌ Failed to connect: ${err.message}`, "error");
      setStatusFn("pi-discord-remote", undefined);
    }
  }

  // ── Intercept ask_user_question → redirect to Discord version ─────────

  // When Discord is connected, block the original ask_user_question (TUI-only)
  // and tell the LLM to use discord_ask_user_question instead.
  // When Discord is not connected, let the original tool through as fallback.
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "ask_user_question") return;
    if (!hasActiveSession()) return; // No Discord session — let the TUI tool work
    return { block: true, reason: "Discord is connected — use discord_ask_user_question instead." };
  });

  // ── System prompt hint: prefer Discord version when connected ──────────

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!hasActiveSession()) return;
    const activeChannelId = runtime.activeChannelId ?? activeConfig?.channelId;
    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        (activeChannelId
          ? `Active Discord session channel ID: ${activeChannelId}. ` +
            "When using discord_send_image, pass this as channelId.\n\n"
          : "") +
        "When you need to ask the user a clarifying question, use the " +
        "discord_ask_user_question tool instead of ask_user_question. " +
        "The Discord version sends questions to the user's Discord channel. " +
        "If discord_ask_user_question returns an error about no UI, " +
        "fall back to ask_user_question.",
    };
  });

  // ── Tool: discord_ask_user_question → Discord ───────────────────────────

  // Send questions to Discord — avoids the TUI-only dialog from
  // @juicesharp/rpiv-ask-user-question that remote users can't see.
  // When Discord is connected, use this tool instead of ask_user_question.
  pi.registerTool({
    name: "discord_ask_user_question",
    label: "Ask User Question (Discord)",
    description:
      "Ask the user one or more structured clarifying questions via Discord. " +
      "Use this instead of ask_user_question when Discord is connected. " +
      "Questions and options are forwarded to the Discord channel. " +
      "The user replies with the option number, label, or custom text.",
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String(),
          header: Type.String(),
          options: Type.Array(
            Type.Object({
              label: Type.String(),
              description: Type.String(),
              preview: Type.Optional(Type.String()),
            }),
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const channelId = pendingReplyChannelId;
      if (!client || !channelId) {
        return {
          content: [
            {
              type: "text",
              text: "Discord not connected. Please answer in the Pi TUI directly.",
            },
          ],
          details: { answers: [], cancelled: true, error: "no_ui" },
        };
      }

      let channel: TextChannel | null = null;
      try {
        const fetched = await client.channels.fetch(channelId);
        if (fetched?.isTextBased()) channel = fetched as TextChannel;
      } catch {
        // channel fetch failed — fall through
      }
      if (!channel) {
        return {
          content: [
            {
              type: "text",
              text: "Discord channel not available. Use ask_user_question instead for TUI-based questions, or connect Discord first.",
            },
          ],
          details: { answers: [], cancelled: true, error: "no_ui" },
        };
      }

      interface Answer {
        questionIndex: number;
        question: string;
        kind: "option" | "custom" | "chat" | "multi";
        answer: string | null;
        selected?: string[];
        notes?: string;
        preview?: string;
      }

      const answers: Answer[] = [];

      for (let qi = 0; qi < params.questions.length; qi++) {
        const q = params.questions[qi];

        // Format question for Discord
        const lines: string[] = [];
        lines.push(`## ${q.header}: ${q.question}`);
        lines.push("");

        if (q.multiSelect) {
          lines.push("*(Multi-select — reply with numbers/labels separated by commas)*");
          lines.push("");
        }

        for (let oi = 0; oi < q.options.length; oi++) {
          const opt = q.options[oi];
          lines.push(`${oi + 1}. **${opt.label}** — ${opt.description}`);
          if (opt.preview) {
            lines.push(`\`\`\`\n${opt.preview}\n\`\`\``);
          }
        }

        lines.push("");
        if (q.multiSelect) {
          lines.push("> Reply with numbers/labels (e.g. \"1,3\") or type \"chat\" to skip.");
        } else {
          lines.push("> Reply with the number or label, type a custom answer, or type \"chat\" to skip.");
        }

        // Send the question
        try {
          await channel.send(lines.join("\n"));
        } catch {
          return {
            content: [{ type: "text", text: "Failed to send question to Discord." }],
            details: { answers: [], cancelled: true, error: "no_ui" },
          };
        }

        // Wait for answer
        questionChannelId = channelId;
        let answerText: string;
        try {
          answerText = await new Promise<string>((resolve, reject) => {
            questionResolver = resolve;
            questionRejecter = reject;

            questionTimeout = setTimeout(() => {
              clearQuestionState();
              reject(new Error("Question timed out — no response in 5 minutes"));
            }, 300_000);

            const onAbort = () => {
              clearQuestionState();
              reject(new Error("Session shut down while waiting for question answer"));
            };
            if (signal) {
              if (signal.aborted) {
                onAbort();
                return;
              }
              questionAbortListener = onAbort;
              questionAbortSignal = signal;
              signal.addEventListener("abort", onAbort, { once: true });
            }
          });
        } catch (err: any) {
          clearQuestionState();
          return {
            content: [{ type: "text", text: `Question cancelled: ${err.message}` }],
            details: { answers, cancelled: true },
          };
        }
        clearQuestionState();

        const trimmed = answerText.trim();

        // Check for "chat" escape
        if (trimmed.toLowerCase() === "chat" || trimmed.toLowerCase() === "/chat") {
          answers.push({
            questionIndex: qi,
            question: q.question,
            kind: "chat",
            answer: null,
          });
          continue;
        }

        // Parse answer
        if (q.multiSelect) {
          // Multi-select: try to parse numbers/labels
          const parts = trimmed.split(/[,\s]+/).filter(Boolean);
          const selected: string[] = [];
          for (const part of parts) {
            const num = parseInt(part, 10);
            if (!isNaN(num) && num >= 1 && num <= q.options.length) {
              selected.push(q.options[num - 1].label);
            } else {
              // Try label match
              const match = q.options.find(
                (o: any) => o.label.toLowerCase() === part.toLowerCase(),
              );
              if (match) {
                if (!selected.includes(match.label)) selected.push(match.label);
              }
            }
          }

          if (selected.length > 0) {
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "multi",
              answer: selected.join(", "),
              selected,
            });
          } else {
            // No match — treat as custom
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "custom",
              answer: trimmed,
            });
          }
        } else {
          // Single-select: try number first, then label match, then custom
          const num = parseInt(trimmed, 10);
          if (!isNaN(num) && num >= 1 && num <= q.options.length) {
            const opt = q.options[num - 1];
            answers.push({
              questionIndex: qi,
              question: q.question,
              kind: "option",
              answer: opt.label,
              preview: opt.preview,
            });
          } else {
            const match = q.options.find(
              (o: any) => o.label.toLowerCase() === trimmed.toLowerCase(),
            );
            if (match) {
              answers.push({
                questionIndex: qi,
                question: q.question,
                kind: "option",
                answer: match.label,
                preview: match.preview,
              });
            } else {
              // Custom answer
              answers.push({
                questionIndex: qi,
                question: q.question,
                kind: "custom",
                answer: trimmed,
              });
            }
          }
        }
      }

      const summary = answers
        .map((a) => {
          if (a.kind === "chat") return `Q${a.questionIndex + 1}: [chat]`;
          if (a.kind === "multi") return `Q${a.questionIndex + 1}: ${a.selected?.join(", ")}`;
          return `Q${a.questionIndex + 1}: ${a.answer}`;
        })
        .join("; ");

      return {
        content: [{ type: "text", text: `User answers: ${summary}` }],
        details: { answers, cancelled: false },
      };
    },
  });

  // ── Tool: discord_send_image (opt-in; no automatic forwarding) ──────────
  pi.registerTool({
    name: "discord_send_image",
    label: "Send Image To Discord",
    description:
      "Send a single image to the active Discord session channel. " +
      "Use only when the user explicitly asks to send an image. " +
      "Provide exactly one source: local file path, URL, or base64.",
    parameters: Type.Object({
      channelId: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      base64: Type.Optional(Type.String()),
      mediaType: Type.Optional(Type.String()),
      filename: Type.Optional(Type.String()),
      caption: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params) {
      const normalized = { ...params };
      let provided = [normalized.path, normalized.url, normalized.base64].filter(Boolean).length;
      if (provided === 0 && lastImageArtifactPath) {
        normalized.path = lastImageArtifactPath;
        provided = 1;
      }

      if (provided !== 1) {
        return {
          content: [{ type: "text", text: "Provide exactly one image source: path, url, or base64." }],
          details: { ok: false, error: "invalid_source_count" },
        };
      }

      let result: { ok: boolean; sentAs?: string; error?: string };
      try {
        result = await withTimeout(
          sendAttachmentToActiveChannel(normalized),
          30_000,
          "discord_send_image_total",
        );
      } catch (err: any) {
        const msg = String(err?.message ?? "send_failed");
        result = { ok: false, error: msg };
      }
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Failed to send image to Discord: ${result.error}` }],
          details: result,
        };
      }

      return {
        content: [{ type: "text", text: `Image sent to Discord (${result.sentAs}).` }],
        details: result,
      };
    },
  });

  // ── Command ───────────────────────────────────────────────────────────────

  pi.registerCommand("pi-discord-remote", {
    description: "Control this Pi session from Discord (creates a new channel per session)",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: async (args: any, ctx: any) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const cmd = parts[0] || "help";

      switch (cmd) {
        // ── setup ─────────────────────────────────────────────────────────
        case "setup": {
          const existing = await loadConfig();

          const token = await ctx.ui.input("Discord Bot Token:", existing?.token ?? "");
          if (!token) return;

          const guildId = await ctx.ui.input(
            "Guild (Server) ID:",
            existing?.guildId ?? "",
          );
          if (!guildId) return;

          const categoryId = await ctx.ui.input(
            "Category ID for new channels (leave empty = server root):",
            existing?.categoryId ?? "",
          );

          const allowedRaw = await ctx.ui.input(
            "Allowed Discord user IDs (comma-separated, leave empty = allow all):",
            existing?.allowedUserIds?.join(", ") ?? "",
          );
          const allowedUserIds = allowedRaw
            ? allowedRaw.split(",").map((s: string) => s.trim()).filter(Boolean)
            : undefined;

          const toolResponsesRaw = await ctx.ui.input(
            "Send tool responses to Discord? (yes/no, default: no):",
            existing?.toolResponses ? "yes" : "no",
          );
          const toolResponses = toolResponsesRaw?.trim().toLowerCase() === "yes";

          // `keepOnline` is preserved from the existing config — re-running
          // setup must not silently reset a user's `keepOnline: false`.
          const cfg: Config = buildSetupConfig(existing, {
            token,
            guildId,
            categoryId,
            allowedUserIds,
            toolResponses,
          });

          await saveConfig(cfg);
          redactionToken = cfg.token?.trim() ?? null;
          ctx.ui.notify(`Config saved → ${CONFIG_FILE}`, "success");
          break;
        }

        // ── start ─────────────────────────────────────────────────────────
        case "start": {
          const cfg = await loadConfig();
          if (!cfg) {
            ctx.ui.notify("No config found. Run /pi-discord-remote setup first.", "error");
            return;
          }
          if (client) {
            if (runtime.activeChannelId) {
              ctx.ui.notify("Already connected to Discord.", "warning");
              return;
            }
            // Hub mode: the bot is online without a session — drop the idle
            // connection and connect again with a fresh session channel.
            await teardownClient((key, val) => ctx.ui.setStatus(key, val));
            ctx.ui.notify("Reconnecting with a new session channel…", "info");
          }
          await startClient(
            cfg,
            ctx.cwd,
            (msg, level) => ctx.ui.notify(msg, level),
            (key, val) => ctx.ui.setStatus(key, val),
          );
          break;
        }

        // ── stop ──────────────────────────────────────────────────────────
        case "stop": {
          if (!client) {
            ctx.ui.notify("Not connected.", "warning");
            return;
          }
          const keepOnline = activeConfig?.keepOnline !== false;

          if (keepOnline) {
            // Hub mode: end the session but keep the gateway connection, so
            // /pi-status can still answer ("no session connected") and the
            // reconnect logic keeps working. Channel messages are ignored —
            // there is no active session channel.
            isShuttingDown = true;
            sessionActive = false;
            clearReconnectTimer();
            reconnectAttempt = 0;
            reconnectFailed = false;
            cancelPendingQuestion();
            await deleteSessionChannel((key, val) => ctx.ui.setStatus(key, val));
            clearSessionState();

            isShuttingDown = false;
            ctx.ui.setStatus("pi-discord-remote", "🟠 Discord: online (no session)");
            ctx.ui.notify(
              "Session ended — channel deleted. The bot stays online so /pi-status keeps working.\n" +
                "Run /pi-discord-remote disconnect to log out completely.",
              "info",
            );
            break;
          }

          await teardownClient((key, val) => ctx.ui.setStatus(key, val));
          ctx.ui.notify("Disconnected from Discord. Channel deleted.", "info");
          break;
        }

        // ── disconnect ────────────────────────────────────────────────────
        case "disconnect": {
          if (!client) {
            ctx.ui.notify("Not connected.", "warning");
            return;
          }
          await teardownClient((key, val) => ctx.ui.setStatus(key, val));
          ctx.ui.notify("Disconnected from Discord. Channel deleted.", "info");
          break;
        }

        // ── status ────────────────────────────────────────────────────────
        case "status": {
          if (client?.isReady()) {
            // Same snapshot as /pi-status — both surfaces must agree.
            const view = buildStatusView(await buildStatusState());
            const modelField = view.fields.find((field) => field.name === "Model");
            ctx.ui.notify(
              `✅ Connected as ${client.user.tag}\n` +
                `   Channel: #${runtime.sessionChannelName ?? runtime.activeChannelId ?? "(fallback)"}\n` +
                `   Channel ID: ${runtime.activeChannelId ?? "(unknown)"}\n` +
                `   Allow-list: ${activeConfig?.allowedUserIds?.join(", ") || "everyone"}\n` +
                `   Session: ${view.headline}` +
                (modelField ? `\n   Model: ${modelField.value}` : ""),
              "info",
            );
          } else if (client) {
            ctx.ui.notify("⏳ Connecting…", "info");
          } else if (reconnectTimer) {
            ctx.ui.notify(
              `🔄 Reconnecting (attempt ${reconnectAttempt}/${RECONNECT_MAX_ATTEMPTS})…`,
              "info",
            );
          } else if (reconnectFailed) {
            ctx.ui.notify(
              `❌ Reconnect failed after ${RECONNECT_MAX_ATTEMPTS} attempts. Run /pi-discord-remote stop then start to retry.`,
              "error",
            );
          } else {
            ctx.ui.notify("❌ Not connected. Run /pi-discord-remote start.", "info");
          }
          break;
        }

        // ── open-config ───────────────────────────────────────────────────
        case "open-config": {
          const raw = existsSync(CONFIG_FILE)
            ? await readFile(CONFIG_FILE, "utf-8")
            : defaultConfigTemplate();

          const edited = await ctx.ui.editor("pi-discord-remote config.json", raw);
          if (!edited) return;

          try {
            const parsed = JSON.parse(edited) as Config;
            await saveConfig(parsed);
            redactionToken = parsed.token?.trim() ?? null;
            ctx.ui.notify("Config saved.", "success");
          } catch {
            ctx.ui.notify("Invalid JSON — config not saved.", "error");
          }
          break;
        }

        // ── help ──────────────────────────────────────────────────────────
        default: {
          ctx.ui.notify(
            [
              "/pi-discord-remote setup       — configure bot token, guild, category",
              "/pi-discord-remote start       — create channel + connect",
              "/pi-discord-remote stop        — delete channel, stay online for /pi-status",
              "/pi-discord-remote disconnect  — delete channel + disconnect completely",
              "/pi-discord-remote status      — show connection state",
              "/pi-discord-remote open-config — edit config JSON",
            ].join("\n"),
            "info",
          );
        }
      }
    },
  });
}
