# StoryHaven memory in Yumina


AI config exposes prompt context (`maxContext`), recent conversation (`storyMemory`), and an optional recalled-memory ceiling (`memoryBudgetTokens`). A saved endpoint's Context window limits total input and output; prompt context can impose a smaller input ceiling. Reply/reasoning tokens and estimator headroom are reserved before prompt composition. Recent history and recall share the resulting input budget.

Recalled memory defaults to Automatic: it uses the space left after essential instructions, current state, and recent conversation. Setting a number adds an explicit recall ceiling (up to 100,000 tokens); clearing it restores Automatic. Standalone inspector previews retain StoryHaven's 1,000-token default when no ceiling is chosen. Actual story requests compute their available recall budget against the destination endpoint. They never pad unused space with irrelevant material.

Enabled, non-hidden character names remain in the static roster and retain their portrait/speaker identifiers. Biographies are excluded from the always-send prompt. A name or unique alias mentioned in the current request, latest exchange, or active scene selects that character's biography. Necessary biography chunks and lore enter the same bounded StoryHaven block as typed facts. Unneeded characters stay outside keyword and semantic recall, even if their embedding is similar. Legacy or unconfigured chats use bounded name-based biography selection until an embedding profile is activated.

Recall uses the chat's explicit `memoryBudgetTokens` first, then `preferences.aiConfig.memoryBudgetTokens`, then the shipped default. Account changes take effect on subsequent recalls, without writing over chat settings. Menu → Memory shows whether the recall budget is inherited; `Use account default` clears only that chat override. A settings PATCH with `{ "settings": { "memoryBudgetTokens": null } }` performs the same reset. Both Classic and VN use the same server retrieval path.

Yumina implements StoryHaven's memory system in TypeScript, pinned to source commit `d2e2f96236bbc95512719204126395bd87561302`. The original extraction, reconciliation, ranking, standalone budgeting/rendering, clustering, lore override and secret detection algorithms are retained. Complete story requests add a model-aware packing pass that counts headings and skips oversized optional candidates. Python is used only to generate reference fixtures; the application runs entirely in TypeScript/Node.

## Configure it

1. Open Settings → AI configuration → Memory embeddings.
2. Enter an OpenAI-compatible embedding endpoint, model, dimensions and optional API key. The source defaults are `Qwen3-Embedding-0.6B` and 1024 dimensions. Select “Send the dimensions parameter” only when your endpoint supports it.
3. Test the connection, then activate the profile. Changing endpoint/model/dimensions creates a new immutable profile. Activation reembeds existing canonical memory before switching the active profile; failed or stale attempts leave the prior profile active.
4. New sessions use StoryHaven after your first activation. Existing sessions retain their previous backend until you select StoryHaven in the Story memory panel.
5. Configure a BYOK text model for extraction in that panel. It can use your normal chat model when post-turn work is scheduled. Memory never falls back to a platform-paid model.

The built-in Story memory launcher is available in the composer and its compact tools menu. It exposes settings, editable/pinned/expired facts, lineage, persistent forgetting, summaries, lore overrides, individual secret reveals, recall preview, retry, clear and rebuild. The 13 source admin tunables are available per session; their defaults match StoryHaven.

## Independent storage

Local installs create an independent PGlite database at `<YUMINA_DATA_DIR>/memory`. Override that location with `MEMORY_PGLITE_DATA_DIR`. PostgreSQL installs can set `MEMORY_DATABASE_URL` to a **different database**, with pgvector installed or permission to create the extension and schemas. `DATABASE_URL` continues to hold ordinary Yumina data. Back up both stores and retain the encryption key.

Each user's immutable embedding profile has a generated schema containing the original `memory_facts`, `memory_vectors`, cursors, batches, reinforcement logs, clusters, memberships, lore, chunks, links, secrets, overrides, reveals, and vector tables. The original inline fact vectors and column layouts are preserved. Minimal identity mirrors bind these rows to the authoritative Yumina owner, session and world. Profile/job/provenance metadata lives outside those canonical tables.

Dimensions can be 1–16000, subject to the endpoint returning exactly that many finite nonzero float32 values. Schemas up to 2000 dimensions use pgvector HNSW cosine indexes; larger vectors use exact cosine searches over the original vectors. Different users and profiles never share a vector space. Credentials are encrypted and omitted from API responses; canonical memory text uses the source Fernet format with Yumina's own encryption key.

## History and disclosure

The app database owns selected answers and raw history, including compacted messages. Atomic triggers record selected-history changes, saved or held creator-world changes, and deletion tombstones in a durable outbox. Leased workers prepare provider outputs outside transactions and fence writes by owner, session epoch, selected-history prefix, active profile, credentials and claim generation.

Encrypted checkpoints preserve accepted batches. Historical regeneration uses only a matching earlier selected prefix; later facts, reinforcement, overrides and reveals cannot enter that prompt. Branches freeze an eligible checkpoint and forgetting ledger in the same app transaction as copied history, then materialize their own memory independently. Clear advances the settled frontier and invalidates older checkpoints. Rebuild explicitly starts from the beginning, retaining persistent forgetting.

World entries with role `character`, `lore`, or `custom` entries with memory metadata, are indexed by StoryHaven while that backend is active. Their raw authored content is removed from normal engine prompt assembly so session overrides remain authoritative. Hidden lore is excluded from keyword, semantic and linked recall, including hidden link names. Only individually revealed secret facts enter the memory block. The editor preserves metadata, links, hidden flags and authored secrets through save/undo/import. Disabled/deleted lore and changed secrets are reconciled against the complete authored world snapshot.

## Operations

Authenticated embedding routes are under `/api/memory/profiles`. Session controls are under `/api/sessions/:id/memory/storyhaven`. Health is reported as the `memory` component of `/health` and separately at `/health/memory`. Worker/database failures do not replace ordinary chat health with a success claim.

Usage records retain one invocation ID for every actual text-provider attempt, including failed/cancelled attempts. Unknown token/cost measurements remain null. Source parsing retries remain source-controlled. Retry/rebuild are explicit controls; a failed migration or memory operation does not activate partially prepared vectors.

On shutdown the memory worker is stopped, foreground chat streams are drained, and then the independent memory database is closed. Account, session and world deletions leave durable cleanup work for the memory store. Deleted accounts retain only an opaque owner tombstone to reject late profile/schema creation; encrypted fork payloads are removed from the app outbox after account or session cleanup commits. No StoryHaven production database or credentials are imported by this implementation.

Validation evidence and current test limitations are recorded in [the implementation verification note](qa/storyhaven-memory/verification.md).
