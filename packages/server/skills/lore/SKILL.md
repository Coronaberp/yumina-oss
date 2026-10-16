---
name: lore
description: Design layered worldbuilding AND multi-route cards — shared universes, chapters covering eras or alternate timelines, greeting-linked worldbooks (knowledge bases), per-opening scenarios, activation gating, factions, discoverable lore, frontend lore toggles. Use for chapters/worldbuilding/canon/history, different times or timelines, multiple knowledge bases / routes / scenarios / branching openings, worldbook activation, or player-controlled lore (LoreButton/LoreSlot).
---

# Skill: Lore Design

Plan lore as a layered world system, not a pile of unrelated entries.

## Workflow

1. Identify the lore job: foundation canon, factions, timeline, character lore, discoverable entries
2. Read what already exists before replacing it.
3. Decide the edit surface: entries only, entries + variables, entries + rules
4. Explain what you will create before calling write tools.

## Where to Put Lore

| Lore type | Section | Why |
|-----------|---------|-----|
| Core canon, character identity, scenario | system-presets | Always available to the AI, token-efficient (sent once, cached) |
| Discoverable knowledge (factions, locations, items, history) | chat-history + keywords | Only sent when relevant — saves tokens, surfaces contextually |
| Format enforcement, critical reminders | post-history | Strongest AI attention, use sparingly |

**Token strategy**: system-presets entries are always sent but cached — a 2000-token character description costs little after the first turn. chat-history entries only appear when triggered — ideal for large lore libraries where most entries aren't relevant every turn.

## Worldbooks (Knowledge Bases) — one card, many routes

A card can hold MULTIPLE worldbooks (the editor calls them "knowledge bases"). Each worldbook is a named, independently-activatable group of entries. **Only ACTIVE worldbooks' entries reach the AI**, so a single card can carry several routes / scenarios / chapters and still stay within budget.

- An entry belongs to a worldbook via `worldbookId`. An entry with no `worldbookId` lives in the always-on **Core** book.
- A worldbook's `activation` mode decides when it's online:
  - **always** — always online (like Core).
  - **conditions** — online only while variable conditions pass (e.g. `route == "mayu"`). Same condition shape as entry `conditions`.
  - **greeting** — online only when the player started on one of its bound openings (`greetingIds`).

### Two-layer gating (read this before designing routes)

Worldbook activation is the **OUTER** gate, evaluated FIRST. Then each surviving entry's own trigger (`alwaysSend` / `keywords` / `conditions`) runs **WITHIN** the active set:

- `alwaysSend` on an entry means "always send **while its worldbook is active**" — NOT globally. An alwaysSend entry in an *inactive* worldbook is dropped.
- A keyword/condition entry in an active worldbook still needs its keyword/condition to fire.

Mental model: **pick the active books first → then run the usual matching inside them.** This is why putting two contradictory route books on `always` injects both — gate them by opening or condition instead.

### Building routes (the headline use)

"One card, multiple routes" is built two complementary ways — usually together:

1. **Greeting-bound worldbook** — bind a worldbook to opening(s): set its activation to `greeting` with the opening's greeting `id`(s). Picking that opening turns the book on; the other routes' books stay off.
2. **Opening seeds variables** — a greeting carries `initialVariables` (a map of `variableId` → starting value) seeded into session state when that opening is chosen. Use it to set a route flag (e.g. `route = "mayu"`) that `conditions`-mode worldbooks, conditional entries, and the frontend key off.

The chosen opening is a first-class session fact (engine `activeGreetingId`), so greeting-mode activation is revert/branch safe — never store "current route" in a throwaway field; use a declared variable (via `initialVariables`) or the greeting binding.

Per-opening starting values are edited in the editor under **Variables → Per-opening values** (a matrix; the First Message panel mirrors it read-only).

### Native chapter management

For sequences **inside** a chapter, author its **Events** section with `write_chapter.events`: start prerequisites, ordered scenes, required moments, optional all-match completion conditions, and once-only variable effects/lore `entryChanges` on scene or event completion. Read the whole chapter first; supplying `events` replaces its complete list, while omitting it preserves it. Keep stable event/scene/moment IDs. New events default disabled; enable after every scene has an observable required moment or a completion condition and all references validate. Event overview notes are author-only; put playable directions in the current scene's `instructions`. Only that scene is prompted, so later transformations stay hidden until due.

Progress lives in engine-owned `storyEvents`, is saved with snapshots and rewinds with reply replacement. Prerequisites select a new event in list order; an active event keeps priority even if a start condition is later consumed. All required moments must actually occur; the server uses a low-thinking review with exact narrative quotes. Mentions, plans, negations, invented completion tags and a failed review cannot advance it. A scene can span turns and at most one scene completes per reply. Effects apply once. Use entryChanges to disable an old character profile and enable its existing replacement; normal lorebook/chapter/keyword gates still apply. Events do not change chapters, force player dialogue, restart completed events, or certify their own completion. Do not turn a mission inside Holder into a separate starting chapter. Preserve the creator's authored wording/canon and validate_world after changes.

Use `write_chapter` for starting chapters, eras and alternate histories. Inspect `read_entities` with `ids:["chapters"]`; preserve stable existing IDs. Each chapter groups greetings with name, description and timeline/date labels. Bind lorebooks with `write_worldbook.chapterIds`, respecting enabled=false. Shared Core lore is unchanged. Characters stay role:"character" in their chapter's book.

Chapters are like greetings: choose them in the shared Routes picker before play starts. Selecting a linked greeting applies that greeting's initialVariables. After the greeting is left, both Routes and Chapters selection disappear. No in-play chapter navigation or manual transition is supported. Do not populate legacy nextChapterIds, conditions, transitionText or transitionVariables to offer continuation; preserve legacy data during unrelated edits. A timeline/date label does not transfer another save's history. Creation order does not imply chronology or divergence. Do not migrate existing cards without the creator's request. Validate chapter/greeting/book references with validate_world.

The greeting-bound recipe below remains useful for opening-specific lore without managed in-play transitions.

## Chapters in a shared universe: eras and alternate timelines

Use **chapters** as the creator-facing organization. A chapter groups its greetings, date/period, starting state, lore and character versions. It can cover an era of the same history or an alternate version of events. Several greetings may start the same chapter; a later chapter may also be playable independently. Chapter labels do not force linear progression or create alternate histories.

Distinguish **universe** (shared setting), **era** (a different time in the same history), **timeline** (a different version of events), and **playthrough** (one player's saved state). For example, CODE's Origin (2250), Holder (2280) and Cascade (2283) are chapters set in different eras of one main timeline. An alternate Cascade where an otherwise-dead character survived can be another chapter or another start in Cascade, on a different timeline. Use the creator's canon; never invent a divergence just because dates or chapter names differ.

Build these with existing greetings, variables and worldbooks, without inventing new top-level schema fields:

1. Read existing IDs and preserve the creator's wording. Keep only facts valid across all starts in Core. Put dated history, scenario, character roles/ages/abilities and alternate outcomes into the appropriate books. Editor folders and greeting text alone do not gate anything.
2. Create declared selector variables when needed, for example `chapter` and `timeline` (string, `aiAccess:"read"`), and `story-year` (number). An extra `era` variable is optional when `chapter` already identifies the period. Opening-controlled selectors should use the normal narrative scope, not `scope:"setup"`, which intentionally survives opening switches. Fixed values can be read-only; a clock that must advance needs an authored update mechanism.
3. Create `role:"greeting"` entries with stable IDs, ordered `position` values and complete `initialVariables` for the opening-controlled selectors:

| Greeting ID | Opening | initialVariables |
|---|---|---|
| `open-origin` | Origin — 2250 | `{ "chapter":"origin", "timeline":"main", "story-year":2250 }` |
| `open-holder` | Holder — 2280 | `{ "chapter":"holder", "timeline":"main", "story-year":2280 }` |
| `open-cascade` | Cascade — 2283 | `{ "chapter":"cascade", "timeline":"main", "story-year":2283 }` |

4. For independent starts, create the corresponding books with `write_worldbook`: e.g. `{ "id":"holder-history", "activation":{ "mode":"greeting", "greetingIds":["open-holder"] } }`. Assign every dependent entry using `write_entry { worldbookId:"holder-history" }`. The binding uses the greeting entry **ID**, never its name, position or swipe index. One book can list several greeting IDs when all its facts are valid in all those starts. Keep mutually incompatible versions in separate, mutually exclusive books.
5. An alternate greeting can seed the same `chapter` and year with a different `timeline`. Share that chapter's common lore across both greetings, but bind the main-history and alternate-history facts to their own greeting IDs. A separately named alternate chapter is also valid when the creator prefers it. Do not activate both conflicting books with `mode:"always"`.
6. Keep each character version `role:"character"` with a distinct entry ID, such as `mei-holder` and `mei-cascade`, while preserving the canonical name. Exactly one applicable version should be eligible per start. Reuse an appropriate owned portrait when available; a portrait is optional. Do not leave an old incompatible profile in Core alongside its gated replacement, or overwrite the earlier era's version with the later one.
7. Call `validate_world`, then inspect all starts: the intended variables are seeded, all referenced books/greetings exist, shared books remain available, and the other eras' or alternate histories' facts and character versions are excluded even when `alwaysSend:true`. Removing a book or misspelling its ID is unsafe: unknown book IDs fall back to Core. Validate before claiming isolation.

**Continuing through chapters/eras:** greeting-bound books stay tied to the selected starting opening (`activeGreetingId`); the passage of years does not switch them. When an authorized design needs in-play chapter transitions or time jumps, use conditions-mode books keyed to both current `chapter` and `timeline`, e.g. `{ "mode":"conditions", "conditions":[{ "variableId":"chapter", "operator":"eq", "value":"cascade" },{ "variableId":"timeline", "operator":"eq", "value":"main" }], "conditionLogic":"all" }`. The authored transition updates the selectors and date while preserving earned progress and actual history. Do not combine an old opening-bound character profile with its newly active later-era replacement.

Choosing a greeting seeds a starting scenario; it does **not** import another save, move its protagonist forward in time, or create a save branch. Use the platform's real playthrough branching/continuation flow where available, and report unsupported transfer work honestly. A fresh canonical sequel may use the creator's established backstory; a continuation must respect the player's recorded outcomes and cannot silently impose an assumed victory, death or relationship. Advice-only requests authorize explanation, not migration of existing cards or saves.

### Audience

An entry's `audience` controls who receives its content: `"ai"` (prompt only — hidden director notes), `"player"` (UI-facing only — the AI is NOT told it verbatim), `"both"` (default). Use `"player"` for codex/setting text the UI surfaces but the model shouldn't recite.

### Tools

- `write_worldbook` — create/update a knowledge base (`id`, `name`, `activation`, `enabled`, `order`). Activation is one of three modes only: `always`, `conditions` (variable-gated), `greeting` (active for listed opening IDs).
- `write_entry` with `worldbookId` — assign an entry to a book (omit / `""` = Core).
- `write_entry` on a `role:"greeting"` entry with `initialVariables` — seed a route's variables.
- `write_entry` with `audience` — set who sees an entry.
- `write_lore_binding` — wire a frontend slot to an entry (`slotId`, `entryId`, optional extra `conditions`) for `<LoreButton>`/`<LoreSlot>` player-controlled lore. Delete via `delete_entities` on the `slotId`.

Frontend-controlled lore (a player button toggles a book/entry on) uses `<LoreButton>` / `<LoreSlot>` in the rootComponent TSX (wired with `write_lore_binding`) — see the front-ui skill.

## Keyword Trigger Strategy

- Prefer a few strong keywords over many vague ones.
- Use `matchWholeWords` when names collide with common language ("rose" the character vs "rose" the flower).
- Use `secondaryKeywords` + `secondaryKeywordLogic` for multi-part reveals (primary: "ember court", secondary: "secret" with AND_ANY).
- Use `conditions` when lore depends on game state, not text matches.
- Use `preventRecursion` or `excludeRecursion` when chained lore would cause prompt bloat.

## When to Add Variables or Behaviors

- Add variables when lore depends on tracked state: reputation, faction membership, discovered locations, route flags
- **To gate lore on game state, put `conditions` directly on the entry** (or condition-mode worldbook). This is the modern path — do NOT route visibility through a behavior that toggles `@prompt.entry.<id>` (legacy/indirect; entries carry their own conditions now).
- If the user only asked for writing, don't invent mechanics unless the lore needs them to function

## Editing Guardrails

- Preserve existing canon unless the user explicitly asks for a rewrite.
- Reuse existing faction/place/character IDs when updating related lore.
- If replacing a lore system, read current entries first and summarize the replacement scope.
- For large worldbuilding: multiple focused entries > one monolith.

## Codeification Mode

When the user wants AI-optimized lore, produce compact structured blocks:

```text
[CODEIFIED_LORE::faction.ember-court]
entity_type: faction
essence: Imperial fire court built on ritual hierarchy.
public_truths:
- Rules eastern capitals through ceremony and debt.
- Treats oathbreaking as spiritual contamination.
relationships:
  ally: ash-cloister
  rival: river-league
ai_rules:
- Never describe the court as democratic.
- Mention ritual status before personal emotion.
```

- Keep prose entries for atmosphere. Codeified entries are companion references, not replacements.
- Put always-needed canon in system-presets. Put domain-specific codex in chat-history with keywords.
- Use stable kebab-case identifiers and explicit facts over paragraphs.

## Multiplayer Lore

When designing for multiplayer worlds:

- **DM-style system prompt**: Write a system-presets entry instructing the AI to manage multiple players as a narrator/DM
- **Per-player state**: Use a JSON variable (e.g., `players`) with dot-path addressing. No need for per-player entries.
- **Character-linked lore**: Use chat-history entries with character name keywords so lore surfaces when that character is discussed
- **Shared world state**: Use JSON variables for faction standings, world events, and locations that all players interact with
- The engine automatically includes a player roster in multiplayer prompts — no manual entry needed

## Response Pattern

Before write tools, name the exact surfaces:
- lore entries (which section, which keywords)
- supporting variables/rules (if needed)
- greeting or system prompt changes (if needed)

After changes, summarize: what each entry does, whether prose or codeified, and any variables/rules created.

## Anti-Patterns (avoid these)

- **One mega-entry** — stuffing all the world lore into a single 10K-token entry in system-presets burns context every turn. Split into focused entries; put always-needed canon in system-presets, discoverable lore in chat-history.
- **Keyword spam** — adding every synonym and related concept to `keywords`. Each keyword is a trigger; too many = noisy matches. Prefer 2-4 tight keywords per entry.
- **Contradictory active canon** — two simultaneously eligible entries that make incompatible claims about the same entity. Correct genuine mistakes with the creator's approval. Intentional era/timeline variants belong in mutually exclusive books; preserve them instead of deleting or merging distinct histories.
- **Codeified lore for atmosphere** — codeified format is compact but mechanical. Use prose for atmosphere (mood, tone, sensory detail), codeified for factual reference (faction tables, timelines).
- **Recursion without guardrails** — an entry that mentions a keyword triggering another entry that mentions yet another keyword can cascade and bloat the prompt. On a self-referencing lorebook this fires most of the pool every turn. Keep `lorebookRecursionDepth` at 0 unless chained reveals are essential; use `preventRecursion: true` on hub entries whose content would over-trigger. For a large keyword-lore library also set a `lorebookBudgetCap` (e.g. 20000–30000 tokens) as a ceiling, and tighten keywords (`matchWholeWords`, `secondaryKeywords`). The editor's per-turn estimate hides keyword-matched lore, so run `analyze_token_cost()` (it reports the keyword pool's worst-case per-turn injection and flags flood risk) to see the real cost. See the entries skill's "Lorebook Cost & Recursion" for the full fix hierarchy.
- **Hard constraints buried in lore** — "the character never does X" should be in a system-presets entry or post-history, not buried in a mid-tier lore entry that may not trigger.

## Validation Checklist

- [ ] Each entry has a clear, unique purpose (not duplicating another entry's scope)
- [ ] system-presets entries are only those needed EVERY turn (character identity, core scenario, hard constraints)
- [ ] chat-history entries have keywords OR conditions to trigger
- [ ] No contradictions between entries (especially character descriptions)
- [ ] Codeified lore uses stable kebab-case IDs and is paired with prose entries when atmosphere matters
- [ ] Any referenced variables (for conditional entries or macros) exist
- [ ] Every chapter/era/timeline greeting seeds the right selectors and activates only compatible history and character versions
- [ ] Later-era premises and alternate outcomes do not override a continued playthrough's actual history
