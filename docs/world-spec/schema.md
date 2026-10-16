# World Schema

A Yumina world is stored as a JSON object called `WorldDefinition`. This is the complete schema.

## Top-Level Structure

```json
{
  "id": "uuid",
  "version": "21.0.0",
  "name": "World Name",
  "description": "Short description",
  "author": "Creator Name",
  "language": "en",

  "entries": [],
  "variables": [],
  "rules": [],
  "reactions": [],

  "rootComponent": null,
  "components": [],
  "audioTracks": [],
  "bgmPlaylist": null,
  "conditionalBGM": [],
  "customUI": [],

  "entryFolders": [],
  "customTags": [],
  "customTagColors": {},
  "editorMode": "advanced",

  "settings": {
    "maxTokens": 12000,
    "maxContext": 200000,
    "temperature": 1.0,
    "topP": 1,
    "frequencyPenalty": 0,
    "presencePenalty": 0,
    "playerName": "Player",
    "lorebookScanDepth": 2,
    "lorebookRecursionDepth": 0
  }
}
```

## Field Reference

### Identity

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID, auto-generated |
| `version` | string | Schema version, currently `"21.0.0"` |
| `name` | string | World name (1-200 chars) |
| `description` | string | Short description (0-10,000 chars) |
| `author` | string | Creator's display name |
| `language` | string (optional) | BCP 47 language code (`"en"`, `"zh"`, `"ja"`, etc.). Present in TypeScript interface but optional in Zod schema. |

### Content

| Field | Type | Description |
|-------|------|-------------|
| `entries` | WorldEntry[] | All content the AI reads — characters, lore, rules, greetings |
| `variables` | Variable[] | Game state definitions with behavior rules |
| `rules` | Rule[] | WHEN/IF/THEN automation triggers |
| `reactions` | Reaction[] (optional) | Event-pattern-based rules (newer system). Can be undefined. |
| `chapters` | StoryChapter[] (optional) | Starting chapters and their optional authored `events`: prerequisites, ordered scenes, required moments and lasting effects. |

### Chapter events

Edit **Chapters → Events** or use `write_chapter.events`. Supplying the array replaces that chapter's full event list; omitting it preserves existing events. Stable event, scene and moment IDs preserve playthrough progress. Draft events default to disabled.

An event has `id`, `name`, `enabled`, author-only `description`, start `conditions` and `conditionLogic` (`all` or `any`), ordered `scenes`, final `effects` and `entryChanges`. Each scene has `id`, `name`, playable `instructions`, `requiredMoments` (`{id, description}`), optional all-match `completionConditions`, and its own `effects` and `entryChanges` (`{entryId, enabled}`). Effects use declared variable IDs and the normal engine operations (`set`, `add`, `subtract`, `multiply`, `toggle`, `append`, `merge`, `push`, `delete`) with a `value` and optional `valueRef`.

Only one event in the active chapter runs at a time. Existing active progress takes priority; otherwise the first enabled event with matching prerequisites starts. Start conditions do not cancel it after activation. Only the current scene is prompted; future instructions and author notes are withheld. Required moments accumulate across replies when a low-thinking server check returns exact supporting quotes from the final narrative. This semantic check is model-assisted and fallible. Invalid evidence, uncertainty or an unavailable check leaves the scene pending without rejecting the story reply. Plans, mentions and completion tags are insufficient. A scene needs required moments or completion conditions; all must pass before it advances, at most one scene per reply.

Scene effects apply once on scene completion; final effects apply once after the last scene. Variable changes feed Behaviors and the normal turn change ledger. Lore toggles retain ordinary lorebook, chapter and keyword gates. For a transformation, declare the replacement character entry first, then disable the old version and enable the new one. Use `aiAccess: "read"` for variables whose changes should be controlled exclusively by authored events/Behaviors.

The engine stores progress under `GameState.storyEvents`, outside model-writable variables and UI state patches. Snapshots, branches and replacement replies carry or restore it alongside variables and lore toggles. Completed events do not automatically restart; disabling an event pauses its saved progress. Events stay inside a chapter and do not perform chapter transitions. Existing cards without events retain their behavior.

### Presentation

| Field | Type | Description |
|-------|------|-------------|
| `rootComponent` | RootComponent \| null | Custom UI virtual filesystem (React/TSX) |
| `components` | GameComponent[] | Built-in UI components (stat bars, etc.) |
| `audioTracks` | AudioTrack[] | BGM, SFX, and ambient tracks |
| `bgmPlaylist` | BGMPlaylist \| null | Auto-play music configuration |
| `conditionalBGM` | ConditionalBGM[] | State-triggered music |
| `customUI` | CustomUIComponent[] | Legacy UI system (use rootComponent instead) |

### Organization

| Field | Type | Description |
|-------|------|-------------|
| `entryFolders` | EntryFolder[] | Folder structure for organizing entries |
| `customTags` | string[] | Creator-defined tags for entries |
| `customTagColors` | Record\<string, string\> | Tailwind color classes for custom tags |
| `editorMode` | `"simple"` \| `"advanced"` | Editor complexity level |

### Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxTokens` | number | 12000 | Max tokens per AI response |
| `maxContext` | number | 200000 | Max context window size |
| `temperature` | number | 1.0 | AI creativity (0.0-2.0) |
| `topP` | number | 1 | Nucleus sampling threshold |
| `frequencyPenalty` | number | 0 | Penalty for repeated tokens |
| `presencePenalty` | number | 0 | Penalty for already-used tokens |
| `playerName` | string | "Player" | Default <code v-pre>{{user}}</code> replacement |
| `lorebookScanDepth` | number | 2 | How many recent turns to scan for keywords |
| `lorebookRecursionDepth` | number | 0 | How many levels of triggered-entries-triggering-entries |
| `topK` | integer (optional) | — | Limits candidate token count (min: 0) |
| `minP` | float (optional) | — | Minimum probability threshold (0-1) |
| `structuredOutput` | boolean (optional) | false | Forces JSON output format |
| ~~`lorebookBudgetPercent`~~ | ~~number~~ | — | **Deprecated** — token budgets were removed; all triggered entries are now included |
| ~~`lorebookBudgetCap`~~ | ~~integer~~ | — | **Deprecated** — see above |
| ~~`layoutMode`~~ | ~~string~~ | — | **Deprecated** — layout is automatic; field ignored |
| ~~`uiMode`~~ | ~~string~~ | — | **Deprecated** — layout is automatic; field ignored |
