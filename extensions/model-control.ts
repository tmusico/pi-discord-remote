/**
 * Pure model catalog + selection logic for the Discord `/pi-model` command.
 *
 * Deliberately free of any discord.js or pi import: this module is plain
 * data + formatting so it can be unit-tested without a Discord connection
 * (see `extensions/__tests__/model-control.test.ts`).
 *
 * The rules implemented here (see the plan):
 *   • a model is identified by `provider/model-id`; the display name is the
 *     model's `name` when present, otherwise the model id,
 *   • the candidate list is ordered deterministically: current model first,
 *     then provider, then model id,
 *   • the *display* list is capped, but the *resolution* always runs
 *     against the full candidate list,
 *   • resolution is case-insensitive and answers `exact`, `ambiguous` or
 *     `unknown` — never "probably right".
 */

// ─── Public types ────────────────────────────────────────────────────────────

/** The minimal shape of a model as exposed by the Pi model registry. */
export interface ModelLike {
  /** Provider id, e.g. `"anthropic"`. */
  provider: string;
  /** Model id inside the provider, e.g. `"claude-sonnet-4-5"`. */
  id: string;
  /** Friendly display name, e.g. `"Claude Sonnet 4.5"`. */
  name?: string;
}

/** One catalog entry — a model plus its catalog metadata. */
export interface ModelCatalogEntry {
  /** Qualified id: `"provider/model-id"`. */
  id: string;
  /** Provider id. */
  provider: string;
  /** Model id inside the provider. */
  modelId: string;
  /** Display name (never empty — falls back to the model id). */
  name: string;
  /** Is this the model the session currently uses? */
  current: boolean;
}

/** The full catalog of usable models plus its (capped) display list. */
export interface ModelCatalog {
  /** Every known model, in display order. */
  entries: ModelCatalogEntry[];
  /** The first `limit` entries — what may be shown. */
  visible: ModelCatalogEntry[];
  /** Were there more models than fit into `visible`? */
  truncated: boolean;
  /** Qualified id of the current model (or `null`). */
  currentId: string | null;
  /** Total number of models. */
  total: number;
  /**
   * An optional note rendered with the list (e.g. "the session's model scope
   * could not be read").
   *
   * Optional — a catalog without a note renders exactly as before.
   */
  note?: string;
}

/**
 * How the session's model scope was determined.
 *
 *   • `scoped`      — the session has a non-empty model scope; the list is
 *     exactly the scoped models,
 *   • `unscoped`    — the session has the scope API but no scope configured
 *     (an empty scope means "everything is usable"),
 *   • `unavailable` — the session does not expose the scope API at all (an
 *     older Pi); the list is *not* scope-filtered and the reply says so.
 */
export type ModelScopeKind = "scoped" | "unscoped" | "unavailable";

/** The outcome of resolving a user-supplied model query. */
export type ModelSelection =
  | { kind: "exact"; entry: ModelCatalogEntry }
  | { kind: "ambiguous"; query: string; candidates: ModelCatalogEntry[] }
  | { kind: "unknown"; query: string; suggestions: ModelCatalogEntry[] };

/**
 * Structural, API-compatible shape of a Discord embed payload.
 *
 * Compatible with `PiStatusEmbedPayload` (extensions/slash.ts), so the
 * payload can be handed to `editReply({ embeds: [embed] })`.
 */
export interface ModelEmbedPayload {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default number of models shown in the list. */
export const MODEL_DISPLAY_LIMIT = 20;

/** Maximum number of ambiguous candidates / unknown suggestions. */
export const MODEL_CANDIDATE_LIMIT = 5;

/** Discord embed limits (see https://discord.com/developers/docs/resources/channel). */
export const EMBED_TITLE_MAX = 256;
export const EMBED_DESCRIPTION_MAX = 4096;
export const EMBED_FIELD_NAME_MAX = 256;
export const EMBED_FIELD_VALUE_MAX = 1024;
export const EMBED_MAX_FIELDS = 25;

/**
 * Discord's *aggregate* embed budget: title + description + every field
 * name and value together must not exceed 6000 characters.
 */
export const EMBED_TOTAL_MAX = 6000;

/** Discord's plain-message limit. */
export const MESSAGE_MAX = 2000;

/**
 * The note shown when the session does not expose the model-scope API.
 *
 * The list is then *not* scope-filtered — the reply says so explicitly
 * instead of pretending that a scope was applied.
 */
export const MODEL_SCOPE_NOTE_UNAVAILABLE =
  "scope API unavailable — showing all authenticated models";

/** Embed title used for the model list. */
export const MODEL_EMBED_TITLE = "🤖 Pi Models";

/** Embed color of the model list (blue). */
export const MODEL_EMBED_COLOR = 0x3b82f6;

/** Explicit state rendered when the session has no usable model at all. */
export const NO_MODELS_AVAILABLE = "No models available — this session has no usable models.";

/** Marker used for the current model. */
const CURRENT_MARKER = "✅";

/** Marker used for every other model. */
const OTHER_MARKER = "•";

// ─── Small helpers ───────────────────────────────────────────────────────────

/**
 * Trimmed, non-empty string — or `null`.
 *
 * The literal strings `"undefined"` and `"NaN"` are rejected as well: they
 * are JS artifacts, never a real model name.
 */
function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === "undefined" || trimmed === "NaN") return null;
  return trimmed;
}

/** Deterministic, locale-independent string comparison. */
function compareStrings(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** A usable, non-negative integer limit. */
function normalizeLimit(limit: unknown): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return MODEL_DISPLAY_LIMIT;
  if (limit < 0) return 0;
  return Math.floor(limit);
}

/** Truncate to `max` characters, appending an ellipsis when shortened. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** "1 model" / "2 models". */
function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ─── Catalog builder ─────────────────────────────────────────────────────────

/**
 * Build the catalog of usable models.
 *
 * The current model is marked and sorted first, then the remaining models
 * by provider and model id — the order is fully deterministic.
 *
 * `visible` is the capped display list; `truncated` tells the caller
 * whether models were left out. Resolution must always use `entries`
 * (the full list), never `visible`.
 */
export function buildModelCatalog(
  models: ModelLike[],
  currentId: string | null,
  limit: number = MODEL_DISPLAY_LIMIT,
  note?: string,
): ModelCatalog {
  const safeLimit = normalizeLimit(limit);
  const wanted = cleanLabel(currentId);

  // Deduplicate by qualified id — the same model may be reported twice.
  const collected = new Map<string, { entry: ModelCatalogEntry; explicitName: boolean }>();

  for (const model of Array.isArray(models) ? models : []) {
    if (!model || typeof model !== "object") continue;

    const provider = cleanLabel(model.provider);
    const modelId = cleanLabel(model.id);
    // A model without a provider or an id cannot be addressed as
    // "provider/model-id" — it is skipped instead of rendered half-empty.
    if (!provider || !modelId) continue;

    const qualifiedId = `${provider}/${modelId}`;
    const explicitName = cleanLabel(model.name);
    const name = explicitName ?? modelId;

    const previous = collected.get(qualifiedId);
    if (previous) {
      // Keep the first entry, but adopt a real name if the first one had none.
      if (!previous.explicitName && explicitName) previous.entry.name = name;
      continue;
    }

    collected.set(qualifiedId, {
      entry: { id: qualifiedId, provider, modelId, name, current: false },
      explicitName: explicitName !== null,
    });
  }

  const all = Array.from(collected.values()).map((item) => item.entry);

  // Which entry is the current one? A qualified id wins; a bare model id is
  // only accepted when it is unambiguous.
  let currentEntry: ModelCatalogEntry | null = null;
  if (wanted) {
    const lower = wanted.toLowerCase();
    currentEntry = all.find((entry) => entry.id.toLowerCase() === lower) ?? null;
    if (!currentEntry) {
      const bareMatches = all.filter((entry) => entry.modelId.toLowerCase() === lower);
      if (bareMatches.length === 1) currentEntry = bareMatches[0];
    }
  }
  for (const entry of all) entry.current = entry === currentEntry;

  all.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const byProvider = compareStrings(a.provider, b.provider);
    if (byProvider !== 0) return byProvider;
    return compareStrings(a.modelId, b.modelId);
  });

  const visible = all.slice(0, safeLimit);

  return {
    entries: all,
    visible,
    truncated: all.length > safeLimit,
    currentId: currentEntry ? currentEntry.id : (wanted ?? null),
    total: all.length,
    note: cleanLabel(note) ?? undefined,
  };
}

// ─── Selection ───────────────────────────────────────────────────────────────

function ambiguous(
  query: string,
  matches: ModelCatalogEntry[],
): ModelSelection {
  return { kind: "ambiguous", query, candidates: matches.slice(0, MODEL_CANDIDATE_LIMIT) };
}

/**
 * Resolve a user-supplied model query against the catalog.
 *
 * Resolution order (case-insensitive):
 *   1. exact qualified id (`provider/model-id`),
 *   2. exact bare model id — unique → exact, several → ambiguous,
 *   3. unique prefix of a qualified id — unique → exact, several → ambiguous,
 *   4. unique prefix of a bare model id — unique → exact, several → ambiguous,
 *   5. otherwise unknown (with up to 5 substring suggestions).
 *
 * The lookup always runs against `catalog.entries` — the full list — never
 * against the truncated `catalog.visible` display list.
 */
export function resolveModelSelection(catalog: ModelCatalog, query: string): ModelSelection {
  const entries = catalog && Array.isArray(catalog.entries) ? catalog.entries : [];
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (trimmed.length === 0) {
    return { kind: "unknown", query: trimmed, suggestions: [] };
  }

  const lower = trimmed.toLowerCase();

  // 1 — exact qualified id.
  const exactQualified = entries.filter((entry) => entry.id.toLowerCase() === lower);
  if (exactQualified.length === 1) return { kind: "exact", entry: exactQualified[0] };
  if (exactQualified.length > 1) return ambiguous(trimmed, exactQualified);

  // 2 — exact bare model id.
  const exactBare = entries.filter((entry) => entry.modelId.toLowerCase() === lower);
  if (exactBare.length === 1) return { kind: "exact", entry: exactBare[0] };
  if (exactBare.length > 1) return ambiguous(trimmed, exactBare);

  // 3 — prefix of a qualified id.
  const prefixQualified = entries.filter((entry) => entry.id.toLowerCase().startsWith(lower));
  if (prefixQualified.length === 1) return { kind: "exact", entry: prefixQualified[0] };
  if (prefixQualified.length > 1) return ambiguous(trimmed, prefixQualified);

  // 4 — prefix of a bare model id.
  const prefixBare = entries.filter((entry) => entry.modelId.toLowerCase().startsWith(lower));
  if (prefixBare.length === 1) return { kind: "exact", entry: prefixBare[0] };
  if (prefixBare.length > 1) return ambiguous(trimmed, prefixBare);

  // 5 — nothing matched: offer substring suggestions.
  const suggestions = entries
    .filter(
      (entry) =>
        entry.id.toLowerCase().includes(lower) || entry.modelId.toLowerCase().includes(lower),
    )
    .slice(0, MODEL_CANDIDATE_LIMIT);

  return { kind: "unknown", query: trimmed, suggestions };
}

// ─── Renderers ───────────────────────────────────────────────────────────────

/** The catalog entry marked as current (if any). */
function currentEntryOf(catalog: ModelCatalog): ModelCatalogEntry | null {
  const entries = catalog && Array.isArray(catalog.entries) ? catalog.entries : [];
  return entries.find((entry) => entry.current) ?? null;
}

/** The number of characters of the joined lines (separators included). */
function joinedLength(lines: string[]): number {
  if (lines.length === 0) return 0;
  return lines.reduce((sum, line) => sum + line.length, 0) + (lines.length - 1);
}

/** One embed field. */
interface ModelEmbedField {
  name: string;
  value: string;
  inline: boolean;
}

/** The aggregate size of the fields (name + value). */
function fieldsLength(fields: ModelEmbedField[]): number {
  return fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
}

/** Room reserved for the "N models available — showing M:" line. */
const COUNT_LINE_RESERVE = 48;

/** "… and 3 more models". */
function moreMarker(count: number): string {
  return `… and ${count} more model${count === 1 ? "" : "s"}`;
}

/**
 * Fit the model fields into the remaining embed budget.
 *
 * A field value that does not fit is truncated; an entry that cannot fit at
 * all is dropped. The aggregate (title + description + fields) never
 * exceeds {@link EMBED_TOTAL_MAX}.
 *
 * `reserved` is the number of characters already used by the title and the
 * description.
 */
function fitModelFields(reserved: number, shown: ModelCatalogEntry[]): ModelEmbedField[] {
  const fields: ModelEmbedField[] = [];
  let used = reserved;

  for (const entry of shown) {
    const name = truncate(
      `${entry.current ? CURRENT_MARKER : OTHER_MARKER} ${entry.id}`,
      EMBED_FIELD_NAME_MAX,
    );
    const value = truncate(entry.name, EMBED_FIELD_VALUE_MAX);
    const remaining = EMBED_TOTAL_MAX - used - name.length;
    if (remaining <= 0) break;
    if (value.length > remaining) {
      // The value is cut to what is left — the next entry does not fit.
      const fitted = truncate(value, remaining);
      if (fitted.length > 0) fields.push({ name, value: fitted, inline: false });
      break;
    }
    fields.push({ name, value, inline: false });
    used += name.length + value.length;
  }

  return fields;
}

/**
 * Build a plain embed object for the model list.
 *
 * Respects Discord's limits: ≤25 fields, field name ≤256 chars, field value
 * ≤1024 chars, description ≤4096 chars, title ≤256 chars — and the
 * *aggregate* budget of 6000 characters (title + description + every field
 * name and value). A value that does not fit is truncated, an entry that
 * does not fit at all is dropped.
 */
export function buildModelListEmbed(catalog: ModelCatalog): ModelEmbedPayload {
  const entries = catalog && Array.isArray(catalog.entries) ? catalog.entries : [];
  const visible = catalog && Array.isArray(catalog.visible) ? catalog.visible : entries;
  const total =
    typeof catalog?.total === "number" && Number.isFinite(catalog.total)
      ? catalog.total
      : entries.length;
  const current = currentEntryOf(catalog);

  if (entries.length === 0) {
    return {
      title: truncate(MODEL_EMBED_TITLE, EMBED_TITLE_MAX),
      description: truncate(NO_MODELS_AVAILABLE, EMBED_DESCRIPTION_MAX),
      color: MODEL_EMBED_COLOR,
      fields: [],
    };
  }

  const title = truncate(MODEL_EMBED_TITLE, EMBED_TITLE_MAX);
  const shown = visible.slice(0, EMBED_MAX_FIELDS);
  const note = catalog?.note ? truncate(catalog.note, EMBED_DESCRIPTION_MAX) : "";

  /** The description for a given number of listed entries. */
  const describe = (count: number): string => {
    const parts: string[] = [];
    if (current) {
      parts.push(`Current model: ${current.id} — ${current.name}`);
    } else {
      parts.push("No model is currently selected.");
    }
    parts.push(
      catalog?.truncated === true || entries.length > count
        ? `${plural(total, "model")} available — showing ${count}.`
        : `${plural(total, "model")} available.`,
    );
    if (note) parts.push(note);
    return truncate(parts.join("\n"), EMBED_DESCRIPTION_MAX);
  };

  // The description depends on the number of entries that fit, and the
  // number of entries depends on the length of the description — so the
  // budget is reserved with the longest possible description and the final
  // description is computed afterwards.
  const reserved =
    title.length + Math.max(describe(0).length, describe(shown.length).length);
  let fields = fitModelFields(reserved, shown);

  let description = describe(fields.length);
  let guard = 0;
  while (
    title.length + description.length + fieldsLength(fields) > EMBED_TOTAL_MAX &&
    fields.length > 0 &&
    guard < EMBED_MAX_FIELDS + 1
  ) {
    // The final description does not fit — the last entry is dropped.
    fields.pop();
    description = describe(fields.length);
    guard += 1;
  }

  return {
    title,
    description,
    color: MODEL_EMBED_COLOR,
    fields,
  };
}

/**
 * Plain-text rendering of the same content (fallback / logs).
 *
 * Bounded by Discord's plain-message limit (2000 characters): the entries
 * that do not fit are dropped and replaced by an "… and N more models"
 * marker. The current model is always part of the header.
 */
export function formatModelListText(catalog: ModelCatalog): string {
  const entries = catalog && Array.isArray(catalog.entries) ? catalog.entries : [];
  if (entries.length === 0) return NO_MODELS_AVAILABLE;

  const visible = catalog && Array.isArray(catalog.visible) ? catalog.visible : entries;
  const shown = visible.slice(0, EMBED_MAX_FIELDS);
  const current = currentEntryOf(catalog);
  const total =
    typeof catalog?.total === "number" && Number.isFinite(catalog.total)
      ? catalog.total
      : entries.length;

  const head = current
    ? `Current model: ${current.id} — ${current.name}`
    : "No model is currently selected.";
  // The header is cut so that the count line and the "… and N more" marker
  // always fit as well.
  const headLines = [truncate(head, MESSAGE_MAX - COUNT_LINE_RESERVE - 80)];
  if (catalog?.note) headLines.push(truncate(catalog.note, MESSAGE_MAX - COUNT_LINE_RESERVE - 80));

  const entryLines = shown.map(
    (entry) => `${entry.current ? CURRENT_MARKER : OTHER_MARKER} ${entry.id} — ${entry.name}`,
  );

  const countLine = (count: number): string =>
    catalog?.truncated === true || entries.length > count
      ? `${plural(total, "model")} available — showing ${count}:`
      : `${plural(total, "model")} available:`;

  // Reserve room for the header and the (short) count line.
  const budget = MESSAGE_MAX - joinedLength(headLines) - 1 - COUNT_LINE_RESERVE;
  const included: string[] = [];
  let used = 0;
  for (const line of entryLines) {
    const cost = line.length + 1;
    if (used + cost > budget) break;
    included.push(line);
    used += cost;
  }

  const lines = [...headLines, countLine(included.length), ...included];

  let omitted = entryLines.length - included.length;
  if (omitted > 0) {
    let marker = moreMarker(omitted);
    while (
      lines.length > headLines.length + 1 &&
      joinedLength(lines) + 1 + marker.length > MESSAGE_MAX
    ) {
      lines.pop();
      omitted += 1;
      marker = moreMarker(omitted);
      lines[headLines.length] = countLine(lines.length - headLines.length - 1);
    }
    if (joinedLength(lines) + 1 + marker.length <= MESSAGE_MAX) lines.push(marker);
  }

  const text = lines.join("\n");
  return text.length > MESSAGE_MAX ? truncate(text, MESSAGE_MAX) : text;
}

/**
 * The reply for a model list: an embed when the list fits into one, the
 * (length-bounded) plain-text rendering otherwise.
 */
export interface ModelListReply {
  /** The embed — present when the list fits into one. */
  embed?: ModelEmbedPayload;
  /** The plain-text fallback — present when the embed could not carry the list. */
  content?: string;
}

/**
 * Render the model list for Discord.
 *
 * An embed is used as long as it can carry at least one entry (the current
 * model comes first). When even that does not fit into Discord's aggregate
 * budget, the plain-text rendering is used instead — it is bounded by
 * Discord's 2000-character message limit.
 */
export function buildModelListReply(catalog: ModelCatalog): ModelListReply {
  const entries = catalog && Array.isArray(catalog.entries) ? catalog.entries : [];
  if (entries.length === 0) return { content: formatModelListText(catalog) };

  const embed = buildModelListEmbed(catalog);
  if (!embed.fields || embed.fields.length === 0) {
    return { content: formatModelListText(catalog) };
  }
  return { embed };
}
