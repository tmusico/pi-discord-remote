/**
 * Discord slash commands: `/pi-status`, `/pi-abort` and `/pi-model`.
 *
 * Every piece is free of any dependency on `extensions/index.ts`:
 *   • the command definitions sent to Discord,
 *   • an idempotent guild registration (upsert by name — never a bulk
 *     replace of the guild's whole command set),
 *   • the ephemeral interaction handlers.
 *
 * The live session state is injected by the caller through the `deps`
 * objects, so this module never has to reach into the extension.
 *
 * Every reply is ephemeral — allowed, refused and error paths alike — and
 * never carries the bot token, the system prompt, a raw provider error or
 * file contents.
 *
 * discord.js v14 call convention (used below):
 *   commands.fetch({ guildId })      → guild commands
 *   commands.create(body, guildId)   → create one guild command
 *   commands.edit(id, body, guildId) → update one guild command
 */

import {
  buildModelListReply,
  buildModelCatalog,
  formatModelListText,
  resolveModelSelection,
  MODEL_CANDIDATE_LIMIT,
  MODEL_DISPLAY_LIMIT,
  type ModelCatalogEntry,
  type ModelLike,
} from "./model-control.js";
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

/**
 * The `/pi-abort` command definition.
 *
 * Aborts the running agent *run* — the session, the channel and the bot
 * connection stay alive.
 */
export const PI_ABORT_COMMAND = {
  name: "pi-abort",
  description: "Stop the running Pi agent turn (the session stays connected)",
  type: 1,
} as const;

/** Name of the command as registered in Discord. */
export const PI_ABORT_COMMAND_NAME = PI_ABORT_COMMAND.name;

/**
 * The `/pi-model` command definition.
 *
 * Without the `model` option the command lists the usable models; with it
 * the command switches to the given model. `type: 3` is
 * `ApplicationCommandOptionType.String`.
 */
export const PI_MODEL_COMMAND = {
  name: "pi-model",
  description: "Show the models this session can use, or switch to one (provider/model-id)",
  type: 1,
  options: [
    {
      name: "model",
      description: "provider/model-id to switch to; omit to list",
      type: 3,
      required: false,
      autocomplete: true,
    },
  ],
} as const;

/** Name of the command as registered in Discord. */
export const PI_MODEL_COMMAND_NAME = PI_MODEL_COMMAND.name;

/** Name of the `model` option of `/pi-model`. */
export const PI_MODEL_OPTION_NAME = "model";

// ─── Minimal structural Discord types ────────────────────────────────────────
// Structural (instead of discord.js) types so the module can be unit-tested
// with plain fake objects — and so a real `discord.js` Client satisfies them.

/** A command as returned by Discord. */
export interface PiStatusCommandEntry {
  id: string;
  name: string;
}

/** A chat-input option of a command definition. */
export interface PiCommandOptionDefinition {
  name: string;
  description: string;
  /** `3` = `ApplicationCommandOptionType.String`. */
  type: number;
  required?: boolean;
  autocomplete?: boolean;
}

/** A command definition sent to Discord. */
export interface PiCommandDefinition {
  name: string;
  description: string;
  /** `1` = `ApplicationCommandType.ChatInput`. */
  type: number;
  options?: readonly PiCommandOptionDefinition[];
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
  /** The resolved options of the command (optional — absent in fakes). */
  options?: { getString(name: string): string | null };
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

/**
 * The fixed, leak-free error code of a failed command registration.
 *
 * The underlying Discord error may carry the bot token, the system prompt
 * or a raw provider error — none of it ever leaves this module. The
 * actionable hint (the re-invite URL) is reported separately.
 */
export const REGISTRATION_FAILED_CODE = "discord_command_registration_failed";

/** The fixed, leak-free error code of a client that is not ready yet. */
export const REGISTRATION_NOT_READY_CODE = "discord_application_not_ready";

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

/**
 * Index the fetched command list by name.
 *
 * Handles plain command objects as well as the `[key, value]` tuples a
 * discord.js `Collection` yields when it is iterated directly.
 */
function indexCommandsByName(
  commands: Iterable<unknown> | null | undefined,
): Map<string, PiStatusCommandEntry> {
  const index = new Map<string, PiStatusCommandEntry>();
  if (!commands) return index;
  for (const entry of commands) {
    const command = normalizeCommand(entry);
    if (command) index.set(command.name, command);
  }
  return index;
}

/**
 * Build the plain body sent to Discord for one command.
 *
 * `options` are only sent when the command actually has some — Discord
 * rejects an empty option list.
 */
function buildCommandBody(command: PiCommandDefinition): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: command.name,
    description: command.description,
    type: command.type,
  };
  if (Array.isArray(command.options) && command.options.length > 0) {
    body.options = command.options.map((option) => ({ ...option }));
  }
  return body;
}

/**
 * Did Discord refuse because the bot was invited without the
 * `applications.commands` scope?
 *
 * Discord answers HTTP 403 with `{"message": "Missing Access", "code": 50013}`;
 * some proxies/edge cases answer with a bare 403 without a body.
 *
 * The check is deliberately narrow: the error's `code`/`status` and the
 * literal "missing access" marker of its message. The message itself is
 * never propagated — it may contain a secret.
 */
export function isMissingCommandScopeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; status?: unknown; message?: unknown };
  if (e.code === 50013 || e.code === "50013") return true;
  if (e.status === 403 || e.status === "403") return true;
  if (typeof e.message === "string" && /missing access/i.test(e.message)) return true;
  return false;
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
 * Build the actionable hint for a missing `applications.commands` scope.
 *
 * Returns `undefined` when the error is something else.
 */
function buildScopeHint(err: unknown, client: PiStatusClient): string | undefined {
  if (!isMissingCommandScopeError(err)) return undefined;
  const appId = resolveApplicationId(client);
  const inviteUrl = buildPiStatusInviteUrl(appId ?? "<APP_ID>");
  return appId
    ? `The bot is missing the applications.commands scope — re-invite it: ${inviteUrl}`
    : `The bot is missing the applications.commands scope — re-invite it with the ` +
      `application id from the Discord Developer Portal: ${inviteUrl}`;
}

/** Per-command outcome of {@link registerPiCommands}. */
export interface PiCommandRegistrationOutcome {
  /** Name of the command this outcome belongs to. */
  name: string;
  /** Did the command end up registered? */
  ok: boolean;
  /** Short, leak-free error description (absent on success). */
  error?: string;
  /** Actionable hint (e.g. the re-invite URL when the OAuth scope is missing). */
  hint?: string;
}

/** Result of {@link registerPiCommands}. */
export interface PiCommandRegistrationResult {
  /** Did every requested command end up registered? */
  ok: boolean;
  /** First error (absent when everything worked). */
  error?: string;
  /** Actionable hint (e.g. the re-invite URL when the OAuth scope is missing). */
  hint?: string;
  /** One outcome per requested command, in the requested order. */
  outcomes: PiCommandRegistrationOutcome[];
}

/**
 * Register (or update) a set of commands in a guild — idempotently.
 *
 * The guild's commands are fetched **once** and indexed by name; every
 * requested command is then edited in place (when it already exists) or
 * created. A bulk `commands.set(...)` would delete every other command of
 * the same bot application, so it is deliberately not used — commands of
 * other bots and commands with other names are never touched.
 *
 * A failure of one command does not stop the others: every command reports
 * its own outcome.
 *
 * `token` is part of the signature for call-site symmetry with the rest of
 * the extension. It is never used any more: no error message, body or
 * stack ever leaves this module, so there is nothing left to redact.
 */
export async function registerPiCommands(
  client: PiStatusClient,
  token: string,
  guildId: string,
  commands: readonly PiCommandDefinition[],
): Promise<PiCommandRegistrationResult> {
  const outcomes: PiCommandRegistrationOutcome[] = [];

  try {
    const manager = client.application?.commands;
    if (!manager) {
      return { ok: false, error: REGISTRATION_NOT_READY_CODE, outcomes };
    }

    // Fetch the guild's commands once — the index is reused for every
    // requested command.
    let existing: Map<string, PiStatusCommandEntry>;
    try {
      existing = indexCommandsByName(await manager.fetch({ guildId }));
    } catch (err) {
      return {
        ok: false,
        error: REGISTRATION_FAILED_CODE,
        hint: buildScopeHint(err, client),
        outcomes,
      };
    }

    for (const command of Array.isArray(commands) ? commands : []) {
      if (!command || typeof command.name !== "string" || command.name.length === 0) continue;
      const body = buildCommandBody(command);
      try {
        const found = existing.get(command.name);
        if (found) {
          await manager.edit(found.id, body, guildId);
        } else {
          await manager.create(body, guildId);
        }
        outcomes.push({ name: command.name, ok: true });
      } catch (err) {
        // One broken command must not keep the others from being registered.
        outcomes.push({
          name: command.name,
          ok: false,
          error: REGISTRATION_FAILED_CODE,
          hint: buildScopeHint(err, client),
        });
      }
    }

    const failed = outcomes.find((outcome) => !outcome.ok);
    return {
      ok: !failed,
      error: failed?.error,
      hint: failed?.hint,
      outcomes,
    };
  } catch (err) {
    return {
      ok: false,
      error: REGISTRATION_FAILED_CODE,
      hint: buildScopeHint(err, client),
      outcomes,
    };
  }
}

/**
 * Register (or update) `/pi-status` in a guild — idempotently.
 *
 * Thin wrapper over {@link registerPiCommands}: the guild's other commands
 * are never touched — the existing `/pi-status` command is edited in
 * place, otherwise a new one is created.
 */
export async function registerPiStatusCommand(
  client: PiStatusClient,
  token: string,
  guildId: string,
): Promise<PiStatusRegistrationResult> {
  const result = await registerPiCommands(client, token, guildId, [PI_STATUS_COMMAND]);
  return { ok: result.ok, error: result.error, hint: result.hint };
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

// ─── Shared helpers (safe rendering + leak-free logging) ────────────────────

/**
 * Short, leak-free description of an unknown error.
 *
 * Only a **fixed** category is kept — never the message and never
 * `err.name`: `name` is a writable property, so a provider error could
 * carry any text in it (the bot token, the system prompt, file contents).
 * The built-in error classes are recognized through `instanceof` (their
 * prototype chain cannot be forged by assigning a property), so the
 * returned category always comes from this fixed vocabulary.
 */
function describeErrorSafely(err: unknown): string {
  if (err instanceof TypeError) return "TypeError";
  if (err instanceof RangeError) return "RangeError";
  if (err instanceof ReferenceError) return "ReferenceError";
  if (err instanceof SyntaxError) return "SyntaxError";
  if (err instanceof Error) return "Error";
  if (typeof err === "string") return "Error";
  return "unknown_error";
}

/** Trimmed, non-empty string — or `null`. */
function cleanText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "undefined" || trimmed === "NaN") return null;
  return trimmed;
}

/**
 * Read a string option of a chat-input interaction.
 *
 * `getString` throws in discord.js when the option does not exist — that
 * must never break the reply, so the failure degrades to "no value".
 */
function readStringOption(interaction: PiStatusInteraction, name: string): string | null {
  try {
    const value = interaction.options?.getString(name);
    return cleanText(value);
  } catch {
    return null;
  }
}

/** The current model id of the session — `null` when it cannot be read. */
function safeCurrentModelId(deps: { currentModelId?: () => string | null }): string | null {
  try {
    return cleanText(deps.currentModelId?.());
  } catch {
    return null;
  }
}

/**
 * The note rendered with the model list — `null` when there is none.
 *
 * The note is never read from the error path; it only states *where* the
 * model list came from (e.g. "the scope API is unavailable").
 */
function safeScopeNote(deps: { scopeNote?: () => string | null }): string | null {
  try {
    return cleanText(deps.scopeNote?.());
  } catch {
    return null;
  }
}

// ─── /pi-abort ───────────────────────────────────────────────────────────────

/** Outcome of an abort attempt. */
export type PiAbortOutcome = {
  kind: "aborted" | "idle" | "no_session" | "unsupported";
};

/** Dependencies of {@link handlePiAbortInteraction}. */
export interface PiAbortInteractionDeps {
  /** Allow-list of Discord user ids. Empty/undefined = allow everyone. */
  allowedUserIds?: string[];
  /** Aborts the running turn and reports what happened. */
  abortRun: () => PiAbortOutcome | Promise<PiAbortOutcome>;
}

/** Result of {@link handlePiAbortInteraction} — safe to log. */
export interface PiAbortInteractionResult {
  ok: boolean;
  error?: string;
}

/** A run was running and has been aborted. */
export const PI_ABORT_ABORTED = "🛑 Aborted the current run. The session is still connected.";

/** Nothing was running. */
export const PI_ABORT_IDLE = "Nothing is running — there is nothing to abort.";

/** The bot is online, but no Pi session is connected. */
export const PI_ABORT_NO_SESSION = "No Pi session is connected.";

/** The session is not available (replaced / reloaded). */
export const PI_ABORT_UNAVAILABLE = "⚠️ The session is not available right now.";

/** Render the outcome of an abort attempt. */
function renderAbortOutcome(outcome: PiAbortOutcome): string {
  switch (outcome?.kind) {
    case "aborted":
      return PI_ABORT_ABORTED;
    case "idle":
      return PI_ABORT_IDLE;
    case "no_session":
      return PI_ABORT_NO_SESSION;
    default:
      return PI_ABORT_UNAVAILABLE;
  }
}

/**
 * Handle a `/pi-abort` interaction.
 *
 * Only the *run* is aborted — the session, the channel and the bot
 * connection stay alive. Every path is ephemeral: refusals, success and
 * internal errors.
 */
export async function handlePiAbortInteraction(
  interaction: PiStatusInteraction,
  deps: PiAbortInteractionDeps,
): Promise<PiAbortInteractionResult> {
  const allowed = deps.allowedUserIds;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(interaction.user.id)) {
    try {
      await interaction.reply({ content: PI_STATUS_REFUSAL, ephemeral: true });
    } catch (err) {
      console.error(
        "[pi-discord-remote] /pi-abort: refusal reply failed:",
        describeErrorSafely(err),
      );
      return { ok: false, error: "refusal_failed" };
    }
    return { ok: false, error: "not_allowed" };
  }

  // Acknowledge first: Discord only allows 3 seconds for the first reply.
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.error("[pi-discord-remote] /pi-abort: deferReply failed:", describeErrorSafely(err));
    return { ok: false, error: "defer_failed" };
  }

  try {
    const outcome = await deps.abortRun();
    await interaction.editReply({ content: renderAbortOutcome(outcome) });
    return { ok: true };  } catch (err) {
    // The detail stays in the local log — the Discord reply must never
    // expose a stack trace, the bot token, the system prompt or file
    // contents.
    console.error("[pi-discord-remote] /pi-abort: abort failed:", describeErrorSafely(err));
    try {
      await interaction.editReply({ content: PI_ABORT_UNAVAILABLE });
    } catch {
      /* the deferred reply is gone — nothing else we can do */
    }
    return { ok: false, error: "abort_failed" };
  }
}

// ─── /pi-model ───────────────────────────────────────────────────────────────

/** Outcome of a model switch. */
export type PiModelSwitchOutcome =
  | { kind: "switched"; model: ModelLike; thinkingLevel?: string | null }
  | { kind: "unknown"; query: string; suggestions: ModelCatalogEntry[] }
  | { kind: "ambiguous"; query: string; candidates: ModelCatalogEntry[] }
  | { kind: "no_auth"; modelId: string }
  | { kind: "failed" }
  | { kind: "no_session" };

/** Dependencies of {@link handlePiModelAutocomplete}. */
export interface PiModelAutocompleteDeps {
  /** Allow-list of Discord user ids. Empty/undefined = allow everyone. */
  allowedUserIds?: string[];
  /** The models the session can use. */
  listModels: () => ModelLike[] | Promise<ModelLike[]>;
  /** The id of the model the session currently uses. */
  currentModelId?: () => string | null;
  /**
   * Is a Pi session bound?
   *
   * Optional — when it is missing the handler assumes a session. The
   * runtime passes the real check so the hub mode offers no choices.
   */
  hasSession?: () => boolean;
  /**
   * A note rendered with the model list.
   *
   * Used when the session does not expose the model-scope API: the list is
   * then *not* scope-filtered and the reply says so.
   */
  scopeNote?: () => string | null;
}

/** Dependencies of {@link handlePiModelInteraction}. */
export interface PiModelInteractionDeps extends PiModelAutocompleteDeps {
  /** The id of the model the session currently uses. */
  currentModelId: () => string | null;
  /** Switches the session to the given qualified model id. */
  switchModel: (id: string) => Promise<PiModelSwitchOutcome> | PiModelSwitchOutcome;
}

/** Result of {@link handlePiModelInteraction} — safe to log. */
export interface PiModelInteractionResult {
  ok: boolean;
  error?: string;
}

/** The model was switched. */
export const PI_MODEL_SWITCHED_PREFIX = "✅ Model switched to";

/** The provider has no configured credentials. */
export const PI_MODEL_NO_AUTH_PREFIX = "⚠️ No API key configured for provider";

/** The switch failed. */
export const PI_MODEL_SWITCH_FAILED = "⚠️ Could not switch the model.";

/** The bot is online, but no Pi session is connected. */
export const PI_MODEL_NO_SESSION = "No Pi session is connected.";

/** The model list could not be built. */
export const PI_MODEL_UNAVAILABLE = "⚠️ Model list unavailable right now.";

/** Discord's plain-message limit. */
const PI_MESSAGE_MAX = 2000;

/**
 * Cut a reply to Discord's plain-message limit.
 *
 * A reply that is longer would be rejected by Discord — the user would see
 * an API error instead of the explanation.
 */
function boundMessage(text: string): string {
  if (typeof text !== "string") return "";
  return text.length > PI_MESSAGE_MAX ? `${text.slice(0, PI_MESSAGE_MAX - 1)}…` : text;
}

/**
 * Is a Pi session bound?
 *
 * The dependency is optional: when it is missing the handler assumes a
 * session (the pure handlers stay easy to test). The runtime passes the
 * real check, so the hub mode answers "no session connected".
 */
function hasSessionSafe(deps: { hasSession?: () => boolean }): boolean {
  if (typeof deps.hasSession !== "function") return true;
  try {
    return deps.hasSession() === true;
  } catch {
    return false;
  }
}

/**
 * Render an ambiguous selection — never switches a model.
 *
 * The user's input is **not** echoed: it is arbitrary text that could carry
 * a secret (the bot token, the system prompt, file contents) and it could
 * be long enough to break Discord's message limit. Only canonical catalog
 * entries — the qualified ids of the session's own models — are rendered.
 */
function formatAmbiguousModels(selection: {
  query: string;
  candidates: ModelCatalogEntry[];
}): string {
  const lines: string[] = ["⚠️ That model id matches several models:"];
  for (const candidate of selection.candidates.slice(0, MODEL_CANDIDATE_LIMIT)) {
    lines.push(`• ${candidate.id} — ${candidate.name}`);
  }
  lines.push("Use the full provider/model-id, e.g. anthropic/claude-sonnet-4-5.");
  return boundMessage(lines.join("\n"));
}

/**
 * Render an unknown selection — never switches a model.
 *
 * The user's input is **not** echoed (see {@link formatAmbiguousModels}).
 * The suggestions are canonical catalog entries.
 */
function formatUnknownModels(selection: {
  query: string;
  suggestions: ModelCatalogEntry[];
}): string {
  const lines: string[] = ["❌ Unknown model."];
  const suggestions = selection.suggestions.slice(0, MODEL_CANDIDATE_LIMIT);
  if (suggestions.length > 0) {
    lines.push("Did you mean:");
    for (const suggestion of suggestions) {
      lines.push(`• ${suggestion.id} — ${suggestion.name}`);
    }
  }
  lines.push("Use the qualified id, e.g. provider/model-id.");
  return boundMessage(lines.join("\n"));
}

/**
 * The provider of a failed switch.
 *
 * The outcome may carry the qualified id or the bare model id — the
 * already-resolved entry is preferred, the id is parsed as a fallback.
 */
function providerOf(modelId: string, resolved: ModelCatalogEntry): string {
  const raw = cleanText(modelId);
  if (raw && resolved.modelId.toLowerCase() === raw.toLowerCase()) return resolved.provider;
  if (raw) {
    const slash = raw.indexOf("/");
    if (slash > 0) return raw.slice(0, slash);
    return raw;
  }
  return resolved.provider;
}

/** Render the outcome of a model switch. */
function renderSwitchOutcome(
  outcome: PiModelSwitchOutcome,
  resolved: ModelCatalogEntry,
): string {
  if (!outcome || typeof outcome !== "object") return PI_MODEL_SWITCH_FAILED;

  switch (outcome.kind) {
    case "switched": {
      const provider = cleanText(outcome.model?.provider) ?? resolved.provider;
      const modelId = cleanText(outcome.model?.id) ?? resolved.modelId;
      const name =
        cleanText(outcome.model?.name) ?? cleanText(outcome.model?.id) ?? resolved.name;
      // The switch applies to the running session only — the configured
      // default model is not changed on Pi >= 1.5 (see the README).
      return boundMessage(
        `${PI_MODEL_SWITCHED_PREFIX} ${provider}/${modelId} — ${name} (this session)`,
      );
    }
    case "unknown":
      return formatUnknownModels({
        query: outcome.query ?? "",
        suggestions: outcome.suggestions ?? [],
      });
    case "ambiguous":
      return formatAmbiguousModels({
        query: outcome.query ?? "",
        candidates: outcome.candidates ?? [],
      });
    case "no_auth": {
      const provider = providerOf(outcome.modelId ?? "", resolved);
      return boundMessage(
        `${PI_MODEL_NO_AUTH_PREFIX} '${provider}' — the model was not switched.`,
      );
    }
    case "no_session":
      return PI_MODEL_NO_SESSION;
    default:
      return PI_MODEL_SWITCH_FAILED;
  }
}

/**
 * Handle a `/pi-model` interaction.
 *
 * Without the `model` option the usable models are listed (current model
 * marked); with it the model is switched. An unknown or ambiguous input
 * never switches anything and always explains what to do next.
 *
 * Every path is ephemeral: refusals, success and internal errors.
 */
export async function handlePiModelInteraction(
  interaction: PiStatusInteraction,
  deps: PiModelInteractionDeps,
): Promise<PiModelInteractionResult> {
  const allowed = deps.allowedUserIds;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(interaction.user.id)) {
    try {
      await interaction.reply({ content: PI_STATUS_REFUSAL, ephemeral: true });
    } catch (err) {
      console.error(
        "[pi-discord-remote] /pi-model: refusal reply failed:",
        describeErrorSafely(err),
      );
      return { ok: false, error: "refusal_failed" };
    }
    return { ok: false, error: "not_allowed" };
  }

  // Acknowledge first: Discord only allows 3 seconds for the first reply.
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.error("[pi-discord-remote] /pi-model: deferReply failed:", describeErrorSafely(err));
    return { ok: false, error: "defer_failed" };
  }

  try {
    // Hub mode: the bot is online, but no Pi session is bound — the plan
    // answers "no session connected" for both new commands.
    if (!hasSessionSafe(deps)) {
      await interaction.editReply({ content: PI_MODEL_NO_SESSION });
      return { ok: true };
    }

    const query = readStringOption(interaction, PI_MODEL_OPTION_NAME);
    const models = await deps.listModels();
    const catalog = buildModelCatalog(
      models ?? [],
      safeCurrentModelId(deps),
      MODEL_DISPLAY_LIMIT,
      safeScopeNote(deps) ?? undefined,
    );

    if (!query) {
      // No argument: list the usable models.
      const reply = buildModelListReply(catalog);
      if (reply.embed) {
        await interaction.editReply({ embeds: [reply.embed] });
      } else {
        await interaction.editReply({ content: reply.content ?? formatModelListText(catalog) });
      }
      return { ok: true };
    }

    const selection = resolveModelSelection(catalog, query);
    if (selection.kind === "ambiguous") {
      // Ambiguous input never switches a model.
      await interaction.editReply({ content: formatAmbiguousModels(selection) });
      return { ok: true };
    }
    if (selection.kind === "unknown") {
      // Unknown input never switches a model.
      await interaction.editReply({ content: formatUnknownModels(selection) });
      return { ok: true };
    }

    const outcome = await deps.switchModel(selection.entry.id);
    await interaction.editReply({ content: renderSwitchOutcome(outcome, selection.entry) });
    return { ok: true };
  } catch (err) {
    // The detail stays in the local log — the Discord reply must never
    // expose a stack trace, the bot token, the system prompt or file
    // contents.
    console.error("[pi-discord-remote] /pi-model: model command failed:", describeErrorSafely(err));
    try {
      await interaction.editReply({ content: PI_MODEL_UNAVAILABLE });
    } catch {
      /* the deferred reply is gone — nothing else we can do */
    }
    return { ok: false, error: "model_unavailable" };
  }
}

// ─── /pi-model autocomplete ──────────────────────────────────────────────────

/** Discord allows at most 25 autocomplete choices per answer. */
export const PI_MODEL_AUTOCOMPLETE_MAX = 25;

/** Discord allows at most 100 characters per autocomplete choice. */
const PI_MODEL_CHOICE_MAX = 100;

/** One autocomplete choice. */
export interface PiAutocompleteChoice {
  name: string;
  value: string;
}

/** The subset of a Discord autocomplete interaction this module uses. */
export interface PiModelAutocompleteInteraction {
  /** The invoking user. */
  user: { id: string };
  /** The options of the command (the focused one carries the typed text). */
  options?: { getString(name: string): string | null; getFocused?(): string };
  /** Answer the autocomplete request. */
  respond(choices: PiAutocompleteChoice[]): Promise<unknown>;
}

/** Result of {@link handlePiModelAutocomplete} — safe to log. */
export interface PiModelAutocompleteResult {
  ok: boolean;
  /** How many choices were sent. */
  choices?: number;
  error?: string;
}

/** The text the user typed so far. */
function readAutocompleteValue(interaction: PiModelAutocompleteInteraction): string {
  try {
    const focused = interaction.options?.getFocused?.();
    const value = cleanText(focused);
    if (value) return value;
  } catch {
    /* fall through to getString */
  }
  try {
    const value = cleanText(interaction.options?.getString?.(PI_MODEL_OPTION_NAME));
    if (value) return value;
  } catch {
    /* no value at all */
  }
  return "";
}

/** Does the entry match the typed text? */
function matchesAutocompleteQuery(entry: ModelCatalogEntry, query: string): boolean {
  if (query.length === 0) return true;
  return (
    entry.id.toLowerCase().includes(query) ||
    entry.modelId.toLowerCase().includes(query) ||
    entry.name.toLowerCase().includes(query)
  );
}

/**
 * Answer the `/pi-model` autocomplete request.
 *
 * The candidates are filtered by the typed text and answered with at most
 * 25 choices of `provider/model-id`. The handler never throws: a failure
 * answers with an empty list.
 */
export async function handlePiModelAutocomplete(
  interaction: PiModelAutocompleteInteraction,
  deps: PiModelAutocompleteDeps,
): Promise<PiModelAutocompleteResult> {
  try {
    const allowed = deps.allowedUserIds;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(interaction.user.id)) {
      await interaction.respond([]);
      return { ok: true, choices: 0 };
    }

    // Hub mode: no session is bound, so there is no inventory to offer.
    if (!hasSessionSafe(deps)) {
      await interaction.respond([]);
      return { ok: true, choices: 0 };
    }

    const models = await deps.listModels();
    const catalog = buildModelCatalog(models ?? [], safeCurrentModelId(deps));
    const query = readAutocompleteValue(interaction).toLowerCase();

    const choices = catalog.entries
      .filter((entry) => matchesAutocompleteQuery(entry, query))
      // Discord's choice value is limited to 100 characters. An entry whose
      // qualified id does not fit is skipped instead of being truncated into
      // a value that could never resolve to a model.
      .filter((entry) => entry.id.length <= PI_MODEL_CHOICE_MAX)
      .slice(0, PI_MODEL_AUTOCOMPLETE_MAX)
      .map((entry) => ({
        name: `${entry.id} — ${entry.name}`.slice(0, PI_MODEL_CHOICE_MAX),
        value: entry.id,
      }));

    await interaction.respond(choices);
    return { ok: true, choices: choices.length };
  } catch (err) {
    console.error(
      "[pi-discord-remote] /pi-model: autocomplete failed:",
      describeErrorSafely(err),
    );
    try {
      await interaction.respond([]);
    } catch {
      /* the interaction is gone — nothing else we can do */
    }
    return { ok: false, error: "autocomplete_failed" };
  }
}
