# Normal chat and durable memory runtime QA

Run from the assembled repository:

```sh
pnpm --filter @yumina/server test src/memory/runtimeintegration.test.ts
pnpm --filter @yumina/server typecheck
```

The normal isolated test launcher supplies independent in-memory application and memory databases, prevents dotenv loading, and strips inherited credentials. The test imports the complete application database fixture, including the production wallet ledger guard, then mounts the actual message routes and memory profile/session route factories in Hono. Authentication uses the existing route-test pattern: a middleware injects a fixture owner, then switches to a foreign owner to verify profile/session rejection. It does not exercise OAuth or browser login.

Only `globalThis.fetch` is replaced. The real BYOK resolver, encrypted application API key, `CustomProvider`, serialized OpenAI-compatible request body/headers, SSE reader, usage logging, embedding transport, worker, repositories, snapshots, and control handlers execute unchanged. `.fixture.invalid` URLs and keys are deterministic fixture values; no provider request or billed model invocation leaves the process.

The two scenarios use 1024 and 3072-dimensional embeddings. Each creates and activates a profile through the profile API, verifies an existing session stays on its legacy backend until explicitly switched, sends six real chat turns, drains the durable worker, and checks the next serialized provider prompt for the accepted encrypted fact. A second batch supersedes the gate state, changes session lore, and reveals one hidden secret. Current prompts and both continuation routes must contain the accepted changes and exclude unrevealed authored content; historical regeneration must retain the eligible prior snapshot and exclude future changes. Restoring the original swipe must make its matching snapshot eligible again. Source supersession lineage remains available as annotated history, rather than as an active ongoing condition.

Each scenario also sends a separate 16-turn backlog before enabling worker processing, verifies the resulting five-exchange batch boundaries, deletes that session, drains the application deletion outbox, and checks that derived facts/snapshots are removed and the durable epoch is tombstoned. The test checks foreign-owner controls and distinct measured invocation receipts. The 1024 scenario also switches models through the profile reindex API, verifies the copied canonical fact vectors have 3072 dimensions, preserves the immutable source configuration, and checks the next normal chat prompt after migration.

For development QA, copy the assembled server, engine, and shared source into a disposable directory, add this test, and use the copied `scripts/test-local.mjs`. Keep dependency directories as read-only symlinks. Do not copy `.env`, run a live server, change production configuration, or restart an existing service. Copied source is compilation/test input and should not be committed over another worker's implementation.
