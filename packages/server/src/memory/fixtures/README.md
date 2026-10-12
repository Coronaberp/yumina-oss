# StoryHaven core parity fixtures

`parity.json` is generated from StoryHaven commit
`d2e2f96236bbc95512719204126395bd87561302`, with source SHA256 values
checked against `../source-manifest.json` by `core-parity.test.ts`.

Regenerate from an available local source repository:

```sh
python packages/server/src/memory/fixtures/generate-parity.py /path/to/StoryHaven
pnpm --filter @yumina/server test src/memory/core-parity.test.ts src/memory/contracts.test.ts
```

Python and Pydantic are development reference tools only. The generator reads
pinned files via `git show`, parses their AST, and executes explicitly selected
pure definitions. It never executes source imports or accesses source CFG,
environments, database connections, or provider endpoints. Model requests in
retry/fallback cases use a fake `_call`; the output records each exact prompt.
Product modules read neither this generator nor the source checkout.

The JSON records Python/Pydantic versions because their error diagnostics are
included in StoryHaven's corrected retry prompt. The current baseline is Python
3.14.7 and Pydantic 2.12.5; changing these can change diagnostic wording even when
the pinned source is unchanged.

Coverage includes all twelve fact types; active/location/presence, retention and
score formulas; stable order; Python codepoint token length; reserved skip and
scored break overflow; metadata values; fixed cluster budget/truncation; chunk
packing including oversized unspaced Unicode; exact extract/reconcile/lore,
secret and cluster prompt bytes; Pydantic coercions, ranges, defaults and errors;
JSON decoder diagnostics; OOC filtering, group exchanges, speaker attribution;
and validated retry/fallback prompt snapshots.

Observed RED runs before implementation:

- Initial core suite: missing `block.ts` module, one failing test file.
- Extended JSON/coercion cases: 21 failed, 138 passed.
- Transcript helper cases: missing helpers and missing prompt.py manifest hash.
- Noniterable facts: two model calls where Python makes one, fixed to preserve
  the source's TypeError versus ValueError retry boundary.

Final focused verification: 183 tests passed, zero failed. The Node 26 test loader
emits its existing `module.register()` deprecation warning. Server typechecking
passes using symlinks to the workspace's already installed server/shared/engine
package dependencies; dependency manifests and lockfiles were not changed.

`CoreFact` in `ranking.ts` is the minimal original dictionary shape, allowing
source lore pseudo-facts (`fact_type: "lore"`) without inventing persisted facts.
`CoreCluster` preserves original `summary_text` and `created_turn` names. The
transport adapter owns authentication/usage/settings and must honor exported
`EXTRACTION_PARAMS` when translating `MemoryModel.complete` into provider calls.
