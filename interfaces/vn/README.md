# VN presentation

The fullscreen root for the local card, matching `jelavu/vn.svg`, `jelavu/log_vn.svg`, and `jelavu/menu_vn.png`. All story operations use Yumina's sandbox SDK. Choices wait until the current passages have been read; Skip and Auto advance already generated passages. Save and Load use real checkpoints. Thinking is an optional, collapsed log disclosure and is never used as player input.

The menu heading displays the current VN title from `useYumina().worldName`, replacing the reference image's sample brand text. Browser fullscreen and Fullscreen view / Windowed view live in this menu; the VN has no floating host fullscreen buttons above its toolbar. Browser fullscreen appears only when the browser supports it.

Persona appears only while the server permits selection and the session contains its original, uncontinued greeting. It has its own row below Memory/Settings, alongside Export. Export is currently an inert placeholder. Once the player submits input or continues the greeting, Persona disappears and Export becomes a standalone button centered in that row.

Choice actions render in italics and quoted dialogue renders normally. Missing closing action markers are hidden too; the selected choice is submitted exactly as stored. Recognizable older shipped choice/menu helpers receive the same corrections in memory without replacing authored status layouts or asset settings.

Save and Load share one row in the menu on desktop and phones. Memory and Settings share the next row, with Memory on the left. Menu → Save opens a checkpoint naming modal. Its selected default is `Checkpoint #n`, where `n` is the lowest unused positive number in the refreshed saved list. Custom names are trimmed; Cancel and Escape return to the menu without saving. Save and Enter use explicit sandbox event handlers, keep the draft after errors, and prevent duplicate submissions. Untouched defaults are recomputed by the server when saving. Desktop, phone, landscape, and live-backend checks are recorded in [`qa/checkpoint-naming/verification.md`](./qa/checkpoint-naming/verification.md).

Menu → Memory opens the platform memory inspector directly to Story memory, independently of the legacy summary extension. Close returns to the menu and its Memory button. Reading shortcuts are paused while the inspector is open; opening it does not send or generate a story turn.

VN dialogs share the Memory panel's brown surface, gold borders, typography and controls through `dialog-theme.ts`. The active VN chat applies the same theme to host portals and isolated sandbox overlays, including Persona selection/editing, model selection and story sessions. Leaving the VN chat clears the host theme. `scripts/update-vn-dialogs.mts` refreshes only this theme and its entry-point connection in owned cards and their saved VN drafts; it preserves other files and card locks, writes rollback snapshots, and verifies the saved schema.

The last choice is always one `...` button. It opens a textarea modal for a custom action/response. Send submits only that text; Cancel, Close, backdrop or Escape dismisses it without sending anything, so the player can select another option. The composer is available at the end of a completed passage even if an older reply has no model-provided options.

Menu → Settings includes a three-position **Persona control** slider. **Player controlled** is the default for new and existing sessions. **Assisted** opens selected choices for review and offers **Draft with AI**, using the saved persona and the player's intent; only **Send choice** submits the reviewed text. **AI controlled** explicitly permits the persona to speak and act repeatedly throughout a turn, guided by personality and the player's latest direction. Explicit input takes priority and consequential new decisions still require the player. The mode is stored on the story session outside game state, so checkpoints and rewinds do not change it; new independent stories start at Player controlled. Returning to Player controlled restores the normal generation prompt and output filter for future turns.

Selecting a choice shows its exact text and the persona sprite on stage during generation. Both remain after the response finishes until the player clicks or advances with the keyboard; that action reveals the response from its first passage. Later choices stay hidden until the response has been read. The VN displays completed replies only; streamed text, Thinking and state changes are withheld. The loading indicator shows an increasing estimated token count, including thinking output, through a separate numeric SSE channel. A tilde marks the estimate; it starts at zero for each attempt. Saved interfaces with the standard loader gain this display when opened, preserving their authored files. A provider error stops the loader and remains visible over the log/menu. Retry reuses a failed player turn through `continueLastMessage`, so it never sends the selected choice twice.

Every spoken passage must begin with `[SPEAKER:Miveth:happy]` or the equivalent `[Name:Miveth:happy]`. Both preserve the expression. Use `[SPEAKER:Narrator:normal]` for narration; starred actions (including `**action**`) are always italic narrator passages. Quoted speech is separated from surrounding narration, and star emphasis inside spoken quotes is cleaned. Narrator actions use exact character names and named possessives, while player references use the literal `{{user}}` token with second-person verbs. Every ongoing playable turn must include one `[CHOICES: ["Option one", "Option two"]]` block with 2–4 distinct, concrete player options after its story passages. Ending mid-scene pauses for that decision; it does not excuse missing choices. Choices are parsed, stored on each swipe and restored on reload. The interface adds its own `...` custom-response option, so the model must not generate that option. Omit choices only for an explicitly ended story. These are prompt requirements; an unconstrained model can still omit them. A second-call recovery path is not currently implemented.

For example, an ongoing turn can end with:

```text
[SPEAKER:Narrator:normal] *Miveth sets the cup down.*
[SPEAKER:Miveth:normal] "What would you like to know?"
[CHOICES: ["Ask Miveth about the wine", "Ask Evelia to explain the vial", "Step back from the table"]]
```

Older prose without markers uses conservative speaker recovery. Undefined quotations display NPC without borrowing a registered character's name or portrait. Stored replies without generated options retain the custom `...` button; updating defaults does not add choices to historical replies.

To load VN sprites, use **Visual Novel → Sprites → Characters** to upload each expression. The editor writes its `@asset:…` reference into **Custom UI → sprites.ts**. You can also edit that map directly with actual uploaded asset IDs:

```ts
export const sprites = {
  Miveth: { normal: "@asset:YOUR_NORMAL_ID", happy: "@asset:YOUR_HAPPY_ID" },
  Evelia: { normal: "@asset:YOUR_NORMAL_ID", shy: "@asset:YOUR_SHY_ID" },
};
```

Save the card, then play. Names match character display names without author labels such as `NPC:`. The marker expression selects the sprite; missing expressions fall back to `normal`. Portraits remain separate from VN sprites. No art is invented or assigned automatically. A JSON `vn-sprites` variable can provide the same map. The official `segments` array's `speaker` and `emotion` fields also select sprites. Optional scene backgrounds are configured in `scenes.ts`, keyed by `[SCENE:id]`/`current-scene` and `current-period`, or supplied through the existing `scene-bg`/`current_bg` variable.

### NPC sprite pools

**Visual Novel → Sprites → Male NPCs / Female NPCs** offers two built-in defaults. **Default A** uses two newly generated faceless gray figures, one male and one female, with slightly darker gray pixels and transparency baked into the PNGs (60% maximum opacity). **Default B** randomly selects from the existing **15 male and 15 female thigh-up sprites**. New VN presets start with A. **Disable defaults** turns off both built-in fallbacks without removing their assets or your uploads; the previous A/B choice is retained. These settings apply to both genders and persist when the card is saved.

Custom uploaded cutouts take priority for their gender. They live in `npcSprites`, separately from `npcDefaultSpritesA`, `npcDefaultSpritesB`, and the `npcDefaults` settings. Uploads remain usable when defaults are disabled. Ordinary character/expression assignments stay separate. Existing saved interfaces retain their authored source; updating a known VN loader must preserve its character art and custom pools:

```ts
export const npcSprites = {
  male: { clerk: "@asset:UPLOADED_CUTOUT", guard: "@asset:ANOTHER_CUTOUT" },
  female: { merchant: "@asset:UPLOADED_CUTOUT" },
};
```

The model identifies an incidental speaker with `[SPEAKER:NPC:normal:male:academy-clerk]` or `[SPEAKER:NPC:happy:female:merchant]`. The last field is a stable hidden identity reused across turns. The visible name remains **NPC**. A structured segment uses `{ speaker: "NPC", emotion: "normal", gender: "male", npcId: "academy-clerk", text: "Name?" }` instead. A `vn-npc-sprites` JSON variable can override the pools.

The session and NPC identity seed a repeatable random choice from the matching custom pool or Default B. Rerenders, expression changes, reloads, pool reordering, scene changes and backward navigation keep the same selected image. Turning defaults off and back on restores the same B assignment. A uses the matching gender's single gray figure. Different NPCs have separate cast slots; the existing 1/4 responsive caps still apply. Registered character art takes precedence. Unknown gender, disabled defaults with no matching custom art, or a legacy response without metadata shows NPC without a fallback sprite. The model must not guess gender from a name. An explicit `vn-npc-sprites` override remains authoritative, including an empty override. Bundled NPC sprites are independent character cutouts; another character's portrait is never used as a fallback. Older custom loaders remain preserved; the editor identifies unsupported loaders rather than saving a pool they cannot display.

The selected player persona can store `normal`, `happy`, `sad`, `angry`, `shy`, and `smug` cutouts. Those sprites follow the saved session persona snapshot, including creator presets. If none are uploaded, the player receives a deterministic sprite from the combined NPC pool or bundled defaults; this fallback does not infer a gender from the player's name and remains available when incidental-NPC defaults are disabled. A persona's portrait remains separate and is used in the dialogue log.

The stage shows at most **1 sprite on mobile portrait**, **4 on mobile landscape**, and **4 on desktop**, including desktop portrait. Rotation updates the limit without reloading or generating a reply. Only speakers encountered through the current reading position are eligible. Their latest read expressions remain visible during narrator actions; an explicit `[SCENE:id]` change clears the preceding cast. When there are more configured characters than slots, the most recent speakers are selected, including the current speaker, and retained characters keep their encounter order. Sprites occupy separate slots extending to the scene bottom behind the dialogue and choices. Their faces remain within each slot; a measured shade preserves text readability without shrinking the art above the reader. The log's portrait images are never used as an automatic sprite fallback.

New sprites fade in once their image loads. When the cast limit is full, the character who spoke least recently fades out as the new speaker fades in. Departing sprites keep their previous position until the fade completes, without occupying another live slot. Expression changes retain the existing sprite without replaying its entrance. Reduced-motion preferences disable these fades.

### Sprite schema

Every character uses the same six expression types: `normal`, `happy`, `sad`, `angry`, `shy`, and `smug`. The shared `expressions.ts` mapping normalizes marker labels, structured segments and emotion variables before selecting art. Common aliases include `irritated`/`annoyed` → `angry`, `amused` → `happy`, `haughty`/`condescending` → `smug`, and `embarrassed` → `shy`. Case and spacing are normalized; unknown labels and surprise use `normal`, because this set has no surprise sprite. Missing art still falls back to that character's `normal`. Saved dialogue remains unchanged.

[`sprites.schema.json`](./sprites.schema.json) defines the version 1 sprite-set contract; [`sprites.example.json`](./sprites.example.json) is a valid example with placeholder asset IDs. Each stable character ID has `kind: "sprite"`, a `speakerName` matching its dialogue markers, and an `expressions` map with a required `normal` fallback. Each expression declares an uploaded `assetRef`, its PNG/WebP/SVG MIME type, `transparentBackground: true`, and authored `half-body` (waist-up), `bust` (chest-up), or explicitly selected `full-body` framing. Waist-up is the suggested default for dialogue scenes and is used in the example; full-body is not required. The optional normalized `anchor` defaults to bottom center (`x: 0.5`, `y: 1`). `idle` can be an expression name; it does not imply animation.

A sprite is an authored character cutout for the stage. A rectangular portrait or CG stays in its own asset role; marking it as a sprite does not turn it into a cutout. The schema rejects portrait/CG roles and JPEG declarations, but actual file type and background transparency must be checked against the asset bytes. Replace the example's placeholder references with uploaded cutouts. The inventory can contain any number of characters; the responsive stage limits determine how many appear at once.

This defines the data contract only. The current loader still uses the simple character/expression map shown above; it does not yet consume the versioned manifest or apply its anchor metadata.

`speaker.ts`, `speaker-tag.ts`, and `dialogue-spans.ts` adapt the existing tested chat parser into relative imports supported by the card bundler. Narrated actions remain narration. Spoken emphasis is cleaned by that parser. Main control paths and the choice symbol are extracted from the supplied SVG, while the menu uses the original supplied PNG icons through CSS crops. The included DejaVu Sans font is the family explicitly specified in both SVG references and is bundled to keep phone rendering consistent; see its license in `assets/`.

Apply to an owned local world with the preview running:

```sh
pnpm --filter @yumina/app exec tsx --tsconfig tsconfig.app.json ../../scripts/apply-vn.mts WORLD_UUID
```

The script refreshes the VN runtime while retaining saved character/expression maps, NPC pools and defaults, global and opening backgrounds, stat bindings, authored status layout, character showcase settings, portrait settings and extra files. It refuses custom executable asset maps instead of replacing them with empty defaults. A locked card must be unlocked deliberately before applying.

Every schema field outside `rootComponent` stays intact. The script writes a private rollback snapshot, checks optimistic concurrency, and stamps the compiled source hash. Font and menu references are filled in the card's files without changing the stock template on disk; existing menu uploads are reused, including optimized WebP copies. Browser QA uses temporary sessions and intercepted synthetic generation, with no paid provider requests.
