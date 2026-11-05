/**
 * Discord `/pi-status` slash command.
 *
 * Three pieces, all free of any dependency on `extensions/index.ts`:
 *   • the command definition sent to Discord,
 *   • an idempotent guild registration (upsert by name — never a bulk
 *     replace of the guild's whole command set),
 *   • the ephemeral interaction handler.
 *
 * The live session snapshot is injected by the caller through
 * `deps.buildState`, so this module never has to reach into the extension.
 *
 * discord.js v14 call convention (used below):
 *   commands.fetch({ guildId })      → guild commands
 *   commands.create(body, guildId)   → create one guild command
 *   commands.edit(id, body, guildId) → update one guild command
 */

import {
  buildStatusEmbed,
  buildStatusView,
  type StatusState,
} from "./status.js";

// ─── Command definition ──────────────────────────────────────────────────────

/**
 * The `/pi-status` command definition.
 *
 * `type: 1` is `ApplicationCommandType.ChatInput`; the description must be
 * one line of at most 100 characters.
 */
export const PI_STATUS_COMMAND = {
  name: "pi-status",
  description:
    "Show the live state of the connected Pi session (model, activity, context, project)",
  type: 1,
} as const;

/** Name of the command as registered in Discord. */
export const PI_STATUS_COMMAND_NAME = PI_STATUS_COMMAND.name;

// ─── Minimal structural Discord types ────────────────────────────────────────
// Structural (instead of discord.js) types so the module can be unit-tested
// with plain fake objects — and so a real `discord.js` Client satisfies them.

/** A command as returned by Discord. */
export interface PiStatusCommandEntry {
  id: string;
  name: string;
}

/** The subset of `ApplicationCommandManager` this module uses. */
export interface PiStatusCommandManager {
  /**
   * Fetch every command registered in a guild.
   *
   * The result is intentionally loosely typed: discord.js returns a
   * `Collection`, which iterates as `[key, value]` tuples.
   */
  fetch(options: { guildId: string }): Promise<Iterable<unknown>>;
  /** Create a single command in a guild. */
  create(body: unknown, guildId: string): Promise<unknown>;
  /** Update a single command of a guild. */
  edit(id: string, body: unknown, guildId: string): Promise<unknown>;
}

/** The subset of `discord.js` `Client` this module uses. */
export interface PiStatusClient {
  /** The bot application (null until the client is ready). */
  application?: { id?: string | null; commands: PiStatusCommandManager } | null;
  /** The bot user. */
  user?: { id?: string } | null;
}

/**
 * Structural, API-compatible shape of a Discord embed payload.
 *
 * `StatusEmbed` (see extensions/status.ts) is assignable to it, so a plain
 * embed object can be handed to `editReply({ embeds: [embed] })`.
 */
export interface PiStatusEmbedPayload {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

/** The subset of a Discord interaction this module uses. */
export interface PiStatusInteraction {
  /** The invoking user. */
  user: { id: string };
  /** Acknowledge the interaction (must happen within Discord's 3s window). */
  deferReply(options?: { ephemeral?: boolean }): Promise<unknown>;
  /** Edit the deferred reply. */
  editReply(
    options: string | { content?: string; embeds?: PiStatusEmbedPayload[] },
  ): Promise<unknown>;
  /** Reply to the interaction. */
  reply(options: string | { content?: string; ephemeral?: boolean }): Promise<unknown>;
}

/** Dependencies of {@link handlePiStatusInteraction}. */
export interface PiStatusInteractionDeps {
  /** Allow-list of Discord user ids. Empty/undefined = allow everyone. */
  allowedUserIds?: string[];
  /**
   * Returns the live session snapshot to render.
   *
   * May return a promise: the snapshot provider performs a bounded git
   * lookup, which runs *after* `deferReply()` so Discord's 3-second
   * interaction window is never missed. Synchronous providers keep working.
   */
  buildState: () => StatusState | Promise<StatusState>;
}

/** Result of {@link handlePiStatusInteraction} — safe to log. */
export interface PiStatusInteractionResult {
  ok: boolean;
  error?: string;
}

/** Result of {@link registerPiStatusCommand}. */
export interface PiStatusRegistrationResult {
  ok: boolean;
  error?: string;
  /** Actionable hint (e.g. the re-invite URL when the OAuth scope is missing). */
  hint?: string;
}

/** OAuth2 permissions bitfield used by the re-invite URL. */
export const PI_STATUS_INVITE_PERMISSIONS = "274145945856";

/** Base URL of the bot OAuth2 authorization endpoint. */
export const DISCORD_OAUTH_URL = "https://discord.com/oauth2/authorize";

/**
 * Build the re-invite URL that adds the `applications.commands` scope.
 *
 * `appId` may be the `<APP_ID>` placeholder when the application id is not
 * known yet — Discord's OAuth2 `client_id` is the *application* id.
 */
export function buildPiStatusInviteUrl(appId: string): string {
  return `${DISCORD_OAUTH_URL}?client_id=${appId}&scope=bot%20applications.commands&permissions=${PI_STATUS_INVITE_PERMISSIONS}`;
}

// ─── Registration ────────────────────────────────────────────────────────────

/**
 * Normalize one entry of a fetched command list.
 *
 * Handles plain command objects as well as the `[key, value]` tuples a
 * discord.js `Collection` yields when it is iterated directly.
 */
function normalizeCommand(entry: unknown): PiStatusCommandEntry | null {
  if (!entry || typeof entry !== "object") return null;
  if (Array.isArray(entry)) {
    const inner = entry[1];
    return inner && typeof inner === "object" ? normalizeCommand(inner) : null;
  }
  const command = entry as { id?: unknown; name?: unknown };
  if (typeof command.id !== "string" || typeof command.name !== "string") return null;
  return { id: command.id, name: command.name };
}

/** Find the already-registered `/pi-status` command, if any. */
function findExistingCommand(
  commands: Iterable<unknown> | null | undefined,
): PiStatusCommandEntry | null {
  if (!commands) return null;
  for (const entry of commands) {
    const command = normalizeCommand(entry);
    if (command && command.name === PI_STATUS_COMMAND_NAME) return command;
  }
  return null;
}

/** Collect a short, loggable description of an unknown error. */
function describeError(err: unknown): string {
  const parts: string[] = [];
  if (err instanceof Error) parts.push(err.message);
  else if (typeof err === "string") parts.push(err);
  else if (err !== undefined && err !== null) parts.push(String(err));

  if (err && typeof err === "object") {
    const e = err as { code?: unknown; status?: unknown; body?: unknown; rawError?: unknown };
    if (e.code !== undefined) parts.push(`code=${String(e.code)}`);
    if (e.status !== undefined) parts.push(`status=${String(e.status)}`);
    if (typeof e.body === "string") parts.push(e.body);
    else if (e.body && typeof e.body === "object") {
      try {
        parts.push(JSON.stringify(e.body));
      } catch {
        /* ignore unserializable bodies */
      }
    }
  }
  const text = parts.join(" ").trim();
  return text.length > 0 ? text.slice(0, 400) : "unknown_error";
}

/**
 * Did Discord refuse because the bot was invited without the
 * `applications.commands` scope?
 *
 * Discord answers HTTP 403 with `{"message": "Missing Access", "code": 50013}`;
 * some proxies/edge cases answer with a bare 403 without a body.
 */
export function isMissingCommandScopeError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; status?: unknown };
    if (e.code === 50013 || e.code === "50013") return true;
    if (e.status === 403 || e.status === "403") return true;
  }
  return /missing access/i.test(describeError(err));
}

/** Remove the bot token from a message before it is returned/logged. */
function redact(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("***");
}

/**
 * Best-effort application id (the OAuth2 `client_id`).
 *
 * Only `client.application.id` is the application id — the bot *user* id is a
 * different number and must never be used as `client_id`. When the
 * application is not available yet, `null` is returned and the caller falls
 * back to the `<APP_ID>` placeholder.
 */
function resolveApplicationId(client: PiStatusClient): string | null {
  const appId = client.application?.id;
  if (typeof appId === "string" && appId.trim()) return appId.trim();
  return null;
}

/**
 * Register (or update) `/pi-status` in a guild — idempotently.
 *
 * The guild's other commands are never touched: the existing `/pi-status`
 * command is edited in place, otherwise a new one is created. A bulk
 * `commands.set(...)` would delete every other command of the same bot
 * application, so it is deliberately not used.
 *
 * `token` is part of the signature for call-site symmetry with the rest of
 * the extension; the authenticated client already carries the bot
 * credentials, so the token is only used to redact it from error messages.
 */
export async function registerPiStatusCommand(
  client: PiStatusClient,
  token: string,
  guildId: string,
): Promise<PiStatusRegistrationResult> {
  try {
    const commands = client.application?.commands;
    if (!commands) {
      return { ok: false, error: "discord_application_not_ready" };
    }

    const existing = findExistingCommand(await commands.fetch({ guildId }));

    if (existing) {
      await commands.edit(existing.id, { ...PI_STATUS_COMMAND }, guildId);
    } else {
      await commands.create({ ...PI_STATUS_COMMAND }, guildId);
    }
    return { ok: true };
  } catch (err) {
    const error = redact(describeError(err), token);
    if (isMissingCommandScopeError(err)) {
      const appId = resolveApplicationId(client);
      const inviteUrl = buildPiStatusInviteUrl(appId ?? "<APP_ID>");
      const hint = appId
        ? `The bot is missing the applications.commands scope — re-invite it: ${inviteUrl}`
        : `The bot is missing the applications.commands scope — re-invite it with the ` +
          `application id from the Discord Developer Portal: ${inviteUrl}`;
      return { ok: false, error, hint };
    }
    return { ok: false, error };
  }
}

// ─── Interaction handler ─────────────────────────────────────────────────────

/** Short refusal for users outside the allow-list. */
export const PI_STATUS_REFUSAL = "❌ You are not allowed to use this command.";

/** Short, leak-free message used when the status could not be built. */
export const PI_STATUS_UNAVAILABLE = "⚠️ Status unavailable right now.";

/**
 * Handle a `/pi-status` interaction.
 *
 * Every path is ephemeral: refusals, success and internal errors. Internal
 * errors never expose a stack trace, the bot token, the system prompt or any
 * file contents — the caller only gets a short string it may log locally.
 */
export async function handlePiStatusInteraction(
  interaction: PiStatusInteraction,
  deps: PiStatusInteractionDeps,
): Promise<PiStatusInteractionResult> {
  const allowed = deps.allowedUserIds;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(interaction.user.id)) {
    try {
      await interaction.reply({ content: PI_STATUS_REFUSAL, ephemeral: true });
    } catch (err) {
      console.error("[pi-discord-remote] /pi-status: refusal reply failed:", err);
      return { ok: false, error: "refusal_failed" };
    }
    return { ok: false, error: "not_allowed" };
  }

  // Acknowledge first: Discord only allows 3 seconds for the first reply.
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.error("[pi-discord-remote] /pi-status: deferReply failed:", err);
    return { ok: false, error: "defer_failed" };
  }

  try {
    const view = buildStatusView(await deps.buildState());
    const embed = buildStatusEmbed(view);
    await interaction.editReply({ embeds: [embed] });
    return { ok: true };
  } catch (err) {
    // The detail stays in the local log — the Discord reply must never
    // expose a stack trace, the bot token, the system prompt or file
    // contents.
    console.error("[pi-discord-remote] /pi-status: status unavailable:", err);
    try {
      await interaction.editReply({ content: PI_STATUS_UNAVAILABLE });
    } catch {
      /* the deferred reply is gone — nothing else we can do */
    }
    return { ok: false, error: "status_unavailable" };
  }
}
