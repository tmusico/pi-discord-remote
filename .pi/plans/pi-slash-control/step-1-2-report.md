# Step 1–2 report — pure model-control module + slash command definitions/handlers

Branch: `feat/slash-control` (base `feat/slash-status`). No commit, no push, no version bump,
no new dependency.

## Files changed

| File | Status | Lines |
|------|--------|-------|
| `extensions/model-control.ts` | **new** | 392 |
| `extensions/__tests__/model-control.test.ts` | **new** | 300 |
| `extensions/__tests__/slash-control.test.ts` | **new** | 746 |
| `extensions/slash.ts` | **modified** | +687 / −38 |

`extensions/index.ts` and `README.md` were **not** touched (Step 3 / Step 4).

## Exported API

### `extensions/model-control.ts` (pure — no discord.js, no pi import)

```ts
export interface ModelLike { provider: string; id: string; name?: string }
export interface ModelCatalogEntry { id: string; provider: string; modelId: string; name: string; current: boolean }
export interface ModelCatalog { entries: ModelCatalogEntry[]; visible: ModelCatalogEntry[]; truncated: boolean; currentId: string | null; total: number }
export type ModelSelection =
  | { kind: "exact"; entry: ModelCatalogEntry }
  | { kind: "ambiguous"; query: string; candidates: ModelCatalogEntry[] }
  | { kind: "unknown"; query: string; suggestions: ModelCatalogEntry[] };
export interface ModelEmbedPayload { title?: string; description?: string; color?: number; fields?: { name: string; value: string; inline?: boolean }[] }

export const MODEL_DISPLAY_LIMIT = 20;
export const MODEL_CANDIDATE_LIMIT = 5;
export const EMBED_TITLE_MAX = 256; export const EMBED_DESCRIPTION_MAX = 4096;
export const EMBED_FIELD_NAME_MAX = 256; export const EMBED_FIELD_VALUE_MAX = 1024; export const EMBED_MAX_FIELDS = 25;
export const MODEL_EMBED_TITLE = "🤖 Pi Models";
export const MODEL_EMBED_COLOR = 0x3b82f6;
export const NO_MODELS_AVAILABLE = "No models available — this session has no usable models.";

export function buildModelCatalog(models: ModelLike[], currentId: string | null, limit = 20): ModelCatalog
export function resolveModelSelection(catalog: ModelCatalog, query: string): ModelSelection
export function buildModelListEmbed(catalog: ModelCatalog): ModelEmbedPayload
export function formatModelListText(catalog: ModelCatalog): string
```

### `extensions/slash.ts` (extended — existing exports unchanged)

New command definitions:

```ts
export const PI_ABORT_COMMAND = { name: "pi-abort", description: "Stop the running Pi agent turn (the session stays connected)", type: 1 } as const;
export const PI_ABORT_COMMAND_NAME = "pi-abort";
export const PI_MODEL_COMMAND = { name: "pi-model", description: "Show the models this session can use, or switch to one (provider/model-id)", type: 1,
  options: [{ name: "model", description: "provider/model-id to switch to; omit to list", type: 3, required: false, autocomplete: true }] } as const;
export const PI_MODEL_COMMAND_NAME = "pi-model";
export const PI_MODEL_OPTION_NAME = "model";
```

New types:

```ts
export interface PiCommandOptionDefinition { name: string; description: string; type: number; required?: boolean; autocomplete?: boolean }
export interface PiCommandDefinition { name: string; description: string; type: number; options?: readonly PiCommandOptionDefinition[] }
export interface PiCommandRegistrationOutcome { name: string; ok: boolean; error?: string; hint?: string }
export interface PiCommandRegistrationResult { ok: boolean; error?: string; hint?: string; outcomes: PiCommandRegistrationOutcome[] }

export type PiAbortOutcome = { kind: "aborted" | "idle" | "no_session" | "unsupported" };
export interface PiAbortInteractionDeps { allowedUserIds?: string[]; abortRun: () => PiAbortOutcome | Promise<PiAbortOutcome> }
export interface PiAbortInteractionResult { ok: boolean; error?: string }

export type PiModelSwitchOutcome =
  | { kind: "switched"; model: ModelLike; thinkingLevel?: string | null }
  | { kind: "unknown"; query: string; suggestions: ModelCatalogEntry[] }
  | { kind: "ambiguous"; query: string; candidates: ModelCatalogEntry[] }
  | { kind: "no_auth"; modelId: string }
  | { kind: "failed" }
  | { kind: "no_session" };

export interface PiModelAutocompleteDeps { allowedUserIds?: string[]; listModels: () => ModelLike[] | Promise<ModelLike[]>; currentModelId?: () => string | null }
export interface PiModelInteractionDeps extends PiModelAutocompleteDeps { currentModelId: () => string | null; switchModel: (id: string) => Promise<PiModelSwitchOutcome> | PiModelSwitchOutcome }
export interface PiModelInteractionResult { ok: boolean; error?: string }
export interface PiModelAutocompleteInteraction { user: { id: string }; options?: { getString(name: string): string | null; getFocused?(): string }; respond(choices: PiAutocompleteChoice[]): Promise<unknown> }
export interface PiModelAutocompleteResult { ok: boolean; choices?: number; error?: string }
export interface PiAutocompleteChoice { name: string; value: string }
```

New functions:

```ts
export async function registerPiCommands(client: PiStatusClient, token: string, guildId: string, commands: readonly PiCommandDefinition[]): Promise<PiCommandRegistrationResult>
export async function handlePiAbortInteraction(interaction: PiStatusInteraction, deps: PiAbortInteractionDeps): Promise<PiAbortInteractionResult>
export async function handlePiModelInteraction(interaction: PiStatusInteraction, deps: PiModelInteractionDeps): Promise<PiModelInteractionResult>
export async function handlePiModelAutocomplete(interaction: PiModelAutocompleteInteraction, deps: PiModelAutocompleteDeps): Promise<PiModelAutocompleteResult>
```

Changed (shared plumbing only — **no** `/pi-status` behaviour change):

* `PiStatusInteraction` gained an **optional** `options?: { getString(name: string): string | null }`
  (existing fakes stay valid; a real `ChatInputCommandInteraction` still satisfies the type).
* `registerPiStatusCommand(client, token, guildId)` is now a thin wrapper over
  `registerPiCommands(client, token, guildId, [PI_STATUS_COMMAND])` — same result shape
  (`PiStatusRegistrationResult`), same missing-scope hint, same token redaction.

New message constants: `PI_ABORT_ABORTED`, `PI_ABORT_IDLE`, `PI_ABORT_NO_SESSION`,
`PI_ABORT_UNAVAILABLE`, `PI_MODEL_SWITCHED_PREFIX`, `PI_MODEL_NO_AUTH_PREFIX`,
`PI_MODEL_SWITCH_FAILED`, `PI_MODEL_NO_SESSION`, `PI_MODEL_UNAVAILABLE`,
`PI_MODEL_AUTOCOMPLETE_MAX = 25`.

## Injection seams for Step 3

```ts
// extensions/index.ts
registerPiCommands(client, token, guildId, [PI_STATUS_COMMAND, PI_ABORT_COMMAND, PI_MODEL_COMMAND]);
//   → result.outcomes[] carries one { name, ok, error?, hint? } per command

handlePiAbortInteraction(interaction, {
  allowedUserIds,
  abortRun: () => PiAbortOutcome,          // aborted | idle | no_session | unsupported
});

handlePiModelInteraction(interaction, {
  allowedUserIds,
  listModels: () => ModelLike[],           // { provider, id, name? }
  currentModelId: () => string | null,     // qualified "provider/model-id"
  switchModel: (id: string) => PiModelSwitchOutcome,   // id = qualified id
});

handlePiModelAutocomplete(interaction, {
  allowedUserIds,
  listModels: () => ModelLike[],
  currentModelId: () => string | null,
});
```

`switchModel` receives the **qualified** id (`provider/model-id`) that was resolved from the
catalog — never a bare id.

## Validation (exact output)

```
$ timeout 180s npx vitest run extensions/__tests__/model-control.test.ts
 RUN  v4.1.6 /home/tony/code/personal/pi-discord-remote
 Test Files  1 passed (1)
      Tests  29 passed (29)
   Duration  199ms (transform 42ms, setup 0ms, import 59ms, tests 12ms, environment 0ms)

$ timeout 240s npx vitest run extensions/__tests__/slash-control.test.ts extensions/__tests__/slash.test.ts
 RUN  v4.1.6 /home/tony/code/personal/pi-discord-remote
 Test Files  2 passed (2)
      Tests  68 passed (68)
   Duration  266ms (transform 181ms, setup 0ms, import 219ms, tests 52ms, environment 0ms)

$ timeout 120s npm run check
> pi-discord-remote@0.2.4 check
> tsc --noEmit
(no output — clean)

$ git diff --check
(no output — clean)
```

Extra sanity check (not required by this step, but confirms nothing else broke):

```
$ timeout 300s npm test
 Test Files  9 passed (9)
      Tests  232 passed (232)
```

## Design decisions taken inside the plan's latitude

1. **Duplicate models are de-duplicated** by qualified id (`provider/model-id`). The first
   occurrence wins; if only a later duplicate carries a real `name`, that name is adopted.
   Without this, a duplicated model would make an otherwise exact bare-id query "ambiguous".
2. **Models without a provider or without an id are skipped** — they cannot be addressed as
   `provider/model-id`, so rendering them would produce a half-empty label.
3. **Marking the current model**: an exact (case-insensitive) qualified id wins; a bare model id
   is only accepted when it is unambiguous. `catalog.currentId` returns the canonical matched
   qualified id, otherwise the trimmed input, otherwise `null`.
4. **Resolution always runs against `catalog.entries`** (the full list), never against the
   truncated `visible` list — covered by a dedicated test.
5. **Ambiguity/suggestion caps**: ambiguous candidates and unknown suggestions are capped at 5
   entries (`MODEL_CANDIDATE_LIMIT`). The reply then points at the full `provider/model-id`.
6. **The model list embed uses one field per model** (≤ 25 fields, current model marked with
   `✅` and a `•` for the rest), which keeps every entry readable on a phone and avoids
   truncating a single long field value. The description states the current model and the
   total count (`"4 models available — showing 2."` when truncated).
7. **The plain-text fallback is used when the catalog is empty** (explicit "no models
   available" state), otherwise the embed is used. Both are never empty strings.
8. **`/pi-abort` and `/pi-model` reuse the existing `PI_STATUS_REFUSAL` text** and the same
   allow-list gate (`allowedUserIds` empty/undefined = allow everyone).
9. **A thrown `abortRun`/`listModels`/`switchModel` reuses the "session is not available" /
   "model list unavailable" texts** — no new user-visible wording was invented for error paths.
10. **`no_auth` provider derivation**: the provider of the already-resolved entry is used when
    the outcome's `modelId` matches that entry's bare model id; otherwise the provider is
    parsed from the qualified `modelId` (`"anthropic/claude-sonnet-4-5"` → `"anthropic"`).
11. **Log hygiene**: the new handlers log only the *error name* (`describeErrorSafely`), never
    the message — so a log line can never carry the token, the system prompt, a raw provider
    error or file contents. (The pre-existing `/pi-status` logging was left untouched.)
12. **Autocomplete is allow-list gated**: an unauthorized user gets an empty choice list
    (never an exception), so the model inventory cannot leak. The autocomplete path is a
    read-only path, so it answers instead of refusing with text.
13. **`registerPiCommands` reports per-command outcomes**; one failing command does not stop
    the others from being registered. The guild's commands are fetched **exactly once** and
    indexed by name; `commands.set(...)` is never called.
14. **`switchModel` is only called after an `exact` resolution.** `unknown` and `ambiguous`
    never reach it — asserted by tests that fail if `switchModel` is invoked.
15. **The `thinkingLevel` of a `switched` outcome is not rendered** — the plan fixes the reply
    text to `✅ Model switched to <provider/model-id> — <name>`.

## Open questions / notes for Step 3

* `listModels()` must return the **scoped** models (`ctx.scopedModels`) when the session has
  a non-empty scope, otherwise the registry's available models filtered by
  `hasConfiguredAuth` — per the plan's "Model catalog rules". The mapping from the Pi model
  object to `ModelLike` (`provider` / `id` / `name`) has to happen in `extensions/index.ts`.
* `currentModelId()` should return the **qualified** id (`provider/model-id`); a bare id is
  also accepted by `buildModelCatalog` when unambiguous.
* `switchModel(id)` gets the qualified id; it must resolve it against the same candidate list
  and map `pi.setModel(model) === false` → `{ kind: "no_auth", modelId: id }` and a thrown
  error → `{ kind: "failed" }`.
* The **autocomplete branch must be handled first** in `extensions/index.ts` — an autocomplete
  interaction only supports `respond()`, never `editReply()`, so it must be dispatched before
  the chat-input commands.
* The `/pi-model` handler reads the option through `interaction.options.getString("model")`;
  discord.js throws when the option is absent — the handler swallows that and treats it as
  "no argument" (list mode).
* No design question from the plan was left unanswered; nothing in the public API of
  `extensions/model-control.ts` had to be changed.
