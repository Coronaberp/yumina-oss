# Studio name generator

Little Idot uses `generate_names` for new names. Construction, pronunciation checks,
full-name assembly and duplicate/similarity checks run locally in TypeScript. There
is no model or external service generating or scoring names. The Studio assistant
interprets the request and chooses tool parameters; direct CLI use needs no LLM.

The nine fictional phonetic styles are ported from StoryHaven's
`backend/names/en_names.py`: Japanese, Romance, Germanic, Slavic, Celtic, Arabic,
Nordic, Finnic and Persian inspired. They are not claims of authentic cultural names.
The port preserves the original weighted fragments, weirdness, gender variants,
pronunciation rules and Python-compatible seeded random draws.

## Use from Studio

Ask for names, for example: “Generate 10 Romance-inspired full names, family name
first.” Explicit naming requests require the generator tool. Names-only answers
come directly from its results. If an endpoint ignores tool selection, the server
discards invented names and reports an error. New character entry names must be
creator-supplied or an exact generated result.
Studio also checks literal surnames, particles, affixes and custom fragments against
creator messages or existing saved profiles. A model cannot supply an invented
surname as a literal tool argument or hide it in a newly created profile. Direct
CLI/configuration input is treated as author input.

`generate_names` accepts:

- `count` (1–100, default 20), `style`, `gender`, `weirdness` (0–1, default 0.35), `seed`.
- `format`: `given` (default), `surname`, or `full`.
- `order`: `given-family` (default) or `family-given`.
- `surnameStyle`, optional creator-authored fixed `surname`, and `particle`.
- `constraints` for given/single names and `surnameConstraints` for family names:
  `minLength`, `maxLength`, `minSyllables`, `maxSyllables`, `prefix`, `suffix`.
- `maxFullLength`, additional `exclude` names, and `avoidSimilar` (default true).
- `profileId` and optional creator-authored `phonetics` overrides.

Syllable limits count vowel groups, an estimate rather than linguistic analysis.
Generated phonetics/affixes use Latin letters; fixed surnames and particles can
contain Unicode letters. Defaults preserve 3–15-letter generated parts. Impossible
constraints fail after a bounded retry budget, with no LLM fallback.

Exact duplicates are always excluded after Unicode normalization, accent folding
and removal of punctuation/spacing. Near matches use local edit distance with
adjacent transpositions: one edit for names of at least four characters, two for
names of at least ten. Names shorter than four characters have exact protection.
Set `avoidSimilar: false` to allow near matches and receive explicit warnings.
Shared family names are supported; duplicate checks compare full displayed names.
Full names can share either given or family parts while retaining distinct complete
names. Similarity avoidance may require a more varied profile for a large batch.

The server excludes existing card entry names/aliases and earlier generated
batches from all retained Studio runs for that card. Batches are recorded in
`agent_runs.context.nameGenerationBatches`, under their tool-call IDs. A card row
lock serializes concurrent reservations. Replaying a call returns the same batch.
Starting a new run with the same seed excludes earlier reserved names, so it can
produce a different batch. Authored card data is not changed by name generation.
Deleting Studio run history also deletes its generated-name reservations; existing
card names remain protected.

## Creator-defined culture profiles

Profiles live in `world.settings.nameGeneratorProfiles`. `list_name_profiles`
returns their IDs and the installed styles. Read `settings` before updating the
profile array; `update_settings` replaces only the supplied array and preserves
other settings. Profiles survive card save/export/import and schema validation.

Example settings update:

```json
{
  "nameGeneratorProfiles": [{
    "id": "northern-clan",
    "label": "Northern clan",
    "region": "North",
    "species": "Elf",
    "clan": "Winter",
    "family": "Frost",
    "style": "nordic",
    "surnameStyle": "nordic",
    "format": "full",
    "order": "given-family",
    "surname": "Frost",
    "constraints": { "maxLength": 10, "minSyllables": 2, "maxSyllables": 3 }
  }]
}
```

Then call `generate_names({"profileId":"northern-clan","count":8})`.
Region/species/clan/family fields label the profile; they do not infer or invent
patterns. Options explicitly supplied for a batch override profile options;
constraint fields merge with the profile's constraints.

Optional `phonetics` defines weighted `[fragment, weight]` arrays for `starts`,
`middles`, and each gender under `endings`. It can also override `syllableWeights`
and `joiners`. Unspecified fields use the installed style tables. Custom fragments
must come from the creator; the assistant must not invent them to bypass the tool.

## Direct use with no LLM

From the repository root:

```sh
pnpm --filter @yumina/server exec tsx src/lib/studio-tools/name-generator-cli.ts --list
pnpm --filter @yumina/server exec tsx src/lib/studio-tools/name-generator-cli.ts --style romance --format full --surname Vale --particle de --order family-given --count 10 --seed example
```

`--config options.json` loads tool options, including constraints and exclusions.
`--profiles cultures.json --profile northern-clan` selects a profile from a JSON
array. `--json` returns structured given/family parts and similarity warnings.
CLI calls do not access the database: use `exclude` in the configuration to protect
names across CLI batches. Studio adds the persistent per-card registry.

## Source and verification

- `packages/shared/src/name-generator.ts`: validated profile/constraint schemas.
- `packages/server/src/lib/studio-tools/name-styles.ts`: original phonetic tables.
- `name-generator.ts`: local generation, full names, constraints and edit distance.
- `name-registry.ts`: reservations, ownership checks and replay behavior.
- `name-request.ts` and `name-write-guard.ts`: Studio enforcement.
- `fixtures/name-generator-python.json`: 85 seeded reference batches from Python,
  covering all nine styles, all genders, weirdness 0/0.35/1 and integer/string seeds.
