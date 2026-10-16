# Upstream compatibility review — 2026-10-16

Reviewed upstream `main` through [`e91bf634d32c156479c745c0ee3ea399035b670e`](https://github.com/lovetimo0421/yumina-oss/commit/e91bf634d32c156479c745c0ee3ea399035b670e), release 0.0.73.0. The public fork started at `0b2168a20fc4cb9b63e9b96d27c944376b09ba90`; its common upstream base was `b07216cba74af7541eed221ac727a385656c0fa0` (0.0.62).

There are 13 upstream release commits after that base. Several mix large Studio, hosted-service, UI and runtime changes. This sync selectively backports compatible changes from six of those commits, with source commit provenance in each resulting commit. It does not merge those release commits wholesale or claim full 0.0.73 compatibility. The package version is intentionally unchanged.

## Improvements taken

| Source | Result in this fork |
| --- | --- |
| [`a1659cc`](https://github.com/lovetimo0421/yumina-oss/commit/a1659cca529ca939f1c0474c25e4e10ba4f08e33) | Malformed Studio proposal arguments show an error instead of crashing the preview. Non-text lore content is rejected before create/upsert/update. Adapted the validator for fork-specific CSS, HTML and status-layout arguments, including expanded previews. Character roles remain intact. |
| [`14ac243`](https://github.com/lovetimo0421/yumina-oss/commit/14ac243174d9e33bf1ed6e4777ee2372b470499c) | Nested JSON effects can initialize missing objects, lists and numeric leaves. Bracket array paths work. Paths through scalar values and prototype keys are refused. Existing chapter/event state management remains intact. |
| [`63b3a01`](https://github.com/lovetimo0421/yumina-oss/commit/63b3a0168c6e78fead83b4ae5084a2846948d145) | AI effect permission checks resolve display names and bracket roots consistently with the state manager: IDs take priority and duplicate display names resolve to the last variable. This closes a read-only variable bypass. Only this bounded part of the wider variable-integrity release is taken. |
| [`a0fe56f`](https://github.com/lovetimo0421/yumina-oss/commit/a0fe56f5ccf44bc084c4f6c946b5da94ab4c0455) | Correction input uses the selected model's estimator for bounded long CJK passages and compact JSON, avoiding false context-limit rejection. The 96,000-byte work ceiling, existing bounded tokenizer, frozen narrative, routed correction parameters, low reasoning and timeouts are retained. No state definitions or narrative are truncated. |
| [`acd331f`](https://github.com/lovetimo0421/yumina-oss/commit/acd331f459e312fee63507f87d9eda05a1d63c87) | Persona editor content scrolls within the dialog while header controls remain visible. Added an explicit 90dvh cap required by this fork's dialog implementation. VN attributes, sprite fields and upload controls remain intact. |
| [`124e72c`](https://github.com/lovetimo0421/yumina-oss/commit/124e72c8c834f58ce44e3aeeec867b27d03c5986) | World create/update saves receive 10 MiB; ordinary API requests retain 5 MiB. Middleware counts actual streamed bytes, including absent or understated Content-Length. Accepted request bodies still reach existing parsers. Full save errors remain readable and selectable, with stable Retry and explicit Close controls. Existing full-save session imports retain their dedicated 512 MiB route limiter rather than being buffered twice or restricted to 5 MiB; Stripe's existing raw-body exception is retained. |

These patches introduce no database migrations, dependencies or lockfile changes. They do not replace shared Chat markdown/speaker parsing, VN presentation, local memory, persistent Studio tasks, native worker isolation, chapter events, image-generation gates, lossless image optimization or deduplicated storage.

## Release-by-release decisions

“Separate port” means useful but not a safe isolated cherry-pick into the current fork. It does not mean the feature is impossible to support.

| Release | Commit | Decision and remaining work |
| --- | --- | --- |
| 0.0.63.0 | `14ac243` | **Take nested effects.** Cloud session storage, gallery/checkpoint sharing, scene-image directives and wider continuity/app features need their matching database, API, runtime and client changes. Existing local full-save HTML archives serve a different purpose. |
| 0.0.63.1 | `a1659cc` | **Take proposal/lore validation.** Asset-library bulk move/copy/download features are possible separate UI work. |
| 0.0.64.0 | `124e72c` | **Take save limits and full diagnostics, adapted for local archives.** Defer portrait video/provider catalogs and unrelated renderer changes. Local Chat already has its own comprehensive markdown and speaker attribution; overlapping upstream capability does not imply identical implementation. |
| 0.0.65.0 | `180e0d2` | **Separate port: ZIP/TAR/TGZ asset importing.** It needs parser dependencies, job tables, quotas/reservations, routes, worker lifecycle, UI and cleanup. The upstream worker starts only in hosted mode, and direct extracted-asset registration bypasses this fork's lossless optimization/dedup path. Copying the route alone would leave unfinished imports locally. |
| 0.0.65.1 | `40f9a74` | **Skip hosted membership-credit policy.** Other voice/audio, completion activation and sandbox protocol changes need their surrounding changes. The release's conservative compact-JSON correction fallback is unnecessary after the selected model-aware estimator; the fork's existing pretty formatting remains. |
| 0.0.66.0 | `a24c129` | **Separate port: upload queues/admission.** Membership-tier concurrency, quota reservations, retries, queue schema and archive processing are coupled. Local image optimization already bounds bytes, pixels and concurrent conversions. Preserve that pipeline; upload batching can be considered independently. |
| 0.0.68.1 | `acd331f` | **Take persona scrolling only.** The extensive Studio/Canvas/Blueprint changes, voice/realtime video, hosted accounts and global dialog redesign need deliberate ports. Replacing Studio wholesale would discard local task persistence and worker scoping. |
| 0.0.69.0 | `54eae5b` | **Separate port: blueprint context and memory/prompt controls.** Hosted Discover ranking is not a local drop-in: the OSS recommendation helper is a stub returning an empty order. Importing that search integration would remove existing relevance ordering. |
| 0.0.70.0 | `a0fe56f` | **Take correction token estimates.** Preserve the fork's wider guard behavior. |
| 0.0.71.0 | `4811668` | **Separate port: editor ownership/no-remix flow.** Must account for installation-shared cards and local editing locks. Browser Back selection fixes are independently useful but were not selected in this pass. |
| 0.0.71.4 | `8d44726` | **Separate port: standby lore, scenario switches, custom AI stations and declared JSON fields.** Authoring tools, runtime, compiler and UI must agree; fragments would promise behavior the runtime cannot execute. Hosted credit-ledger naming changes are unnecessary locally. |
| 0.0.72.0 | `63b3a01` | **Take effect permission lookup only.** Defer one-way `onceTrue` flags, formula ownership and variable-audit persistence until their authoring, settlement, normalization and audit behavior can be integrated together. Hosted voice billing/video/provider work is not a local drop-in. |
| 0.0.73.0 | `e91bf63` | **Separate port: discussion-first Studio and build handoff.** It changes advisor tools, proposal persistence, committed turns and start/resume behavior. It must be reconciled with this fork's persistent task runner and independent workers. Screen-variable/UI-document changes are separate work; hosted analytics/credit policy is inapplicable here. |

## Verification

| Check | Result |
| --- | --- |
| Engine suite | 1,408 passed across 67 files. Includes nested path, prototype/scalar, permission, chapter, dialogue and state behavior. |
| Shared suite | 103 passed, 1 skipped. |
| Focused server suite | 318 passed, 1 skipped. Includes state guard, correction formatting/routing, low reasoning, tool executor/character roles, chapter tools, turn reconciliation, archive routes and actual-byte middleware. |
| Focused app suite | 96 passed. Includes malformed previews (with fork-specific cases), Chat markdown/speakers and editor save/session behavior. |
| Save serialization/feedback suite | 22 passed, including UTF-8 sizes, 5–10 MiB saves, complete diagnostics, retry races and dismissal. |
| Build | All four workspace packages built successfully. App was rebuilt after the final preview-validator adaptation. |
| Browser | Real components/styles rendered at 390×844 and 1440×1000. Native mobile touch and desktop wheel scrolling worked; persona header stayed anchored; dialog and buttons remained in bounds. Save details, Retry and Close worked without horizontal overflow or page errors. Synthetic fixtures only, no account writes or provider calls. |
| Broad typecheck | Follow-up cleanup resolved the three pre-existing server test-fixture errors: narrow the isolated PGlite client before cleanup, supply required GameState fields and use a valid unrelated UUID in the ownership check. Full workspace `pnpm typecheck` now passes all 7 tasks. |
| Follow-up integration tests | Both affected route tests pass and exit cleanly. The reply-state fixture mocks the unrelated local classifier and contains delayed background jobs with test-scoped timers; production behavior is unchanged. |

An independent read-only review found a missing fork-specific CSS preview validation case. That was reproduced with regressions and fixed before publication. No other actionable findings were reported.

Verification covers the selective source changes. It does not claim a full server/app test-suite run, live external-provider compatibility, cloud-feature deployment, production rollout or persisted-card migration.
