# VN presentation

The fullscreen root for the local card, matching `jelavu/vn.svg`, `jelavu/log_vn.svg`, and `jelavu/menu_vn.png`. All story operations use Yumina's sandbox SDK. Choices wait until the current passages have been read. Skip jumps from any historical turn to the final page and choices of the latest accepted reply; Auto advances already generated pages. During generation, Skip keeps the pending player dialogue visible until a completed reply is ready. Skip never submits a choice or generates a reply. Save and Load use real checkpoints. Thinking is an optional, collapsed log disclosure and is never used as player input.

The menu heading displays the current VN title from `useYumina().worldName`, replacing the reference image's sample brand text. Browser fullscreen and Fullscreen view / Windowed view live in this menu; the VN has no floating host fullscreen buttons above its toolbar. Browser fullscreen appears only when the browser supports it.

Persona appears only while the server permits selection and the session contains its original, uncontinued greeting. It has its own row below Memory/Settings, alongside Export. Export is currently an inert placeholder. Once the player submits input or continues the greeting, Persona disappears and Export becomes a standalone button centered in that row.

Choice actions render in italics and quoted dialogue renders normally. Missing closing action markers are hidden too; the selected choice is submitted exactly as stored. Recognizable older shipped choice/menu helpers receive the same corrections in memory without replacing authored status layouts or asset settings.

Save and Load share one row in the menu on desktop and phones. Memory and Settings share the next row, with Memory on the left. Menu → Save opens a checkpoint naming modal. Its selected default is `Checkpoint #n`, where `n` is the lowest unused positive number in the refreshed saved list. Custom names are trimmed; Cancel and Escape return to the menu without saving. Save and Enter use explicit sandbox event handlers, keep the draft after errors, and prevent duplicate submissions. Untouched defaults are recomputed by the server when saving. Desktop, phone, landscape, and live-backend checks are recorded in [`qa/checkpoint-naming/verification.md`](./qa/checkpoint-naming/verification.md).

Menu → Memory opens the platform memory inspector directly to Story memory, independently of the legacy summary extension. Close returns to the menu and its Memory button. Reading shortcuts are paused while the inspector is open; opening it does not send or generate a story turn.

VN dialogs share the Memory panel's brown surface, gold borders, typography and controls through `dialog-theme.ts`. The active VN chat applies the same theme to host portals and isolated sandbox overlays, including Persona selection/editing, model selection and story sessions. Leaving the VN chat clears the host theme. `scripts/update-vn-dialogs.mts` refreshes only this theme and its entry-point connection in owned cards and their saved VN drafts; it preserves other files and card locks, writes rollback snapshots, and verifies the saved schema.

The last choice is always one `...` button. It opens a textarea modal for a custom action/response. Send submits only that text; Cancel, Close, backdrop or Escape dismisses it without sending anything, so the player can select another option. The composer is available at the end of a completed passage even if an older reply has no model-provided options.

Menu → Settings includes a three-position **Persona control** slider. **Player controlled** is the default for new and existing sessions. **Assisted** opens selected choices for review and offers **Draft with AI**, using the saved persona and the player's intent; only **Send choice** submits the reviewed text. **AI controlled** explicitly permits the persona to speak and act repeatedly throughout a turn, guided by personality and the player's latest direction. Explicit input takes priority and consequential new decisions still require the player. The mode is stored on the story session outside game state, so checkpoints and rewinds do not change it; new independent stories start at Player controlled. Returning to Player controlled restores the normal generation prompt and output filter for future turns.

Selecting a choice shows its exact text and the persona sprite on stage during generation. Both remain after the response finishes until the player clicks or advances with the keyboard; that action reveals the response from its first passage. Later choices stay hidden until the response has been read. The VN displays completed replies only; streamed text, Thinking and state changes are withheld. The loading indicator shows an increasing estimated token count, including thinking output, through a separate numeric SSE channel. A tilde marks the estimate; it starts at zero for each attempt. Saved interfaces with the standard loader gain this display when opened, preserving their authored files. A provider error stops the loader and remains visible over the log/menu. Retry reuses a failed player turn through `continueLastMessage`, so it never sends the selected choice twice.

Every spoken passage must begin with `[SPEAKER:Miveth:happy]` or the equivalent `[Name:Miveth:happy]`. Both preserve the expression. Append a configured wardrobe ID as `[SPEAKER:Miveth:happy:casual]` (or `[Name:Miveth:happy:casual]`); omitted type means `normal`. Custom wardrobes in examples must first be created on that card. The NPC fourth field remains gender, as described below. Use `[SPEAKER:Narrator:normal]` for narration; starred actions (including `**action**`) are always italic narrator passages. Quoted speech is separated from surrounding narration, and star emphasis inside spoken quotes is cleaned. Narrator actions use exact character names and named possessives, while player references use the literal `{{user}}` token with second-person verbs. Every ongoing playable turn must include one `[CHOICES: ["Option one", "Option two"]]` block with 2–4 distinct, concrete player options after its story passages. Ending mid-scene pauses for that decision; it does not excuse missing choices. Choices are parsed, stored on each swipe and restored on reload. The interface adds its own `...` custom-response option, so the model must not generate that option. Omit choices only for an explicitly ended story. These are prompt requirements; an unconstrained model can still omit them. A second-call recovery path is not currently implemented.

For example, an ongoing turn can end with:

```text
[SPEAKER:Narrator:normal] *Miveth sets the cup down.*
[SPEAKER:Miveth:normal] "What would you like to know?"
[CHOICES: ["Ask Miveth about the wine", "Ask Evelia to explain the vial", "Step back from the table"]]
```

Older prose without markers uses conservative speaker recovery. Undefined quotations display NPC without borrowing a registered character's name or portrait. Stored replies without generated options retain the custom `...` button; updating defaults does not add choices to historical replies.

To load VN sprites, use **Visual Novel → Sprites → Characters**, select a character, wardrobe type, and optional outfit variant. Upload a base image or add only the expressions that character has. Images and additional expressions are optional. **Manage types and emotions** edits this card’s vocabulary. Multi-file import provides an assignment review before upload; resolve unknown filenames, duplicate slots and replacements there. The selected character/type/variant stays fixed for the import, and successful uploads remain assigned if a later file fails. The editor writes its `@asset:…` reference into **Custom UI → sprites.ts**. You can also edit that map directly with actual uploaded asset IDs:

```ts
export const sprites = {
  Miveth: { normal: "@asset:YOUR_NORMAL_ID", happy: "@asset:YOUR_HAPPY_ID" },
  Evelia: { normal: "@asset:YOUR_NORMAL_ID", shy: "@asset:YOUR_SHY_ID" },
};
// Card-specific catalog. New cards seed these six wardrobes and six emotions.
export const spriteConfig = {
  types: { normal: "Normal", uniform: "Uniform", casual: "Casual", "controlled-battle": "Controlled_Battle", "battle-holder": "Battle_Holder", "battle-cascade": "Battle_Cascade" },
  emotions: { angry: "Angry", sad: "Sad", shy: "Shy", normal: "Normal", smug: "Smug", happy: "Happy", embarrassed: "Embarrassed" },
};
// Additional wardrobe sets; sprites above remains the Normal wardrobe.
export const spriteTypes = {
  casual: { Miveth: { happy: "@asset:YOUR_CASUAL_HAPPY_ID", embarrassed: "@asset:YOUR_CASUAL_EMBARRASSED_ID" } },
};
// Clothing descriptions remain separate from character identity and assigned images.
export const spriteWardrobeDescriptions = {
  Miveth: { casual: "A cream cardigan over a pale blue dress." },
};
```

Save the card, then play. Names match character display names without author labels such as `NPC:`. The marker selects type and emotion. Art falls back to the requested expression, normal, then the first assigned image in the exact selected type and variant. An outfit without art shows no substituted costume. Omitted outfit fields retain the current selection; an explicit type without variant selects its base. Unknown explicit outfit IDs preserve the last valid selection. Portraits remain separate from VN sprites. No art is invented or assigned automatically. A JSON `vn-sprites` variable can provide the same map. The official `segments` array uses `speaker`, `emotion`, and optional `spriteType` and `spriteVariant`, e.g. `{ speaker: "Miveth", emotion: "embarrassed", spriteType: "casual", text: "Hello." }`. Optional scene backgrounds are configured in `scenes.ts`, keyed by `[SCENE:id]`/`current-scene` and `current-period`, or supplied through the existing `scene-bg`/`current_bg` variable.

### Optional outfit variants and chapter defaults

**Manage types and emotions** adds, renames and removes variants inside a type. **Base outfit** is distinct from any named variant. `[SPEAKER:Miveth:happy:uniform:pt]` selects uniform/pt; `[SPEAKER:Miveth:happy]` retains that selection. Variant art lives in `spriteVariantSprites[type][variant][character]`, labels in `spriteVariants[type][variant]`, and clothing in `spriteVariantWardrobeDescriptions[character][type][variant]`. A variant never borrows base clothing or images.

**Chapters → Starting outfits** sets an outfit per character for the chapter’s linked openings. Presets are stored in `spriteChapterDefaults[openingId][character] = { type, variant? }`; a later valid story marker overrides that starting selection. Put `{{sprite_wardrobe}}` in character lore where current clothing belongs, preserving permanent body and identity details. The story context expands it using the accepted outfit selection. Studio provides `set_wardrobe_description`, `set_chapter_outfit` and `clear_chapter_outfit` for these edits.

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

New cards start with types `normal` (Normal), `uniform` (Uniform), `casual` (Casual), `controlled-battle` (Controlled_Battle), `battle-holder` (Battle_Holder), and `battle-cascade` (Battle_Cascade), and the six emotions `normal`, `happy`, `sad`, `angry`, `shy`, and `smug`. Authors can add any number of card-specific wardrobe types and optional variants. The emotion vocabulary warns at 20 and caps at 30; individual outfits need only the expressions actually assigned to them. Labels are editable; normalized stable IDs appear in story tags and remain unchanged when labels are renamed. Built-ins cannot be removed or renamed. Removing a custom option removes its assignments while leaving images in the asset library. Existing cards retain their authored options, and wardrobe/emotion assignments infer missing labels in both the editor and character viewer. Legacy emotion catalogs above 30 remain readable; adding another expression requires bringing that vocabulary within the limit. Type counts are uncapped.

Exact configured emotion IDs take priority over legacy aliases: custom `embarrassed` selects its own image rather than `shy`. Otherwise legacy aliases such as `irritated`/`annoyed` → `angry`, `amused` → `happy`, `haughty` → `smug`, and `embarrassed` → `shy` remain supported. Unknown emotions use the exact outfit’s normal image, or its first assigned image if normal is absent. Saved dialogue remains unchanged.

Studio discovers the catalog with `list_vn_assets`: `spriteConfig` contains type/emotion IDs and labels, and each character row includes `spriteType` and `spriteVariant`. The independently paged `outfits` inventory reports exact available expressions, descriptions and chapter presets. Filter with `spriteType` and `spriteVariant`, or omit them to see every outfit. Assign with `edit_vn_assets({kind:"sprites", action:"assign", name:"Miveth", spriteType:"casual", variant:"happy", assetRef:"@asset:UPLOADED_ID"})`. Catalog actions `add_option`, `rename_option`, and `remove_option` use `optionKind:"types"|"emotions"`, `optionId` for rename/remove, and `label` for add/rename. Variant catalog actions are `add_variant`, `rename_variant`, and `remove_variant`. Add `spriteVariant` to an assignment or clothing-description operation for a nested variant. Generated sprite targets use `characterId`, `expression`, `spriteType`, and optional `spriteVariant`. Discover options before editing tags or assigning art; give the story model relevant characters and exact current-outfit expression inventories, keeping emotional prose unrestricted. NPC pools and `[SPEAKER:NPC:normal:male:stable-id]` retain their existing identity fields.

[`sprites.schema.json`](./sprites.schema.json) defines the version 1 sprite-set contract; [`sprites.example.json`](./sprites.example.json) is a valid example with placeholder asset IDs. Each stable character ID has `kind: "sprite"`, a `speakerName` matching its dialogue markers, and an `expressions` map whose normal fallback is optional. Optional `spriteConfig` declares the card vocabulary and optional `spriteTypes` contains additional wardrobe inventories; optional `spriteWardrobeDescriptions` maps character names and wardrobe IDs to clothing descriptions (up to 2,000 characters); `sprites` remains Normal. Each expression declares an uploaded `assetRef`, its PNG/WebP/SVG MIME type, `transparentBackground: true`, and authored `half-body` (waist-up), `bust` (chest-up), or explicitly selected `full-body` framing. Waist-up is the suggested default for dialogue scenes and is used in the example; full-body is not required. The optional normalized `anchor` defaults to bottom center (`x: 0.5`, `y: 1`). `idle` can be an expression name; it does not imply animation.

A sprite is an authored character cutout for the stage. A rectangular portrait or CG stays in its own asset role; marking it as a sprite does not turn it into a cutout. The schema rejects portrait/CG roles and JPEG declarations, but actual file type and background transparency must be checked against the asset bytes. Replace the example's placeholder references with uploaded cutouts. The inventory can contain any number of characters; the responsive stage limits determine how many appear at once.

This defines the data contract only. The current loader uses the literal `sprites`, `spriteConfig`, `spriteTypes`, and `spriteWardrobeDescriptions` exports shown above; it does not yet consume the versioned manifest or apply its anchor metadata.

`speaker.ts`, `speaker-tag.ts`, and `dialogue-spans.ts` adapt the existing tested chat parser into relative imports supported by the card bundler. Narrated actions remain narration. Spoken emphasis is cleaned by that parser. Main control paths and the choice symbol are extracted from the supplied SVG, while the menu uses the original supplied PNG icons through CSS crops. The included DejaVu Sans font is the family explicitly specified in both SVG references and is bundled to keep phone rendering consistent; see its license in `assets/`.

Apply to an owned local world with the preview running:

```sh
pnpm --filter @yumina/app exec tsx --tsconfig tsconfig.app.json ../../scripts/apply-vn.mts WORLD_UUID
```

The script refreshes the VN runtime while retaining saved character/expression maps, NPC pools and defaults, global and opening backgrounds, stat bindings, authored status layout, character showcase settings, portrait settings and extra files. It refuses custom executable asset maps instead of replacing them with empty defaults. A locked card must be unlocked deliberately before applying.

Every schema field outside `rootComponent` stays intact. The script writes a private rollback snapshot, checks optimistic concurrency, and stamps the compiled source hash. Font and menu references are filled in the card's files without changing the stock template on disk; existing menu uploads are reused, including optimized WebP copies. Browser QA uses temporary sessions and intercepted synthetic generation, with no paid provider requests.

Final visual comparisons and phone captures are in `qa/`. The project-root `design-qa.md` records fidelity, validation, and resolved issues.

Live browser regression (temporary sessions, intercepted provider calls):

```sh
node scripts/check-vn.cjs WORLD_UUID
```

Set `YUMINA_QA_PLAYWRIGHT` and `YUMINA_QA_CHROME` to override the local runtime paths.

Choose **VN — Visual Novel** or **Classic — Chat** in Custom UI → Interface. The picker also searches saved custom UIs. **Save custom UI files** stores the current entry point and every source file in your account library; the naming modal accepts long names and truncates them to 50 Unicode characters when saved. Interface changes preserve edited versions in the card so you can switch back. Saving a UI copies source files and retains their asset references; assets remain in the existing Asset Library.

### Reading navigation and player references

The scene counter shows the loaded assistant turn and page within that turn. The wheel browses existing pages in both directions, including earlier loaded turns. The downward caret appears only while another generated page is available. Clicking the final passage never starts generation; select an option or submit the custom response instead.

VN output uses literal `{{user}}` for player references with second-person verbs (`{{user}} look`, `{{user}} are`) and `{{user}}'s` for possessives. Rendering displays “you” and “your” without rewriting stored replies. The log identifies the selected persona as `Name (You)` and uses its portrait. Thinking is an optional collapsed toggle above each reply.

### Phone layout

The passage and counter stay anchored at the bottom. Main-scene speaker names, dialogue and narrator actions are centered on phones as on desktop. Portrait choices appear above the passage; long lists scroll without shrinking or overlapping their buttons. Mobile choices use compact text and padding; short choices, including `...`, fit their content. The toolbar stacks each icon above its label and has at least 44px touch targets. Landscape uses a wide passage across the bottom, with choices above it on the right, like desktop. With fullscreen controls in the menu, the toolbar starts near the top without reserving a second control row.

The phone dialogue log puts the portrait and name in a header, with dialogue underneath. Narration and Thinking use the full log width. The desktop composition remains based on the supplied SVGs.

Portrait phones show one character at a time, centered and anchored to the scene bottom so its cut edge stays behind the reader. The sprite height follows the phone width and stays below the toolbar; its proportions remain unchanged. The background fills the screen with a centered crop and an additional 18% zoom. Landscape and desktop retain their existing composition.

Legacy dialogue such as `"Thank you," *Evelia says softly.* "Please sit."` keeps both quotes attributed to Evelia, while the intervening action stays italic narration. An unrelated action, an unknown speaker, or a blank paragraph ends this inferred context; explicit speaker markers remain the reliable format for new replies.

Touch-browser layout checks at 320px, 360px, 390px, landscape, and desktop:

```sh
node scripts/check-vn-mobile.cjs WORLD_UUID
```

Screenshots and the browser verification record are in `qa/mobile/`.

The landscape width regression, its before/after captures, and the latest seven-size browser check are recorded in [`qa/landscape/verification.md`](./qa/landscape/verification.md).

Sprite-cap checks, including rotation, desktop portrait, scene changes, and backward navigation:

```sh
node scripts/check-vn-sprites.cjs WORLD_UUID
```

Screenshots and verification records are in `qa/sprites/`. The temporary fixture uses transparent waist-up schematic cutouts, checks decoded alpha pixels, and leaves the real card's asset configuration unchanged. These are layout test fixtures, not final character art.
