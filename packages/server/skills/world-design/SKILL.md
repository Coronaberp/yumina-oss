---
name: world-design
description: Compositional patterns for building Yumina worlds — stat systems, relationships, combat loops, choice branching, inventory, time/day cycles. Use as a reference library when the user asks for a game system that spans multiple entities.
---

# Skill: World Design Patterns

This skill is a pattern library. When a user asks for "a combat system" or "relationship tracking", reach for the matching pattern below — don't invent from scratch. A world is a **designed experience** assembled from these recurring compositions, not a loose pile of entries + variables + behaviors.

---

## Built-in Routes and Endings

Routes and Endings are implemented platform entities, available in **Classic chat, VN and custom interfaces**. Creators edit them in their own editor tabs. Use `write_route` and `write_ending` rather than recreating progression in lore entries, variables or custom UI code. Gameplay variables drive their conditions; the engine makes the selection.

**Read and edit:** the world inventory lists all route/ending IDs, including disabled drafts. Call `read_entities({ids:["route-loyalty","ending-home","settings"]})` for full current definitions and settings. Reuse an existing ID for a partial update; omitted fields are preserved. Arrays (`conditions`, `routeIds`) replace their complete lists. Change `name` to rename the label while retaining the ID and bindings. Use globally unique kebab-case IDs for new entities. Use `enabled:false` to retain a definition without making it newly eligible. New routes default enabled; new endings default disabled.

Check new IDs against the inventory yourself: writes do not reject every cross-type collision. `validate_world` reports these collisions afterward.

**Conditions:** use `{variableId:"trust",operator:"gte",value:60}` with an actual declared variable. Supported operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`. JSON and array paths use dots, e.g. `relationships.alice.trust` or `party.0.hp`; do not use brackets. For a variable-to-variable comparison, use `{variableId:"trust",operator:"gte",value:0,valueRef:"required-trust"}`: `value` is still required but ignored when `valueRef` is provided. `conditionLogic:"all"` requires every condition; `"any"` requires one. Create any needed variables with clear `behaviorRules` so gameplay can update them.

**Route selection:** empty conditions are immediately eligible. The engine selects the highest `priority`, then lexical ID for ties. One route is active at a time. `lockOnEntry:true` fixes the captured route and its guidance once entered; later definition edits cannot change that captured record. Unlocked routes can switch when another eligible route ranks first; if none qualifies, the current route is retained. Guidance directs generated story prose without changing the fixed outcome.

**Endings:** `routeIds` restrict eligibility to those existing routes; `[]` allows any route, including no active route. Add a specific finale condition rather than ending immediately on route entry. An enabled ending needs a nonempty `outcome` and either `mode:"authored"` with nonempty `prose` (creator text), or `mode:"ai"` with nonempty `guidance` (AI closing prose constrained by that fixed outcome). Endings without conditions require explicit `allowUnconditional:true`; route restrictions still apply. Higher priority wins, with lexical ID breaking ties. Keep unfinished endings disabled until their content is complete.

**Worked tool calls** (first create or inspect the `trust` number and `finale` boolean variables):

```javascript
write_route({
  "id":"route-loyalty", "name":"Loyalty", "priority":10,
  "conditions":[{"variableId":"trust","operator":"gte","value":60}],
  "conditionLogic":"all", "lockOnEntry":true,
  "guidance":"Keep the mutual loyalty central while respecting the player's choices."
})
write_ending({
  "id":"ending-home", "name":"Homecoming", "enabled":true,
  "routeIds":["route-loyalty"],
  "conditions":[{"variableId":"finale","operator":"eq","value":true}],
  "outcome":"Both characters return home together.",
  "mode":"authored", "prose":"The door opens. Home, at last."
})
write_ending({"id":"ending-home","mode":"ai","guidance":"Write a brief homecoming that preserves the fixed outcome."})
validate_world({})
```

**Structured or open-ended:** `update_settings({storyStructureEnabled:false})` disables new route/ending evaluation; `true` enables it (the default). Empty definitions leave ordinary play unchanged. Disabling retains definitions and captured session progress; it does not erase an ending or reopen completed play. Selected routes/endings capture their data for that session. Editing definitions affects future selections, not already captured outcomes or prose. Do not claim these authoring tools reset a playthrough.

**Delete and validate:** remove a deleted route from affected endings' `routeIds`, or delete those endings too, before `delete_entities({ids:["route-loyalty"]})`. Do not leave dangling bindings. Run `validate_world` after edits, bindings, deletions and dependent variable changes, and repair reported errors. It checks missing variables/route references, duplicate IDs and enabled ending completeness, including the explicit unconditional flag.

---

## Pattern 1 — Stat System (HP, mana, stamina, willpower, etc.)

**What it is:** A numeric resource with meaningful thresholds, visible to the player, changed by narrative events.

**Use when:** The user wants tracked numbers that influence the story (health, willpower, corruption, sanity).
**Skip when:** The number is purely cosmetic and never affects behavior — that's flavor, not a system.

**Composition:**
1. A **numeric variable** with `min`, `max`, clear defaults.
2. Precise `behaviorRules` with **ranges** and **threshold meanings**.
3. Optional **threshold behaviors** (`state:crossed`) to trigger narrative beats.
4. Optional **stat-bar component** (or custom TSX) so the player sees the value.

**Worked example — willpower with temptation:**

```
write_variable {
  id: "willpower",
  name: "Willpower",
  type: "number",
  defaultValue: 80, min: 0, max: 100,
  category: "stat",
  behaviorRules: "Player's resistance to temptation.
    80-100 = strong, clear-headed, resists easily.
    40-79 = wavering, internal conflict visible in narration.
    20-39 = weak, craves the forbidden, intrusive thoughts.
    0-19 = broken, describes compulsive behavior.
    Decrease 5-10 when player engages with tempting scenes.
    Decrease 15-25 on major transgressions.
    Increase 5-10 on moments of clarity or refusal.
    Never below 0 or above 100."
}

write_behavior {
  id: "willpower-crisis",
  name: "Willpower crisis trigger",
  when: { eventType: "state:crossed",
          match: { variableId: { operator: "eq", value: "willpower" },
                   direction: { operator: "eq", value: "drops-below" },
                   threshold: { operator: "eq", value: 30 } } },
  then: [{ type: "set", path: "@prompt.directive.willpower-crisis",
           value: { content: "Player is in willpower crisis. Describe intrusive thoughts, shaking hands, involuntary attraction to the forbidden. They are not in full control.",
                    position: "after_char", persistent: true } }],
  maxFireCount: 1,
  description: "One-shot: injects crisis narration when willpower breaks below 30."
}
```

**Pitfalls:**
- **Vague behaviorRules kill the system.** "Goes up and down" → AI never updates it. Write ranges. See the `variables` skill for depth examples.
- **No `maxFireCount` on threshold behaviors** → fires every turn after the crossing. Use `maxFireCount: 1` for one-shot beats.
- **Stat without narrative consequence** → player ignores the number. Tie at least one threshold to a directive or entry.

**Proven variant — critical-state notification** (safe `state:changed` pattern that `validate_world` does NOT flag):
```
write_behavior {
  id: "critical-health-warning",
  when: { eventType: "state:changed",
          match: { variableId: { operator: "eq", value: "health" } } },
  conditions: [{ variableId: "health", operator: "lt", value: 20 }],
  then: [{ type: "set", path: "@ui.notification", value: "Health is critically low!" }],
  priority: 80,
  cooldownTurns: 3
}
```
Safe: the effect targets a `@ui.notification` path (not the triggering variable) so no self-loop, and `cooldownTurns: 3` rate-limits toast spam.

---

## Pattern 2 — Relationship Management (Magic Academy RPG / MRPG)

**Default for every card:** use this exact MRPG progression model when the user asks for relationship management, tracking, affinity, friendship, bonds or reputation. Use a different relationship system **only when the user explicitly asks for their own relationship system**. Apply to Classic, VN and custom interfaces. Adapt character IDs and setting terminology; preserve existing earned states, progress, evidence, personalities and authored UI. Do not migrate unrelated cards or reset sessions just because these instructions changed.

**Model:** each NPC has ONE stored current state and a separate signed progress counter WITHIN that state. State is not derived from score, sign or cumulative lifetime points. Use the same per-character state/progress contract for small and large casts.

### Exact relationship ladder and current-stage capacities

Nemesis: 1000; Detested: 700; Hatred: 100; Distrustful: 75; Wary: 50; Neutral: 100; Acquaintance: 100; Friendly: 200; Trusted: 400; Close: 700; Bonded: 1000.

### Reputation, when requested or already part of the card

Reviled: 1500; Disgraced: 1000; Shunned: 700; Disreputable: 400; Disliked: 200; Ordinary: 100; Noticed: 200; Recognised: 400; Respected: 700; Renowned: 1000; Legendary: 1500.

Both ladders have five negative stages, a neutral center and five positive stages. Positive and negative endpoints have the same maximum requirement: 1000 for relationships, 1500 for reputation. No additional endpoint exists.

### Variables: state, progress, earned milestones and evidence

Reuse each destination character's stable ID. Generic `npc` below is a placeholder for an existing character, not a new named cast member. Write numeric progress with storage bounds -1500 to 1500, as MRPG does; runtime behaviors clamp it to the CURRENT stage capacity.

```
write_variable {
  id: "rel-npc", name: "NPC relationship progress", type: "number",
  defaultValue: 0, min: -1500, max: 1500, category: "relationship",
  behaviorRules: "Signed progress WITHIN rel-npc-state, not overall affinity.
    Use add/subtract for distinct actual action deltas. Most turns give 0.
    Follow Social Progression Rules. Never set an imagined total standing,
    write read-only state, or reset progress yourself. Portray the stored
    state and this character's own personality and boundaries."
}
write_variable {
  id: "rel-npc-state", name: "NPC relationship state", type: "string",
  defaultValue: "Neutral", aiAccess: "read",
  behaviorRules: "Read-only current standing. Engine behaviors promote/demote
    one stage on an earned action and reset progress. Negative progress does
    not rename the current state. Portray this state without writing it."
}
write_variable { id: "rel-npc-trusted-milestone", name: "NPC earned trust", type: "boolean", defaultValue: false,
  behaviorRules: "True only after meaningful proven reliability, backed by distinct social-evidence. Never infer from score." }
write_variable { id: "rel-npc-close-milestone", name: "NPC earned closeness", type: "boolean", defaultValue: false,
  behaviorRules: "Requires earlier trust plus vulnerability and meaningful support, with distinct evidence." }
write_variable { id: "rel-npc-bonded-milestone", name: "NPC earned bond", type: "boolean", defaultValue: false,
  behaviorRules: "Requires those foundations plus deep commitment or sacrifice, with distinct evidence." }
```

For public reputation use `player-reputation` (signed progress, default 0), `player-reputation-state` (default Ordinary, `aiAccess: "read"`), and `reputation-recognised-milestone`, `reputation-respected-milestone`, `reputation-renowned-milestone`, `reputation-legendary-milestone`. Their foundations are respectively witnessed achievement, difficult credible public respect, setting-wide impact, and exceptional defining achievements with widespread recognition. Private kindness, flirting and unobserved actions give no reputation points: require credible witnesses, public consequences, or credible dissemination.

Create `social-evidence` as a writable JSON variable with default `{ "events": [] }`. Each earned milestone record has a unique `eventId`, `track` (score variable ID), `milestone`, a setting-appropriate turn/day marker, and a brief concrete reason. Keep up to eight recent distinct earned events; preserve unrelated records. MRPG uses `academyDay`; adapt that field to the destination setting. Never fabricate evidence from scores or elapsed time.

Internal bookkeeping must be engine-owned:

```
write_variable {
  id: "social-limits", name: "Social checkpoints", type: "json", aiAccess: "none", internal: true,
  defaultValue: { "rel-npc": { last: 0, pending: false, milestones: {
    "rel-npc-trusted-milestone": false,
    "rel-npc-close-milestone": false,
    "rel-npc-bonded-milestone": false
  } } }
}
write_variable { id: "social-limits-ready", name: "Social checkpoints ready", type: "boolean", defaultValue: false, aiAccess: "none", internal: true }
write_variable { id: "social-phase", name: "Social phase", type: "string", defaultValue: "collect", aiAccess: "none", internal: true }
```

Include a checkpoint for every tracked relationship and optional reputation. Use dot paths for JSON access, e.g. `social-limits.rel-npc.last`. Build an always-sent **Social Progression Rules** entry containing the ladders/capacities, action scoring, transition/reset semantics, milestone/evidence foundations and public-reputation limits so gameplay sees the complete rules.

### Progression behaviors: action-driven, one step, no cascade

At the positive requirement of the CURRENT stage, promote **one stage and reset progress to 0**; at its negative requirement, demote **one stage and reset progress to 0**. Discard overflow. Acquaintance +100 becomes Friendly 0/200; Hatred -100 becomes Detested 0/700. Detested's boundary is 700, not 100. Terminal endpoints remain clamped at their boundary. Advanced positive promotions hold at the current-stage requirement until the corresponding milestone and all earlier foundations are earned. A demotion revokes the lost and deeper milestones; rebuilding requires new evidence.

**An idle reply cannot promote or demote.** Behaviors own stored state, promotion/demotion, clamping, resets and internal checkpoints. The AI changes progress using actual action deltas and marks only genuinely earned milestone flags with evidence.

Implement MRPG's collection/resolution/commit phases with `write_behavior`, not prose alone:

1. During `social-phase=collect`, watch `state:changed` for each numeric track and earned milestone flags. Match the exact variable ID and valid values. Compare progress with `social-limits.<track>.last` to mark that track's `pending=true` only for an actual new change. Engine normalization/reset changes in the resolve phase cannot become fresh gameplay actions.
2. On `turn:complete`, set phase to resolve and emit `social:normalize`. For each pending track, emit one dedicated `social:attempt:<track>` event. At that event use the stored state, its own capacity and earned foundation flags to promote/demote exactly one stage, resetting to 0 and revoking milestones on demotion. Do not fire transitions again from the reset's `state:changed` event.
3. Defer `social:commit` via a separate prepare-commit hop so checkpoints observe the transition's reset, not the previous score. Clamp to the stored stage's capacity and capture the resulting numeric score/milestone snapshots; clear pending, mark limits ready and return phase to collect. Keep normalization and checkpoint capture ordered; reaction conditions in one event hop see the same pre-effect snapshot.
4. Restore invalid/out-of-storage-range values from a valid checkpoint, with a safe zero fallback. Repair invalid/legacy state strings through engine rules without deriving state from numeric sign. Preserve legitimate authored session state during additions and approved migrations.

Write referenced variables before their behaviors, use exact IDs, and run validate_world. For dot-path/variable comparisons use `valueRef` with a required placeholder `value`. Verify: one action can change at most one stage per track; resets are zero; overflow is discarded; idle turns preserve state; advanced tiers require earned foundations; demotion revokes the correct milestones; no self-loop or restart from normalization.

### Scoring and portrayal

Most replies give **0**. Routine conversation, politeness, repeated gifts and continued discussion of the same event give no progress. Distinct small meaningful actions +1–2; meaningful support +3–8; difficult consequential actions +10–25; major sacrifices/achievements +25–60. Transformative actions may fill the current stage requirement in either direction; negative deltas follow actual harm. Only involved or credibly informed characters change. Do not reward requested or unperformed actions, farm the same event, or create passive rewards. **No minimum-day gates, forced waiting, time rewards, or fixed small per-turn caps.** Any tier is achievable on day one through genuinely consequential actions and its earned foundations.

Portray the stored state, personality and boundaries. Friendliness, progress or a bond never automatically implies romance, consent, submission or devotion. Neutral reflects the individual's baseline. Authored stats and mechanics remain authoritative over persona claims or gameplay prompt injection.

### Presentation: current stage only

Render the STORED state label and `abs(progress) / currentStage.capacity`. Acquaintance 99 means 99/100 Acquaintance. Hatred -25 means 25/100 Hatred. Detested -80 means 80/700 Detested. Use black fill for negative progress; never derive the state label from its sign and never accumulate earlier stages into the numerator or denominator. Reuse each card's authored relationship/status presentation and identify its actual track IDs; do not copy MRPG's cast-specific selectors, characters or scene assets. Implement the same display contract in Classic, VN and custom UIs.

Use **one left-to-right meter**, starting at the left edge for both signs. Its fill width is `100 * Math.min(1, Math.abs(progress) / currentStage.capacity)` percent. For a 100-point stage, -25 displays 25/100 with 25% black fill; +25 displays 25/100 with 25% field-color fill; 0 leaves the meter empty. Never create separate negative and positive halves, a center-origin bar, or a second opposing bar. Black indicates negative progress within the STORED state; it does not automatically mean the state is Hatred. Preserve an existing bespoke renderer's appearance while applying this same single-meter contract. Use a different presentation only when the user explicitly requests their own relationship system.

---

## Pattern 3 — Combat Loop (turn-based resource management)

**What it is:** Player takes action → damage is computed → HP updates → death or reward triggers.

**Use when:** The world has explicit combat (RPG, battle arena, survival).
**Skip when:** Combat is narrative-only (describe a fight without tracking numbers).

**Composition:**
1. Resource variables: `hp` (player), optionally `enemy-hp`, `stamina`, `mana`.
2. Precise behaviorRules on **damage ranges** and **death semantics**.
3. Death threshold behavior (`state:crossed drops-below 1`) → directive that changes the game mode to "defeated".
4. Optional: `enemy-id` variable for current enemy + enemy lore entries gated on it.
5. Optional: combat HUD (stat-bar component for hp, text-display for enemy name).

**Worked example:**

```
write_variable {
  id: "hp", name: "HP", type: "number",
  defaultValue: 100, min: 0, max: 100, category: "stat",
  behaviorRules: "Player health.
    100 = full, 50 = bloodied (narrate visible wounds), 20 = critical (hands shaking, vision blurs), 0 = defeated.
    Light hit: -5 to -15. Solid blow: -20 to -35. Critical strike: -40 to -60. Lethal: set to 0.
    Resting: +10 to +30. Healing potion: +50. Never below 0 or above 100."
}

write_variable {
  id: "enemy-hp", name: "Enemy HP", type: "number",
  defaultValue: 0, min: 0, max: 999, category: "stat",
  behaviorRules: "Current enemy's health. Default 0 = no enemy. Set to enemy's max on encounter.
    Decrease as player attacks. At 0, enemy is defeated — narrate conclusion, set enemy-id to empty."
}

write_behavior {
  id: "player-defeated",
  name: "Player reaches 0 HP",
  when: { eventType: "state:crossed",
          match: { variableId: { operator: "eq", value: "hp" },
                   direction: { operator: "eq", value: "drops-below" },
                   threshold: { operator: "eq", value: 1 } } },
  then: [{ type: "set", path: "@prompt.directive.defeated",
           value: { content: "Player is defeated. Describe them losing consciousness. The next scene begins after they recover (or at a game-over screen if the world has one).",
                    position: "top", persistent: false, duration: 3 } }],
  maxFireCount: 1
}
```

**Pitfalls:**
- **No `maxFireCount` on death trigger** → fires every turn after HP hits 0. Use `maxFireCount: 1`.
- **Damage ranges overlap with healing ranges** → numbers never change meaningfully. Keep damage > healing for tension.
- **No enemy-hp tracking** → combat is vague ("you fight it for a while"). Track the enemy for pacing.
- **Over-precise damage** (e.g., "subtract exactly 7 on a punch") → mechanical. Give the AI a range.

---

## Pattern 4 — Choice Branching (player picks A/B/C, story diverges)

**What it is:** Key decisions that set a flag or variable, which gates later content.

**Use when:** The user wants meaningful choices (route selection, moral dilemmas, faction alignment).
**Skip when:** The story is fully emergent and the AI should decide consequences freely.

**Composition:**
1. A variable (flag, string enum, or number) capturing the choice.
2. Entries (conditional, chat-history) with different content per outcome.
3. Optional: a directive that shifts overall tone/arc based on the choice.
4. Optional: an app-surface TSX component rendering choice buttons.

**Worked example — moral alignment:**

```
write_variable {
  id: "alignment", name: "Alignment", type: "string",
  defaultValue: "undecided",
  behaviorRules: "Player's moral path. Values: 'undecided' (default), 'light', 'dark', 'neutral'.
    Set when player makes a defining choice:
    - Sparing an enemy → light.
    - Executing a prisoner → dark.
    - Refusing both → neutral.
    Once set, cannot change (the world remembers). Narrate consistent consequences."
}

write_behavior {
  id: "alignment-decided",
  when: { eventType: "state:changed",
          match: { variableId: { operator: "eq", value: "alignment" } } },
  conditions: [{ variableId: "alignment", operator: "neq", value: "undecided" }],
  then: [{ type: "set", path: "@prompt.directive.alignment-tone",
           value: { content: "Player has chosen {{alignment}}. Let NPCs remember this and react accordingly — fear, admiration, or indifference.",
                    position: "after_char", persistent: true } }],
  maxFireCount: 1
}

# Entry that only surfaces on the light path
write_entry {
  id: "light-path-reward",
  content: "The village welcomes {{user}} back, calling them the light-bringer...",
  section: "chat-history",
  keywords: ["village", "return", "welcome"],
  conditions: [{ variableId: "alignment", operator: "eq", value: "light" }]
}
```

**Route variant — pick the branch at the START (openings + worldbooks):** when the branch is chosen up front (which heroine, which scenario, which difficulty), don't make the AI infer it mid-play. Give the card **multiple openings (greetings)**, each seeding a route flag via `initialVariables` (e.g. `{ "route": "mayu" }`) and/or bound to a **worldbook** (knowledge base) that holds only that route's lore. Picking an opening activates its worldbook and seeds its variables — the other routes' books stay off, so contradictory routes never bleed together and you stay within budget. See the **lore** skill ("Worldbooks — one card, many routes"). Use this instead of one big always-on book + conditions when routes are mutually exclusive and chosen at the opening.

**Pitfalls:**
- **Branch without consequence.** If the choice doesn't change any entry or directive, the player feels their choice didn't matter.
- **Reversible alignment.** If the AI can change it back, the branch loses weight. Lock with `maxFireCount: 1` on the setter or enforce in behaviorRules.
- **Too many branches.** 2-4 outcomes is tractable. 10+ becomes unmanageable.
- **Two always-on books that contradict.** Putting mutually-exclusive routes on `always`-mode worldbooks injects both at once (the AI sees "you are a girl" AND "you are a boy"). Gate each by its opening (greeting mode) or a route condition.

---

## Pattern 5 — Inventory (items, gear, consumables)

**What it is:** A collection the player accumulates, spends, or equips.

**Use when:** Items matter for gameplay (quest items, consumables, gear with stats).
**Skip when:** "Inventory" is narrative only — describe items without tracking them.

**Composition:**
1. A JSON variable, typically an array of item objects.
2. `behaviorRules` specifying the object schema and when items are added/removed.
3. Optional: capacity cap enforced in behaviorRules.
4. Optional: an app-surface TSX component (grid or list) reading the JSON.

**Worked example — simple inventory with capacity:**

```
write_variable {
  id: "inventory", name: "Inventory", type: "json",
  defaultValue: [],
  behaviorRules: "Array of item objects. Schema: { id, name, qty, type }.
    type is one of: 'quest', 'weapon', 'consumable', 'misc'.
    Add with push operation: [inventory: push { id: 'sword-01', name: 'Rusted sword', qty: 1, type: 'weapon' }].
    Remove with delete by id: [inventory: delete id='sword-01'].
    Max 10 items total — if full, force the player to drop one before adding.
    Stack consumables by id: if adding 'potion' and it already exists, increment qty instead of duplicating."
}
```

**Alternative — two separate variables for clarity:**
If items have meaningful categories (quest items never get dropped; consumables do), split:
```
write_variable { id: "quest-items", type: "json", defaultValue: [], behaviorRules: "..." }
write_variable { id: "consumables", type: "json", defaultValue: [], behaviorRules: "..." }
```

**Pitfalls:**
- **No schema in behaviorRules** → AI adds inconsistent object shapes, component can't render reliably.
- **No capacity rule** → inventory bloats, clutters prompt.
- **Tracking items the narrative ignores** → pure overhead. Only track items the player can use or lose.

---

## Pattern 6 — Time / Day Cycle (turn count → time-of-day → scheduled events)

**What it is:** World time that advances with turns, gating events to specific times.

**Use when:** The world has time-sensitive content (shops that close at night, characters with schedules, NPC sleep cycles).
**Skip when:** Time is narrative flavor only — say "three days later" without tracking.

**Composition:**
1. A string-enum variable for the current time period.
2. A counter or decay variable + `turn:complete` behavior to advance it.
3. Conditional entries or behaviors gated on the time value.

**Gold-standard worked example — adapted from a shipped world's day/night cycle:**

```
# Time period as a string enum — AI narrates consistently within each period.
write_variable {
  id: "time-period",
  name: "Time of day",
  type: "string",
  defaultValue: "Morning",
  category: "custom",
  behaviorRules: "One of: Morning, Afternoon, Night.
    Advance one period after every 2–4 player actions or one major event.
    Morning → Afternoon → Night → (new day) Morning.
    Use to justify scene tone: shops closed at night, NPCs asleep, different ambience.
    Do not change mid-scene for narrative convenience — the cycle is authoritative."
}

# Day count auto-increments when the cycle rolls over to Morning.
write_variable {
  id: "day-count",
  name: "Day",
  type: "number",
  defaultValue: 0, min: 0, max: 99,
  category: "stat",
  behaviorRules: "0 before the game starts. Begins at 1 once the game begins.
    Increment by 1 at the end of each Night period."
}

# Auto-decay mechanic: a resource drops each turn via turn:complete.
# This pattern is fully safe — turn:complete fires once per exchange; hunger is external to the trigger.
write_variable {
  id: "hunger",
  name: "Hunger",
  type: "number",
  defaultValue: 100, min: 0, max: 100,
  category: "stat",
  behaviorRules: "100 = full, 50 = tired/weaker narration, 0 = starving (movement penalties, confusion).
    Decreases 5 per turn via auto-decay behavior. Restored by eating (+20 to +40). Never below 0 or above 100."
}

write_behavior {
  id: "auto-hunger-decay",
  name: "Per-turn hunger decay",
  when: { eventType: "turn:complete" },
  conditions: [],
  then: [{ type: "set", path: "hunger", value: 5, operation: "subtract" }],
  priority: 50
}

# Time-gated content — entry only surfaces at night.
write_entry {
  id: "shops-closed-at-night",
  content: "The shops are shuttered. Metal grates cover the doorways.",
  section: "chat-history",
  keywords: ["shop", "store", "market", "buy"],
  conditions: [{ variableId: "time-period", operator: "eq", value: "Night" }]
}
```

**Pitfalls:**
- **Self-loop trap:** a `state:changed` behavior whose effect writes back to the same variable will re-fire forever — add `cooldownTurns` or target a different variable (this is what `validate_world` flags as `behavior-self-loop-risk`).
- **Mechanical advancement feels artificial** → consider advancing time only on travel/rest actions or major narrative beats, not raw turn count.
- **No entries or behaviors depend on time** → the variable is decorative.

---

## Pattern 7 — Cast / Roster Selection (player picks which characters are present)

**What it is:** The player chooses a subset of a large cast (idol group, harem, party, class roster) at the start, and ONLY the chosen characters appear in the story. Everyone else stays off-stage.

**Use when:** The world ships many characters (a K-pop group, a class of students, a full party) and the player wants to focus on 1–N of them. "选两个成员，只有这两个出现" is exactly this pattern.
**Skip when:** All characters are always present (an ensemble where the whole cast matters every scene).

**The trap that breaks this every time:** building the selection UI + a variable that stores the picks, but forgetting the **gate entry**. Per-character profile entries are `system-presets` / always-send, so the engine injects ALL of them every turn regardless of the variable. Writing `selected-members` does nothing on its own — nothing reads it. The model sees all 13 full profiles and no instruction restricting the cast, so every character keeps showing up. **The variable + UI are necessary but NOT sufficient. The gate entry is the part that actually does the work.**

**Composition (all FOUR are mandatory):**
1. A `json` variable (e.g. `selected-members`) holding the array of chosen character names. Its `behaviorRules` must say: set by the frontend UI, do not modify during RP, lists the legal names. **It MUST carry `scope: "setup"`** (see the next point — the single most-missed field).
2. **`scope: "setup"` on that variable is NON-NEGOTIABLE for this pattern.** These cards almost always flow `pre-game cast screen → pick an opening (greeting)`. Picking an opening calls `switchGreeting`, and the engine RESETS session state to that opening's snapshot (built from world defaults), which silently wipes the player's cast pick back to the default `[]`/`""`. The engine carries a variable across that reset ONLY when it is `scope: "setup"` (see `preserveSetupScopedVariables` in `state/setup-scope.ts`). Without it, the gate entry below reads an empty roster every turn and the model falls back to "everyone is here." Do NOT try to fix this in the frontend with snapshot-and-rewrite hacks — they race against the engine's own async reset and are unreliable. The one-field data change is the correct fix.
3. The frontend selection UI calls `api.setVariable("selected-members", [...])` with the chosen names. Gate the picker on whether the variable is already set so it doesn't re-ask on re-entry (see front-ui skill).
4. **A gate entry** — `alwaysSend`, `section: "system-presets"`, low `position` so it sorts before the profiles — that names the selection variable and lays down the hard rule.

**Worked example — the scoped variable + the gate entry (both required):**

```
write_variable {
  id: "selected-members",
  name: "登场成员",
  type: "json",
  defaultValue: "[]",
  scope: "setup",                     // ← survives the opening switch; without this it resets to []
  behaviorRules: "由前端选人 UI 写入，列出本场登场成员的艺名。RP 过程中不得修改。空数组 [] = 全员登场。"
}

write_entry {
  id: "active-members-instruction",
  name: "登场成员限制",
  section: "system-presets",
  position: -1,                       // sorts before the per-character profiles
  content:
"【本场登场成员 · 铁律】\n" +
"本次会话的登场成员，以 <game-state> 区块中 `selected-members` 字段列出的名单为准。\n\n" +
"**只有 `selected-members` 名单里的成员，才能出现在这次故事中。没有被列入名单的成员，一律不得登场、不得被描写为在场、不参与任何对话或行动，也不得中途突然加入。所有旁白、对话和行动都只围绕名单内的成员展开。**\n\n" +
"若 `selected-members` 为空数组（[]），则视为全员登场。"
}
```

**Pitfalls:**
- **Forgetting `scope: "setup"` on the selection variable** (the silent #1 failure for any card that has the player pick an opening after the cast screen). Everything looks built — UI, variable, gate entry — but the cast pick is wiped the instant the player taps an opening, so the gate entry sees `[]` and the model plays everyone. Symptom the creator reports: "I selected 2 members but the narrator says `selected-members` is empty." If you ever hear that, check `scope` FIRST, before touching the frontend. Frontend timing patches (snapshot before `switchGreeting`, re-apply after, Promise chains, fallback writes on a later component mount) do NOT reliably fix it — they race the engine's async state reset.
- **Forgetting the gate entry** (the other top failure — see above). The UI works, the variable saves, and the player still sees everyone.
- **Trying to interpolate the picks inline with `{{selected-members}}`.** It stays LITERAL. The `{{...}}` macro only resolves bare word-identifiers (`{{class}}`) — a hyphenated id (`selected-members`) never interpolates, and the `{{var:...}}` / `{{getvar::...}}` forms do not exist. The reliable surface for any variable's live value is the `<game-state>` block, which is injected every turn (`selected-members: ["S.Coups","Mingyu"]`). So the gate entry must **reference the variable by id and point at `<game-state>`**, not embed `{{...}}`.
- **Gating per-character profiles with `conditions` instead of the prose rule.** `alwaysSend` entries bypass `conditions`, so a condition on an always-send profile is ignored. Either keep profiles always-send + rely on the gate entry (simplest, this is how shipped roster cards work), or make profiles non-always-send and toggle them via behaviors — do not mix.
- **Editing an already-built card and only doing the visible half.** When a card already exists with all-character always-send profiles and the user asks to "add member selection," you MUST add the gate entry too — do not report the feature complete after only building the UI and variable.

---

## Composing Patterns

Real worlds combine patterns:

- **A dungeon crawler** = Stat System (hp/mana) + Combat Loop + Inventory + optional Relationship System (for a party NPC).
- **A dating sim** = Relationship Management (current state + signed stage progress per love interest) + Choice Branching (date path selection) + Time/Day Cycle (scheduling dates).
- **A horror survival** = Stat System (sanity) + Inventory (rare consumables) + Choice Branching (morality) + Time/Day Cycle (night = danger spike).
- **An idol-group / large-cast simulator** = Cast/Roster Selection (player picks who's present) + Relationship Management (current state + signed stage progress per chosen member) + optional Choice Branching (story routes).

When composing: create variables first, then behaviors, then gated entries last. That order lets you reference IDs that already exist.

## Pre-Flight Checklist (before writing a system)

Before calling write tools, answer:
1. **What experience does this create?** "Tension from willpower breaking" is a design goal; "a willpower variable" is not.
2. **Which pattern(s) apply?** Name them. If none apply, ask whether the user wants something truly novel or a mis-scoped request.
3. **What's the minimum entity set?** List each with its role ("variable X tracks Y, behavior Z triggers at threshold W").
4. **What are the threshold narrative beats?** Each threshold should change what the AI does. If not — drop the threshold.
5. **Does any part of this already exist?** Read the inventory. Extend, don't duplicate.

Skip the checklist only for trivial requests ("add a greeting", "rename this entry"). For any system spanning 3+ entities, run it.
