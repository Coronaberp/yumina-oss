# Player personas

Every session has exactly one persona. Players can choose and change a personal persona or a creator preset before starting a story and throughout its greeting. The default copies the current profile once; accounts without a selected profile receive a generic Player persona. Classic exposes this through the composer's Persona action; VN exposes it in Menu → Persona. After the first turn begins, selection is fixed for that save. Rewinds and branches preserve identity; an explicit story restart returns to the greeting.

The editor's **Personas** section creates optional player identities for either Classic or VN:

```json
{
  "personaPresets": [{
    "id": "academy-student",
    "name": "Academy student",
    "avatarUrl": "/api/assets/example.png",
    "sprites": {
      "normal": "/api/assets/normal.png",
      "happy": "/api/assets/happy.png"
    },
    "appearance": "A blue academy coat",
    "personality": "Curious and cautious",
    "backstory": "A new arrival at the academy"
  }]
}
```

IDs are unique and stable. Up to 50 presets are allowed. Name: 50 characters; appearance/personality: 2,000 each; background: 5,000. Presets contain no private notes, stats, variables, effects or initial status. Their selected public identity is snapshotted into the save; later preset changes cannot rewrite an ongoing story.

Personal personas and creator presets may each store six optional VN stage sprites: `normal`, `happy`, `sad`, `angry`, `shy`, and `smug`. These expression cutouts travel with the selected persona snapshot and appear when the player speaks. If the selected persona has no sprite set, the VN uses a stable sprite from the existing NPC pool/default assets; it does not infer gender from the persona name. Portraits remain available in the dialogue log.

New-session POST accepts `personaSelection: {kind:"account"}`, `{kind:"player",id:"owned-persona-id"}` or `{kind:"preset",id:"preset-id"}`. `account` captures the current profile for this save; later account-default changes do not replace it. During the greeting, `PUT /api/sessions/:id/persona-selection` accepts `selection` plus the last `expectedVersion`. A started story returns 409. Existing persona and persona-lock endpoints enforce the same restriction and reject empty identity or unlock requests. There is no per-session disable toggle. Legacy saves bind their saved identity once; an empty legacy save receives the current profile during its greeting, or Player if none is available.

Persona details are quoted descriptive data for the model. Creator mechanics and current game-state stats take precedence. Model requests use literal `{{user}}` for the player's name; the front end renders the display name and portrait independently. Prompt instructions embedded in persona fields cannot grant initial stats or rewrite the configured state.

Player references remain literal `{{user}}` in stored story replies and model requests. The front end substitutes the selected persona's name in narration, dialogue, choices and reasoning; speaker labels retain the persona portrait. The model receives the descriptive persona fields without the account or persona display name, including session-bound creator presets in side calls.

Player control is a platform output rule: models must never write the persona's speech, voluntary actions, thoughts, feelings, intentions or decisions, including repeats of the latest player input. They describe NPC/environment reactions and offer choices without enacting them. Generated replies are buffered; explicit player dialogue blocks and recognizable narrated player actions are automatically purged before display and persistence, including generated presentation segments. NPC prose, choices and gameplay deltas are retained. If all prose is removed, a neutral narrator pause keeps the turn playable. The filter also runs for regeneration, continuation and AI endings, independently of the optional state-update guard; authored greetings and authored endings remain creator content. Ambiguous pronouns cannot reliably be attributed by this deterministic filter, so the model instructions still require the literal player token.
