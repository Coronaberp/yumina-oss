# Upstream compatibility review — 2026-10-24

Reviewed the four upstream release commits after `e91bf634d32c156479c745c0ee3ea399035b670e` through [`f21f0e589291f55a160d6f271154822edb6d1007`](https://github.com/lovetimo0421/yumina-oss/commit/f21f0e589291f55a160d6f271154822edb6d1007), release 0.0.82.0. The public fork started this pass at `703f16c118319797da49effb0bb9e12161cf4d39`.

These are large release bundles, not four isolated patches. This pass selectively backports compatible fixes and records the reviewed upstream ancestry. It does not claim full upstream feature parity or change the package version. Earlier deferred decisions remain documented in [the previous review](upstream-sync-2026-10-16.md).

## Improvements taken

| Source | Result in this fork |
| --- | --- |
| [`7551c67`](https://github.com/lovetimo0421/yumina-oss/commit/7551c67cc27d3c9cb40e1263d2f5ca4b403da66f) | Variable paths can include character names with Chinese/Japanese middle dots and spaces after a path dot. The completed-response parser applies these effects; streaming hides actual directives. Adapted the fork's literal masking so JSON payloads stay parseable and quoted/code examples stay readable without changing state. Synchronized the standalone VN helper and embedded persona template. Ordinary bracketed prose and existing speaker/angle-markup behavior remain covered. |
| `7551c67` | Account-deletion emails use full-width single-column policy sections and clearer translated warnings. Names, link attributes and visible links are escaped. All five supported locales are covered. Ordinary authentication emails and account-deletion eligibility guards remain intact. |
| [`9293fa1`](https://github.com/lovetimo0421/yumina-oss/commit/9293fa1532ebe80da213172a766a76e275b67247) | Upload preparation binds the supplied file length and uses a 10-minute expiry for world assets, creative assets, thumbnails and gallery uploads. The existing client already supplies the file size. Local storage now honors the same optional signing contract as S3, counts actual streamed bytes, and rejects short/oversized bodies before replacing the object or its deduplication metadata. Invalid supplied lengths are rejected; callers omitting the length retain their legacy behavior. |
| [`f21f0e5`](https://github.com/lovetimo0421/yumina-oss/commit/f21f0e589291f55a160d6f271154822edb6d1007) | Cover selection requires a legacy asset belonging to the target world, or an owned/public creative asset. Applied the same authorization rules to the sibling gallery-selection endpoint. Image-only checks, source keys, local URLs, and held cover edits remain intact. The asset picker requests page one instead of inheriting the library's previously visited page. |
| `f21f0e5` | Saved provider keys remain readable during a configured encryption-key rotation. New writes use current material; reads can try explicitly retained prior material and the historical auth-secret key. Added optional configuration guidance without changing real configuration or stored rows. Row migration remains manual through re-saving affected keys. |

No dependencies, lockfiles, database migrations, deployed configuration, user data or live services were changed. Full-resolution lossless optimization, transparency, supported animation and deduplicated storage are preserved.

## Release-by-release decisions

| Release | Commit | Decision and remaining work |
| --- | --- | --- |
| 0.0.80.0 | `7551c67` | **Take named directives and deletion emails.** Defer the wider Studio/Blueprint redesign, hosted analytics/credit/model-access infrastructure and account-deletion preflight flow. The preflight needs an adapted backend/client/translation port that preserves this fork's extra restriction/referral guards. Upstream OSS availability/registry fixes target newer callers absent from the fork; their orphan helpers are not needed to build this tree. |
| 0.0.81.0 | [`220a9f3`](https://github.com/lovetimo0421/yumina-oss/commit/220a9f3705677520dcd0d4f6d5b4db3078ca8a84) | **Selected-model automatic-playtest fix is not applicable.** The fork has no automatic playtest runner or corresponding call sites. A future automatic-playtest port must carry selected model, persisted task context, saved-preference fallback and per-turn forwarding together, while preserving the local persistent task runner. |
| 0.0.81.1 | `9293fa1` | **Take signed file lengths and local/S3 parity.** Defer the coupled image-publication/strict-validation rewrite, quota/queue/archive integration and lossy 1080p/20-MB-input/5-MB-output policy. That policy would replace this fork's lossless pipeline and needs an explicit separate compatibility decision. |
| 0.0.82.0 | `f21f0e5` | **Take source authorization, first-page selection and encryption-key rotation.** Defer motion/video covers and their transcoder dependencies, processing jobs, polling and crop playback UI. The advertised media-filter union does not apply to the fork's existing singular server-side type filter. The version-fixture change targets a helper absent here; this fork's fixture already derives columns from the current schema. Larger memory/rewind/provider/hosted changes need separate review and integration. |

Signed length is a bounded improvement, not full upload-security parity. Existing lengthless URLs remain unbound, tokens can be reused until expiry, and registered-original immutability, strict image decoding and broader active-content handling remain separate work. Source-selection authorization does not make all existing CDN media private.

## Verification

| Check | Result |
| --- | --- |
| Engine suite | 1,411 passed across 68 files, including named-path effects, nested JSON, literal examples and the existing parser/state regressions. |
| Shared suite | 103 passed, 1 skipped. |
| Focused server suite | 137 passed across 18 files: deletion email/eligibility, key rotation, local/S3 signing, streamed length/atomicity, upload preparation, source authorization, local URLs, lossless images and deduplication. |
| Focused app suite | 104 passed across 11 files: streaming directives/literal examples, Chat markdown/speakers, existing upload behavior and the rendered picker with its real pagination store. |
| Workspace typecheck | All 7 tasks passed. |
| Open-source edition boundary | Passed; no core imports of hosted paths. |
| Independent review | No outstanding actionable findings after the streamed literal-example adaptation. |
| Build | All 4 packages built successfully from the combined source. Node loader deprecation and Vite chunk-size notices are nonfatal. |

Regressions were reproduced before implementation: named directives remained in prose, deletion email link attributes were not escaped, retired keys failed to decrypt, local uploads ignored declared lengths, unauthorized source assets were selected, and the picker inherited a later-page offset. Quoted named examples also reproduced a streaming-only loss during integration; the fork-specific adaptation preserves them.

The test databases, names, keys, object bytes and mail output are synthetic. No emails were sent and no live provider or S3 requests were made. The S3 check verifies SDK signatures offline. Email layout is checked structurally, including readable single-column details without responsive CSS; no real email-client delivery/rendering is claimed. The picker regression mounts the actual component with its real pagination store in a simulated browser; no full browser end-to-end or live deployment is claimed.

## Fork history

After selectively importing and reviewing these fixes, the upstream tip is recorded with an ancestry-only `ours` merge. Its source tree must match the fully reviewed pre-merge tree. This intentionally clears GitHub's behind count while retaining the fork's selected implementation and the deferred decisions above. Publication uses an ordinary fast-forward push and a subsequent GitHub comparison with upstream as the base.
