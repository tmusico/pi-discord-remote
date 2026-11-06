# Final review — /pi-abort + /pi-model

## Verdict

ACCEPT

## N7 / N8 status

- **N7 — CLOSED.** The `no_auth` branch now wraps its complete reply in `boundMessage` (`extensions/slash.ts:869-873`). The regression uses a 2,100-character provider, reaches the branch through an exactly resolved bare model id, and asserts `content.length <= 2000` (`extensions/__tests__/slash-control.test.ts:673-684`). This is a genuine negative control: removing `boundMessage` would produce a reply over 2,100 characters and fail that assertion.
- **N8 — CLOSED.** The README now documents the 20-entry display limit, Discord’s embed budget, omitted entries, and the total count (`README.md:80-82`). Those claims match `MODEL_DISPLAY_LIMIT = 20` (`extensions/model-control.ts:100`) and the field/aggregate budgeting and count rendering in `buildModelListEmbed` (`extensions/model-control.ts:415-487`).

## Remaining findings

No findings.

## Checks performed

- Read `PLAN.md`, `review.md`, `repair-review.md`, and `repair-report-2.md`, then inspected the current working-tree sources, tests, README, and complete working-tree file inventory.
- **Every `/pi-model` plain-text branch checked:**
  - switched: bounded at `extensions/slash.ts:855-857`;
  - ambiguous and unknown: bounded at `extensions/slash.ts:798` and `extensions/slash.ts:820`;
  - `no_auth`: bounded at `extensions/slash.ts:871-873`;
  - `no_session`, generic switch failure, model-list failure, refusal, and no-models replies are short fixed strings (`extensions/slash.ts:467`, `extensions/slash.ts:743-749`; `extensions/model-control.ts:133`);
  - plain-text model-list fallback has a final 2,000-character bound (`extensions/model-control.ts:490-548`).
- **Every `/pi-abort` reply checked:** all four outcomes and the exception fallback use the short constants at `extensions/slash.ts:612-633` and `extensions/slash.ts:679`; refusals use the fixed refusal at `extensions/slash.ts:467`.
- **README consistency checked:** abort replies match `README.md:68-71`; model replies match `README.md:97-102`; hub-mode wording matches the pre-option session gate at `extensions/slash.ts:918-923` and runtime wiring at `extensions/index.ts:1775,1793`; credential-filtering wording at `README.md:87-93` matches scoped-versus-registry behavior at `extensions/index.ts:514-564`; successful replies include “(this session)” at `extensions/slash.ts:855-857`, matching `README.md:97,116`.
- **Earlier repairs remain intact:**
  - receiver-preserving `r.hasConfiguredAuth?.(model)` at `extensions/index.ts:537`, with receiver-dependent regressions;
  - fixed error categories without `err.name` at `extensions/slash.ts:533-543` and `extensions/index.ts:713-723`;
  - unknown/ambiguous formatters do not interpolate the typed query (`extensions/slash.ts:789-820`);
  - `/pi-model` list and switch share the hub-mode gate, and autocomplete independently returns no choices without a session;
  - autocomplete skips IDs over 100 characters and submits the complete `entry.id` (`extensions/slash.ts:1067-1071`).
- **Abort semantics checked:** outcome precedence remains no session → unsupported → idle/aborted; pending-question rejection precedes `ctx.abort()` (`extensions/index.ts:743-765`). The abort path contains no session/channel/client teardown.
- **Model correctness checked:** case-insensitive exact/prefix resolution runs against `catalog.entries`, not the truncated display list (`extensions/model-control.ts:297-334`); switching resolves the canonical model object before calling `pi.setModel`, and `false` maps to `no_auth` (`extensions/index.ts:792-818`).
- **Interaction and registration behavior checked:** allow-list checks precede session work; refusals and defers are ephemeral; autocomplete is routed before chat-input routing (`extensions/index.ts:852-879`); registration fetches once and performs per-name edit/create without bulk replacement.
- **Rendering and tests checked:** embed field counts, individual sizes, aggregate budget, plain-text limits, autocomplete limits, and substantive regression assertions were inspected. No tautological N7/N8 or earlier repair regression was found.
- **Scope checked:** `package.json` and `package-lock.json` are unchanged, so there is no new dependency or version bump. `/pi-status` changes are limited to shared registration/routing plumbing and fixed registration errors.
- **Working-tree inventory:** `watchdog_diff` showed only the intended modified files (`README.md`, `extensions/index.ts`, `extensions/slash.ts`, `extensions/__tests__/slash.test.ts`, `.pi/plans/pi-slash-control/CHECKLIST.md`) and intended untracked implementation/test/review artifacts. No package, lockfile, or `dist` changes were reported.
- `cd /home/tony/code/personal/pi-discord-remote && timeout 300s npm test` — **not run**; no shell/command-execution tool was exposed.
- `cd /home/tony/code/personal/pi-discord-remote && timeout 120s npm run check` — **not run** for the same reason.
- `cd /home/tony/code/personal/pi-discord-remote && timeout 180s npm run build` — **not run** for the same reason.
- `cd /home/tony/code/personal/pi-discord-remote && git diff --check` — **not run** for the same reason. The repair report’s successful validation results were not independently reproduced.

## Residual risks / gaps not covered by tests

- No live Discord or Pi integration was exercised. Real guild registration, autocomplete submission, reconnect behavior, real registry behavior, and session/channel/bot survival after abort remain source-reviewed.
- The N7 negative control was verified analytically from its input and assertion; no fix was reverted and no test was executed during this read-only pass.
- Scoped-model behavior across Pi versions relies on feature detection and fakes rather than integration tests against each supported runtime.
- A stale context during model switching still maps to `no_session`; this remains the previously documented product decision, not a new regression.
- Final test, typecheck, build, and whitespace validation should still be run by the supervisor before merge.