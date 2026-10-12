---
name: front-ui
description: Design the world's rootComponent — its visual layer. One React root, multi-file virtual filesystem, compositional building blocks. Use when the user wants HUD, dashboard, layout, theme, panel, widget, status sheet, visualizations, or any visual UI.
---

# Skill: Front UI Design

Every world's visual layer is a single **rootComponent** — a virtual filesystem of `.tsx` files rooted at an entry file (typically `index.tsx`). There's no message-vs-app distinction; you compose what you want inside the entry file using the platform's building blocks.

## Composition Patterns by Intent

| User wants... | Entry file pattern |
|---|---|
| Default chat with platform rendering | `<Chat />` |
| Custom message bubble styling | `<Chat renderBubble={Bubble} />` (put `Bubble` in a sibling file) |
| Chat + persistent widgets alongside | `<><Sidebar /><Chat /></>` or a flex/grid layout |
| Full takeover (no default chat) | Your own JSX — don't import `<Chat>`; render `api.messages` yourself |
| Custom messages + overlay widgets | `<><HUD /><Chat renderBubble={Bubble} /></>` |
| Interactive greeting / character creation | Custom bubble at `messageIndex === 0`; use `renderBubble` to branch |
| Tabbed dashboard / management sim | Custom app JSX (no `<Chat>`); read `api.variables` for state |

All UI is React-based TSX compiled at runtime. Components run inside a sandboxed iframe for security.

## Visual Novel sprites and backgrounds

Use `list_vn_assets` for assignment inventory and help, including stable greeting IDs and sortable row IDs. Use `list_assets` to browse owned images, then `edit_vn_assets` for assignments, removals, defaults, and reordering. These tools share the editor's data-only parser and preserve interface logic. They reject executable/custom maps; read the source before making a requested code-level change.

Sprites use character name plus expression (`normal`, `happy`, etc.) and are shared across openings. `npcGender` selects a male/female NPC pool; `configure_npc_defaults` changes its fallback mode or disabled flag. Backgrounds use scene ID plus period (`day`, `night`, etc.). Omit `openingId` for **Global**; pass a stable greeting entry ID for one opening. Each collection has its own default image. Lookup is opening scene → Global scene → opening default → Global default. Global assignments remain available whichever opening is selected. Never infer an opening from array position or require the first message's snapshot: recent assistant snapshots carry `activeGreetingId` after old snapshots are pruned.

For artwork, check `get_image_sources` before `search_danbooru_images` / `import_danbooru_image`. Danbooru searches and imports existing artwork; it does not generate new pictures. The creator enables and optionally authenticates Danbooru in **Settings → AI Configuration → Danbooru artwork search**. Never ask them to paste an API key into chat or embed credentials in world files. Import a selected post into the owned library, then assign its returned `@asset` ref with `edit_vn_assets`. Keep the post/source attribution. Imported images retain their original crop and background; do not promise transparent sprites or generated variations.

<image-generation>
For new artwork, check `get_image_sources` and propose `generate_image` alone using the configured default or the provider requested by the creator. Settings → AI Configuration → Image generation stores separate ComfyUI/OpenAI profiles. Each image requires creator confirmation. Use `imageKind:"sprite"` for character expressions: ComfyUI uses Danbooru-style tags plus a flat green background, which the server removes to transparent PNG; OpenAI uses a plain-English artwork description and requests transparent PNG directly without green or Danbooru tags. Use `imageKind:"background"` for complete opaque scenes. After delivery assign the owned ref using `edit_vn_assets`, preserving the selected opening or Global scope. Configured providers do not support the platform batch tool or platform price estimates.
</image-generation>

## Published card showcase

**Publish → Character showcase** is the custom public story/world card profile, with HTML/CSS introductions, images, sections and badges. It is shown on the card details page before play. It is independent of the playable interface and character entries.

Read `card-showcase` with `read_entities` before editing. Use `write_card_showcase({html?,css?})` to update public HTML and/or CSS, or `write_character_showcase_css({css})` for CSS alone. Supply only changed fields; omitted fields are preserved. Empty HTML uses the card title, cover and description. Empty CSS restores default styling. HTML is limited to 100,000 characters and CSS to 30,000.

Use `.card-showcase` or `:scope` for the root and responsive HTML/CSS. Use `@asset:ID` for owned images. The profile is isolated from the app and scripts are unavailable. Keep public-facing copy separate from private lore. Card showcase requests must never rewrite `character-viewer.tsx`, `character-showcase.ts`, playable UI files or character profiles. The editor preview and card profile use the same renderer and save the same data.

## Player status visualizations

Creators use visual controls; source code stays hidden. Keep bespoke layouts driven by `config.fields` and `config.groups` so dragging, category edits, labels, colors and display types still work. Explain visible changes in plain language; do not include code snippets in your replies. Keep category buttons compact in one horizontally scrollable row at narrow widths. Use the managed signed-pips widget for scales crossing zero: one meter of 10 pips, absolute magnitude fills the meter, negative fills black, positive fills the field color, and zero fills none. Do not split it into separate negative and positive halves.

The VN interface has **UI options → Visualizations** with a **drag-and-drop builder** and field, color and display controls. These controls use `status-config.ts`; the custom layout uses `status-layout.tsx`. The tab previews the saved layout in the same sandbox and sheet as play.

Category labels and membership are data too: set `groups:[{"id":"overview","label":"Overview"},{"id":"relationships","label":"Relationships"}]` in `status-config.ts`, and set each field's `group` to a category ID. IDs stay stable when labels are renamed. Missing groups on older cards use Overview, Character and Inventory. Preserve unrelated categories and fields. Do not edit helper TypeScript to rename tabs.

For built-in display requests, change only the data in `status-config.ts`. Yumina maintains `status-data.ts`, `status-gauge.tsx`, `status-widgets.tsx`, `status-view.tsx` and `status-sheet.tsx`; Studio blocks rewrites of the shipped renderer. An older source shown in conversation history may be stale. Read the CURRENT `status-config.ts` and declared variables first. Prefer `edit_custom_ui` with a unique exact snippet for small settings changes. For a new configuration, use `write_custom_ui` with `id:"status-config.ts"`. Keep the declaration exactly `export const statusConfig = <valid JSON object>;`: quote every object key, use double-quoted strings, and omit expressions, functions, imports, and trailing commas. This keeps the visual editor able to read your work. Preserve unrelated fields during a small change.

```ts
export const statusConfig = {
  "title": "Status", "subtitle": "Current state", "accent": "#c8b17e",
  "fields": [
    {
      "id": "health-bar", "label": "Health", "variableId": "player-hp", "path": "",
      "group": "overview", "format": "bar", "icon": "♥", "color": "#a46d5d",
      "min": 0, "max": 100, "maxVariableId": "", "maxPath": ""
    }
  ]
};
```

`player-hp` above is an example: bind to an actual variable ID from this card. Read its type, bounds, default and behavior rules. Create a missing game variable with `write_variable` only when the requested mechanic needs it; write the variable before its visualization. A status field displays state; it does not define or update that state. Never replace live values with sample constants or change defaults merely to improve the preview.

| Field | Meaning |
|---|---|
| `id` | Stable, unique display-field ID; distinct from a game-variable ID |
| `variableId`, `path` | Exact variable ID and optional dot-path inside its JSON value, e.g. `stats` + `health.current`; IDs are literal keys |
| `label`, `icon`, `color` | Label, short text/emoji icon (up to 8 characters), six-digit hex color |
| `groups` | Ordered category definitions `{id,label}`; labels may be renamed and categories added or removed |
| `group` | An ID in `groups`; assigns the field to the player's category tab |
| `format` | `value` (text/number/boolean), `bar` (resource/XP), `segments` (10 attribute segments), `badges` (effects), `inventory` (animated item slots), `gauge` (icon-centered arc), `resource` (layered bar), `chips` (expiring effects), `pips` (relationship icons), `xp-ring` (progress/level), or `scene` (weather/time badge) |
| `min`, `max` | Numeric range for bars, segments, gauges, layered bars, pips and XP rings; maximum must exceed minimum |
| `maxVariableId`, `maxPath` | Optional variable and JSON path for a live maximum; empty strings use fixed `max` |

| `gaugeShape` | `quarter` (¼), `half` (½, default), or `full`; `gauge` puts `icon` in the center |
| `pipShape`, `pipCount` | `heart`, `star`, or `diamond`; integer count 1–20, default 5 |
| `levelVariableId`, `levelPath` | Optional live numeric level for `xp-ring`; an actual increase triggers a brief glow |
| `sceneIcon` | `auto` (weather/day/night inferred from displayed text) or `field` (configured icon) |

**Custom widgets keep a supported `format`.** The format list above is closed: `normalizeStatusConfig(config)` converts an unrecognized format to `value` before the custom layout receives its fields. Never invent a format such as `rank-medallion` and then branch on it; the custom component will not mount even when syntax validation passes. For a bespoke rank medallion, keep the existing `badges` format and select the custom component in `status-layout.tsx` by the field's exact `variableId` (for example, `field.variableId === "player-rank"`). Read the card's actual variable ID first and bind the component to `variables[field.variableId]`. Use this same variable-ID approach for other bespoke widgets; do not modify the managed normalizer to add a private format. Check the normalized field and the connected rendering branch before reporting success.

Array order controls field order within each category. Effects can use an array of labels or named objects. Item grids can use `[ {"name":"Potion","quantity":2} ]` or `{"Potion":2}`. Chips accept `{ "name":"Shield", "icon":"◆", "remaining":1 }`; `expiresIn` or `turns` also mark a numeric duration of 1 or fewer as ending soon, with one gentle pulse. All displays animate briefly on relevant value changes and respect `prefers-reduced-motion`. Inventory item names identify stable slots; quantity changes lift the count. Scene icons crossfade, resource bars trail behind the main fill, and pips fill individually. Missing state renders a dash; don't invent fallback progress.

Older cards using the shipped `status-data.ts` and `status-view.tsx` automatically receive the current renderer in the editor, play mode and Studio agent, with their config, assets and state preserved. Authored status renderers are retained: inspect their imports before adding a new format, and integrate `StatusWidget` from `status-widgets.tsx` plus `gaugeStyles`/`widgetStyles` when necessary. Never overwrite an authored renderer merely to update a config.

For bespoke designs, use **`write_status_visualization({layoutCode})`** or **`edit_status_visualization({old_code,new_code})`**. These target **Visualizations**, preserving the sheet and menu. Read `status-layout.tsx`, `status-config.ts`, and actual variables first. The layout exports a default React component accepting `{config, variables, preview}`; `variables` is the confirmed game state supplied by the sheet. Keep fields data-driven so the creator can still change bindings and labels in the visual builder. React and Icons are globals. Import `StatusWidget` plus its styles to reuse widgets, or build scoped responsive JSX/CSS for a new design. A signed relationship scale, for example, can use `statusValue(variables, field.variableId, field.path)` and fill from zero separately in each direction. This design belongs in the custom layout, not a patch to `status-view.tsx`.

```tsx
import { StatusView } from "./status-view";
export default function StatusLayout({config, variables, preview}) {
  return <div className="my-status-layout"><StatusView config={config} variables={variables} preview={preview} /></div>;
}
```

**Navigation contract:** the menu's **Status** button replaces the ENTIRE **right-hand** menu sheet with the status sheet. Menu controls disappear and only one sheet is mounted. **Back** restores the menu and focuses Status; Escape does the same. Preserve right anchoring, scrollable content, and keyboard focus containment. Status reads `sceneApi.variables`, the latest confirmed state held while streaming, rather than partial streamed state. Style/data edits must preserve this wiring and the card's other UI and assets.

If these files are absent, inspect the entry's menu and mount the status view as part of the requested implementation. A new sibling/config file alone does not add a visible sheet. `validate_world` checks syntax/reachability, not player-visible behavior; report what you actually checked.

## Verify visible changes

Before fixing a missing widget, read the entry file and trace its imports and rendered JSX to the widget. Changing a sibling file does nothing unless the entry reaches and mounts it. Check the initial state too: a closed panel's opener must have its own active styles; placing those styles only inside the open panel leaves the opener unstyled.

`validate_world` checks source structure and syntax, not rendered visibility or interactions. Treat unreachable-file warnings as a wiring check, and do not describe a component as visible or working solely because validation reports zero errors. When a creator reports that a fix did not appear, recheck mounting and style placement before spending another turn changing size, position, or z-index.

## Chat Building Block

`<Chat />` renders the full built-in chat: message list, text input, streaming, message editing, swipes, checkpoints, auto-scroll, read-only mode. Customize with props:

- `<Chat renderBubble={function(msg) { return <div>{msg.contentHtml}</div>; }} />` — each message renders through your function. `msg` has: `contentHtml` (+ `content` alias), `rawContent`, `role`, `messageIndex`, `isStreaming`, `stateSnapshot`, `variables`, `renderMarkdown`
- `<Chat className="..." >` accepts `children` rendered above the message list (e.g. a header bar)
- For full control: use `<MessageList>` and `<MessageInput>` separately

This avoids rebuilding the entire chat UI from scratch. Use `<Chat />` alone when you just need widgets around the standard chat. Add `renderBubble` when you also need custom message styling.

## Full Takeover (no `<Chat>`)

To take over the viewport entirely — no platform chat at all — simply don't render `<Chat>` in the entry file. Handle all chat display yourself:

| Approach | What you get |
|---|---|
| `<Chat />` | Full chat experience out of the box — messages, input, streaming, editing, swipes, checkpoints. Add widgets around it. |
| `<Chat renderBubble={...} />` | Same, but with custom message styling per bubble. |
| Manual (no `<Chat />`) | You must handle everything yourself — see the table below. |

**Manual mode only** — what you must implement:

| Hidden element | What the component must do instead |
|---|---|
| MessageList | Read `api.messages` and render messages yourself |
| MessageInput | Provide your own `<input>` / `<textarea>`, call `api.sendMessage(text)` |
| Composer "Context" button (Session Memory & Story Summary) | Dropping the built-in composer removes it. If `api.memorySummaryEnabled`, re-add a button that opens `<SessionMemoryModal open onClose />` — see the tsx skill's **Pattern: Session Memory Button**. Do NOT rebuild it from `api.injectContext`. |
| Greeting display | The greeting is `api.messages[0]` (first assistant message) — render it. Multiple greetings are built-in: create multiple `role: "greeting"` entries and use `api.switchGreeting(index)` to navigate |
| Streaming text | Check `api.isStreaming`, render `api.streamingContent` |
| Session header | Optionally add your own title/controls |

## Platform Conventions (do NOT reimplement)

### State & persistence: pick the store by what the state IS

Most UI does NOT need persistence — it should just render every time. Choose a store by the **nature** of the state, not by a vague "should this survive":

| State is… | Use | Survives re-entry / reload? | In the LLM prompt? |
|---|---|---|---|
| **Player input or real progress** — entered name, chosen route/origin, starting stats, story flags the rules/branching depend on, day/sim counters | `api.setVariable(k,v)` / `api.variables[k]` | Yes — saved per-session, server-side | **YES** |
| **Transient / cosmetic UI** — open tab, scroll, hover, expand/collapse, whether a cutscene is currently playing | React `useState` | No (resets on remount) — and that's fine | No |
| **Non-critical cross-session UI cache** — remembered theme, last-open tab | `api.storage` (localStorage) | Per-browser, per-world; `set` can drop | No |

> ⚠️ **Every game variable is rendered into the `<game-state>` block sent to the model on every turn** (~10–20 tokens each, and it can echo into chat — only `ThinkingTagFilter` strips it). `setVariable` is NOT a quiet store. Keep the variable set small: variables are for state the **story / rules** care about, never for UI bookkeeping. Never mint per-animation / per-popup / per-tooltip "played" flags.

**The one real persistence bug to prevent: never re-collect what the player already gave you.** If the player typed a name or picked a route/origin, store it in a variable and gate that input screen on whether the variable is set — so re-entering the session never re-asks:

```js
// Onboarding / input — gate on a PERSISTED variable (reliable, survives re-entry)
if (!api.variables["player_name"] && Object.keys(api.variables).length) return <Setup onDone={save} />;
function save(name, routeIdx) {
  // ORDER MATTERS — write setup answers BEFORE switchGreeting, never after.
  // Choosing an opening resets the session to that opening's snapshot. The engine
  // carries a variable across that reset ONLY if (a) it has scope:"setup" AND
  // (b) it already exists in session state at the moment switchGreeting runs
  // (preserveSetupScopedVariables copies setup vars from the CURRENT state into
  // the adopted snapshot). So write first — give the engine something to preserve —
  // then switch. Writing after the switch + a setTimeout races the snapshot-persist
  // round-trip and intermittently loses, so the player's pick lands empty and the
  // AI acts like nothing was chosen. This is non-deterministic: the same card can
  // work one build and break the next.
  api.setVariable("player_name", name);              // 1. write FIRST — var MUST be scope:"setup"
  if (typeof routeIdx === "number" && api.switchGreeting) {
    api.switchGreeting(routeIdx);                     // 2. then switch — engine preserves the setup var
    setTimeout(function () { api.setVariable("player_name", name); }, 100); // 3. re-assert after reset settles
  }
}
```

> The variable you write here MUST carry `scope: "setup"` (see variables skill + world-design Pattern 7). Without it the engine wipes the pick on opening-switch regardless of ordering. With it, the **write-before-switch** order above is what actually makes the pick survive — a multi-character "pick your cast" gate (e.g. `selected-members`) breaks exactly this way when the frontend switches the greeting before writing the roster.

Do **not** gate player input on `useState` (resets on remount) or on `api.storage` + `api.sessionId` (`sessionId` is `""` on the first render so the key drifts, and `localStorage` writes can drop) — both cause the "re-asks every time you re-enter" bug.

**Cosmetic intros/animations are NOT this bug — replaying them is the author's choice.** A title splash or opening cinematic with no input should just live in `useState` and play per mount; replaying on reload is fine, and some authors want it. Only suppress it across re-entries if the author explicitly asks — and prefer deriving that from an answer you already store (e.g. "if `player_name` is set, skip the intro") over minting a dedicated flag. A single one-time boolean is acceptable if truly needed (it's per-session: a fresh session replays, re-entry doesn't); just don't let the pattern spread to every animation.

### Companion sub-chats: `api.ai.complete` uses the player's model

`api.ai.complete({ messages, includeLorebook, temperature, maxTokens })` runs a side LLM call (e.g. an in-world messenger/DM). It uses the **player's currently selected chat model** and defaults to `temperature: 1.0` — which causes OOC/off-topic replies on weaker models. For in-character side chats, pass an explicit `temperature` (~0.6–0.7) and a `maxTokens`, give a strong identity anchor in the system prompt ("You ARE <character>; stay in character; never refuse"), and feed enough recent main-story context so replies stay coherent.

For image posting/messenger features, pass the uploaded bytes to the model too: `api.sendMessage(text, attachments)` for story turns, or `api.ai.complete({ messages: [{ role: "user", content: text, attachments }] })` for side calls. Attachments use `{ type: "image", mimeType, name, data }` (bare base64). Showing an `<img>` or storing a URL in a variable alone does not let the model see it. Keep image drafts on failure, and let the player choose a model marked Vision. See the TSX SDK reference for limits and content-part support.

### Frontend-controlled lore: `<LoreButton>` / `<LoreSlot>`

When the PLAYER should turn a piece of lore (or a whole knowledge base) on/off from the UI — a "show advanced rules" toggle, a route picker, a codex chip — use these **ambient globals** (no import; the sandbox injects them):

- `<LoreSlot id="slot-id" />` — invisible. While mounted, the entry bound to `slot-id` (bound in the editor's **Custom UI → Bindings**, or via `write_lore_binding`) becomes eligible for AI injection; unmounting deactivates it. Renders nothing — it's a pure switch. The other helpers below all render a `<LoreSlot>` internally when active, so you rarely write this directly.
- `<LoreButton slotId="combat-rules" label="Combat rules" icon="⚔️" description?="…" variant?="chip"|"card" />` — a single player-facing **toggle**: click to turn the slot on, click again to turn it off.
- `<LoreSwitch slotId="secret-codex" onLabel="Open" offLabel="Close" onIcon?="📖" offIcon?="📕" />` — **two explicit buttons** for one slot: one turns the lore ON, the other OFF (vs. LoreButton's single toggle). Use when you want a deliberate open/close pair.
- `<LorePanel title="Codex" slots={["a","b"]}>…</LorePanel>` — a collapsible group; put `<LoreButton>`/`<LoreSwitch>` inside; shows an active-count badge.
- `<LoreGroup slots={[{ id, label, icon }]} />` — an exclusive (radio) group: at most one slot active at a time. Good for mutually-exclusive routes the player toggles live.

All of these persist on/off in a `__lore_{slotId}` game variable, so a player's choice survives reloads and branch switches.

**Gating is real, not cosmetic.** The slot→entry wiring lives in `loreUiBindings` (a binding table set with `write_lore_binding`), separate from the TSX. A bound entry is **excluded from the prompt entirely until its slot is active** — even if the entry is `alwaysSend`. So a "secret" the player must unlock should be a bound entry behind a `<LoreButton>`/`<LoreSwitch>`; do NOT rely on prose like "only reveal after the player clicks" (the model would see it immediately). This complements worldbooks (which gate by activation mode); use these when the **player**, not a variable or opening, should control visibility. See the **lore** skill for the worldbook/route model.

### Fullscreen / immersive mode is automatic

Every rootComponent world auto-enters immersive mode on session load — browser Fullscreen API + hidden sidebar/header, in one go. ESC exits (first press drops immersive, second navigates away). Do NOT call `document.documentElement.requestFullscreen()`, `element.requestFullscreen()`, or track fullscreen state yourself from TSX — you will fight the platform's own state machine and cause the "video stops when I click" / "audio leaks after exit" class of bugs.

If a custom button in your UI needs to toggle immersive mode, call `window.__yuminaToggleImmersive?.()` — this is the platform-blessed path. Don't add your own "enter fullscreen" button unless the user explicitly asked for one.

### Binary assets: `api.fetchAsset()`, and why images are different

The sandbox cannot make network requests at all (`connect-src 'none'`). Images and media still work because the browser gives `<img>`/`<audio>`/`<video>` a privileged loading path that is not a fetch. There is no `<model>` tag, so binary formats have no equivalent.

So there are two rules, and mixing them up wastes a lot of time:

- **Images** — `<img src={api.resolveAssetUrl("@asset:...")}/>`. No fetch involved. If the image becomes a **WebGL texture** or you need `getImageData()`, set `img.crossOrigin = "anonymous"` — reading pixels from a cross-origin image requires CORS, and the sandbox is always cross-origin to the asset host.
- **Everything else** (`.glb`, large JSON, sprite atlas, binary tables) — `await api.fetchAsset(ref)`. The parent fetches and hands the bytes over.

```js
const r = await api.fetchAsset("@asset:...");
if (!r.ok) return;              // "bad-ref" | "http-404" | "too-large" | "unavailable"
loader.parse(r.bytes, "", onLoad);   // e.g. a GLB — parse(), never load(url)
```

It takes an asset id, never a URL — a card reads its own assets and nothing else. 32MB ceiling per call.

**Never let a missing asset be fatal.** Keep the flat colour / placeholder the material or component already had and carry on: a deleted asset or an offline moment should look worse, never render a black screen.

### Supporting the creator: `api.openSupport()`

The play header carries a heart button that opens the platform's tip dialog (dollar tip / mushie gift, attributed to this world). A fullscreen takeover **covers that header**, so on a takeover card the player has no way to support the creator unless you offer one.

Call `api.openSupport()` — same dialog, same attribution, no payment code of your own. **Never build your own tip/payment/donation UI**: you cannot take money, and a fake one is a scam surface.

It returns a promise, and you must `await` it:

```js
const r = await api.openSupport();
if (!r.opened) {
  // "self" = the viewer IS the creator · "signed-out" · "unavailable" = editor preview
  showNote(r.reason === "self" ? "You are the creator" : "Sign in to support");
}
```

The dialog cannot open for the creator (nobody tips themselves) — and **the creator is the first person who will ever press this button**, while testing their own card. A silent no-op reads as a broken button, so always surface the reason.

Keep the entry small and out of the way — a corner of a title/pause screen, never a modal mid-play, never during a loss. Only offer it where the player is already idle.

### Audio: prefer `api.playAudio()` over `<audio>` / `<video muted={false}>`

`api.playAudio(trackId, opts)` runs in the **parent window**, not your sandboxed iframe. It survives component re-mounts, won't leak on navigation, handles fade/chain/ducking, and is unaffected by browser autoplay policy nuances. Use it for BGM and SFX.

```js
React.useEffect(function() {
  api.playAudio("main-theme", { fadeDuration: 2 });
  return function() { api.stopAudio("main-theme", 1); };
}, []);
```

Define the audio track with the `write_audio` tool first.

### Video: muted autoplay + unmute-on-gesture + explicit cleanup

A `<video>` tag IS the right choice for cinematic visuals (menu backgrounds, cutscenes). Three rules to avoid bugs:

1. **Start muted** — `<video autoPlay muted loop playsInline>`. Chrome blocks unmuted autoplay without user engagement; sandboxed iframes have no engagement signal. Muted autoplay always works.
2. **Unmute on the first user gesture, never before** — any menu button's `onClick` can flip `videoRef.current.muted = false`. Do NOT try to unmute in `useEffect` / `loadedmetadata` / `onPlay`; the browser silently pauses the video when you do, and it looks like "the video is frozen."
3. **Clean up on unmount** — detached `<video>` elements keep their audio track alive in Chrome until GC runs. Always:

```js
React.useEffect(function() {
  var vid = videoRef.current;
  return function() {
    if (vid) { vid.pause(); vid.removeAttribute("src"); vid.load(); }
  };
}, []);
```

Without this cleanup, users hear ghost audio seconds after navigating away. This is the #1 reported "our video is buggy" symptom — fix it by default.
