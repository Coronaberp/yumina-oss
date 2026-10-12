# Whole-message CPU content flags

Yumina records server-owned content audits for complete player messages and completed assistant responses, including offered choices. The cached `jaredpalmer/kev-0.8b` model answers one question with two choices, NSFW and SFW. A score of 40% NSFW or higher produces an NSFW flag. Each complete message is assessed once, without splitting by line, paragraph or character chunks.

The policy assesses actual adult or unsafe content in context. Sexual scenes and nudity remain NSFW in fiction; non-graphic fantasy danger and ordinary medical education are SFW. Pending, failed, missing, outdated and malformed checks cannot certify content as SFW. Their inspector labels describe the check state instead of presenting a failed check as a successful NSFW prediction. Kev scores are estimates, not provider policy certifications.

Story routing runs before generation, including when NSFW is unconfigured. The request guard checks complete outgoing sources, including history, choices, system instructions and memory. SFW transmission requires at least 95% SFW probability and at most 5% NSFW probability, plus no explicit NSFW topics or generation requests. NSFW and uncertain results go to the exact owned NSFW connection. Successful whole-message results are cached by policy, role and source hash; the bounded cache does not retain message text. Without an NSFW connection, unsafe, uncertain or failed checks block transmission; strongly safe requests may still use SFW. Little Idot uses the configured NSFW provider.

## Local worker

The server starts a private worker using `/var/home/staygold/kev/.venv/bin/python`. It loads existing cached weights offline with torch/fp32 on CPU only, uses four CPU threads, verifies tensor devices and stays warm. No public Kev endpoint, GPU fallback, paid classification API or model download is used.

Optional settings are `YUMINA_KEV_ROOT`, `YUMINA_KEV_PYTHON`, `YUMINA_KEV_MODEL` and `YUMINA_KEV_SCRIPT`. Encoding explicitly uses Kev's bounded serving context rather than its 384-token training default. Messages beyond that serving limit return `classifier_context_too_long`; other inference failures return sanitized errors. A failed check does not become SFW.

The current policy identifier is `kev-whole-message-v4`. The validated whole-message classification question is unchanged, while routing eligibility is stricter. Old strict-policy and previous whole-message audits are stale and the bounded background sweep rechecks active messages. Source edits and choice changes invalidate audits in the same database transaction. Completion checks the captured variant, source hash and pending nonce, preventing obsolete results from certifying edits or replacing another variant's audit.

## Inspection

Default VN: Menu → Content flags. Classic: composer + → Content flags. Custom UI: `api.showContentFlags()`, `api.getContentFlags()` and `api.retryContentFlag(messageId)`.

Owner-only endpoints are `GET /api/sessions/:id/content-flags` and `POST /api/sessions/:id/content-flags/retry` with `{ "messageId": "..." }`. The inspector shows the latest 50 messages, selected variants, check states, completed probabilities and retry actions. It does not expose story text through the inspection endpoint. Inactive variants are checked when selected.

`messages.content_flags` and each swipe's `contentFlags` retain the versioned audit. Pending/error records remain fail-closed internally, while the UI distinguishes them from completed labels. A completed SFW label can still require NSFW routing when confidence is insufficient or explicit NSFW cues are present; the inspector shows both probabilities and separates the content label from routing eligibility. Classifier-only writes do not invalidate memory or generation fingerprints; public replay swipes omit private audits. `contentFlagTurn()` describes a completed turn and must not substitute for checking an outgoing request before generation.

Source: `packages/shared/src/content-flags.ts`, `packages/server/src/lib/content-flag-policy.ts`, `kev-content-classifier.ts`, `content-flag-service.ts`, `story-content-routing.ts`, `packages/server/scripts/kev-content-flags.py`, and `packages/server/src/db/content-flags-ddl.ts`.
