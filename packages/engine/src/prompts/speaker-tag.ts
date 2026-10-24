import type { WorldDefinition, WorldEntry } from "../types/index.js";
import { readVnSpriteConfig, readVnSpriteVariants, VN_SPRITE_DEFAULT_EMOTIONS, type VnSpriteConfig } from "../world/vn-assets.js";
import { personaControlInstructions, type PersonaControlMode } from '@yumina/shared';

/**
 * Speaker tag — the AI names who is talking BEFORE it writes the line.
 *
 * In a world with named characters, the prompt asks the
 * model to open every reply with `[speaker: Name]`. The tag is the first few
 * tokens of the stream, so the chat knows whose face to show before any prose
 * arrives, instead of guessing from names in the text afterwards.
 *
 * The tag is only ever recognized at the very START of a reply. Variable
 * directives live at the end, so a world that happens to own a variable
 * called `speaker` keeps working — and such a world never gets the prompt
 * block in the first place (see `speakerTagEnabled`).
 */

export const NARRATOR_SPEAKER = "narrator";

/** `[speaker: Name]` at the start of a reply, tolerating padding and a
 *  stray blank line before it. Case-insensitive on the key. */
const LEADING_SPEAKER_TAG = /^\s*\[\s*speaker\s*:\s*([^:\]\n]*?)\s*\]/i;

/** Character entries that can put a face on a line: enabled, `role:
 *  "character"`, with a portrait set. */
export function portraitCharacters(entries: ReadonlyArray<WorldEntry> | undefined): WorldEntry[] {
  return (entries ?? []).filter(
    (e) =>
      e.role === "character" &&
      e.enabled !== false &&
      typeof e.portrait === "string" &&
      e.portrait.length > 0,
  );
}

/** Entry names often carry an author-side label ("人物：Balder", "NPC: Mia").
 *  The player-facing name is what follows the colon. */
export function displayCharacterName(raw: string): string {
  const trimmed = raw.trim();
  const m = /^[^:：]{1,12}[:：]\s*(.+)$/s.exec(trimmed);
  return m && m[1]!.trim() ? m[1]!.trim() : trimmed;
}

/** Keep canonical asset keys while accepting unique short names, name parts
 * and parenthetical aliases. Ambiguous aliases are never inferred. */
export function characterIdentifiers(names: ReadonlyArray<string>) {
  const normalize = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
  const records = [...new Set(names)].map(name => {
    const qualifier = /\s*\(([^()]+)\)\s*$/.exec(name);
    const base = name.replace(/\s*\([^()]+\)\s*$/, "").trim();
    const aliases = [...new Set([base, ...base.split(/\s+/), ...(qualifier ? [qualifier[1]!.trim(), ...qualifier[1]!.trim().split(/\s+/)] : [])])];
    return { name, aliases: aliases.filter(alias => alias && normalize(alias) !== normalize(name)) };
  });
  const owners = new Map<string, Set<string>>();
  for (const { name, aliases } of records) {
    for (const identifier of [name, ...aliases]) {
      const key = normalize(identifier);
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key)!.add(name);
    }
  }
  return records.flatMap(({ name, aliases }) => [{ name, identifier: name }, ...aliases.filter(alias => owners.get(normalize(alias))!.size === 1).map(identifier => ({ name, identifier }))]);
}

export function canonicalCharacterName(names: ReadonlyArray<string>, name: string) {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  return characterIdentifiers(names).find(candidate => normalize(candidate.identifier) === normalize(name))?.name || null;
}

/** Speech and narration need distinct names even before portraits are
 *  uploaded, including in single-character worlds. Keep clear of any
 *  variable that would collide with the tag's name. */
export function speakerTagEnabled(world: Pick<WorldDefinition, "entries" | "variables">): boolean {
  if (!(world.entries ?? []).some(e => e.role === "character" && e.enabled !== false && displayCharacterName(e.name))) return false;
  if ((world.variables ?? []).some((v) => v.id.toLowerCase() === "speaker")) return false;
  return true;
}

export interface SpeakerTagParse {
  /** The tagged name, or null when the reply carried no tag. `"narrator"`
   *  is returned as-is (lower-cased) so callers can treat it explicitly. */
  speaker: string | null;
  /** The text with the leading tag removed. */
  text: string;
}

export function parseLeadingSpeakerTag(text: string): SpeakerTagParse {
  const m = LEADING_SPEAKER_TAG.exec(text);
  if (!m) return { speaker: null, text };
  const raw = m[1]!.trim();
  const speaker = raw.toLowerCase() === NARRATOR_SPEAKER ? NARRATOR_SPEAKER : raw;
  return { speaker: speaker || null, text: text.slice(m[0].length).replace(/^[ \t]*\n/, "") };
}

/** True while a stream is still inside a partial leading tag (`[spea`,
 *  `[speaker: Mi`), so the UI can hold the label instead of flashing it. */
export function isPartialLeadingSpeakerTag(text: string): boolean {
  const head = text.trimStart();
  if (!head.startsWith("[")) return false;
  if (head.includes("]")) return false;
  return /^\[\s*(s(p(e(a(k(e(r(\s*(:.*)?)?)?)?)?)?)?)?)?$/i.test(head);
}

/** The prompt block that teaches the tag. Empty when the world doesn't
 *  qualify. */
type SpeakerFormatWorld = Pick<WorldDefinition, "entries" | "variables"> & Partial<Pick<WorldDefinition, "rootComponent">>;

function usesVnSpeakerFormat(world: SpeakerFormatWorld): boolean {
  const root = world.rootComponent;
  const source = root?.files["__user-root.tsx"] ?? root?.files[root.entryFile] ?? "";
  return root?.interfaceId === "vn" || /className="vn"/.test(source) || (world.entries ?? []).some(e => e.enabled !== false && /\[\s*(?:SPEAKER|Name)\s*:[^\]\n]+:[^\]\n]+\]/i.test(e.content || ""));
}

export const CHOICE_TEXT_FORMAT = 'Wrap choice actions in single asterisks, e.g. *Inspect the cup*, and dialogue in double quotes, e.g. "Can you explain?". A choice may combine an action and dialogue. Write the exact proposed player speech rather than an instruction to say it. Escape dialogue quotes inside the JSON strings. Whenever a choice names the player, use the literal token {{user}}, including in spoken self-introductions such as "My name is {{user}}." Use {{user}}\'s for a possessive. Never invent or substitute a personal name for the player; preserve NPC names. The interface substitutes the selected persona name locally. {{user}} represents the complete selected name: never append fill-in placeholders such as [Surname] or [Your name]. Do not invent the player\'s education, rank, abilities, possessions or payment history; use the supplied persona and authoritative state.';
const VN_CHOICE_FORMAT = 'For EVERY playable turn, generate 2–4 distinct, concrete actions or replies that the player can choose next. Include exactly one [CHOICES: ["Option one", "Option two"]] block after the story passages, using a valid JSON array of nonempty strings. Never omit choices, return an empty array, or use "..." as a generated option for an ongoing story; the interface adds its own custom-response button. Do not perform a choice or write its outcome before the player selects it. Omit choices only for an explicitly ended story. ' + CHOICE_TEXT_FORMAT;
const VN_NPC_FORMAT = 'For an undefined NPC whose gender is established in the story, extend the marker to [SPEAKER:NPC:emotion:male:stable-id] or [SPEAKER:NPC:emotion:female:stable-id], for example [SPEAKER:NPC:normal:male:academy-clerk]. Reuse that hidden stable-id and gender across all passages and future turns for the same NPC. The visible label is always NPC; do not output NPC A/B/C. Never infer gender from a name alone. If gender or identity is unknown, keep [SPEAKER:NPC:emotion] without inventing metadata. Never add NPC gender metadata to a defined character or Narrator.';
function vnSpriteFormat(world: SpeakerFormatWorld): string {
  let config: VnSpriteConfig = { types: { normal: "Normal" }, emotions: { ...VN_SPRITE_DEFAULT_EMOTIONS } };
  let variants: ReturnType<typeof readVnSpriteVariants> = {};
  try {
    const source = world.rootComponent?.files["sprites.ts"] || "export const sprites = {};";
    config = readVnSpriteConfig(source);
    variants = readVnSpriteVariants(source);
  }
  catch { /* Legacy executable maps stay supported without evaluating authored code. */ }
  const nested = Object.entries(variants).filter(([, options]) => Object.keys(options).length)
    .map(([type, options]) => `${type}: ${Object.keys(options).join(", ")}`).join("; ");
  return `Sprite emotions: ${Object.keys(config.emotions).join(", ")}. Sprite types: ${Object.keys(config.types).join(", ")}. Use only configured type and variant IDs. Select a wardrobe with [SPEAKER:Name:emotion:type], or a nested variant with [SPEAKER:Name:emotion:type:variant]. ${nested ? `Variants by type: ${nested}. ` : ""}Omitting type keeps the current outfit, including its variant. An explicit type without a variant selects that type's base outfit. Opening defaults apply until a later valid outfit marker changes them. Available image expressions are scoped to each character and exact outfit in current visual context; use its default image expression when there is no matching image, and normal when that outfit has no art. Never borrow art from another outfit. Describe emotions freely in prose; image availability does not limit character emotions or story choices. Narrator always uses normal. NPC gender and stable-id fields retain their existing meaning and are never wardrobe types or variants.`;
}
const VN_STORY_CONSISTENCY = 'Continue from the latest actual player input; a selected action has already been chosen. React to its consequences instead of asking the player to choose it again or repeating name-registration steps. The {{user}} identity is distinct from every NPC, including similarly spelled roster names; never interpret a player self-introduction as summoning an NPC. Keep incidental NPCs distinct from defined characters and preserve established gender, species and identity; a shared appearance does not establish that two people are the same person. Stage directions and third-person actions belong to Narrator, outside spoken quotes. A generic NPC marker never authorizes player speech. Narrative outcomes must agree with the authoritative game-state and valid declared updates: spending, rewards, injuries, time advancement and registration cannot be completed in prose while omitting their corresponding mechanics. Derive clock times and durations consistently from the authoritative clock; do not invent contradictory countdowns or bell counts. Do not equate ordinary excitement or exertion with sexual arousal, or invent the player\'s private feelings. Preserve confirmed scene commitments and advance the current event rather than replaying an already resolved beat.';

export function buildVnTurnReminder(world: SpeakerFormatWorld, personaControlMode?: PersonaControlMode): string {
  if (!usesVnSpeakerFormat(world)) return "";
  const names = (world.entries ?? []).filter(e => e.role === "character" && e.enabled !== false).map(e => displayCharacterName(e.name));
  return [
    "<vn-turn-format>",
    "This VN output contract takes precedence over older style instructions that make markers optional or request an unstructured ending.",
    `Known character names: ${names.join(", ")}.`,
    "Prefix EVERY spoken passage, including each new quote after an action, with [SPEAKER:Name:emotion]. Use the exact known character name; never omit the speaker or replace the name with a pronoun.",
    vnSpriteFormat(world),
    "For a character without a defined character entry, use [SPEAKER:NPC:emotion]. Every dialogue passage needs an identifier, including incidental NPCs without a portrait.",
    VN_NPC_FORMAT,
    "Narration and actions use [SPEAKER:Narrator:normal] and *italics*. Keep them separate from dialogue. Never write she/he/they says, asks, whispers, or other pronoun speech attribution.",
    'Use exact character names in ALL narrator actions and descriptions, including possessives. Write "Evelia sets the cup down" and "Evelia’s voice wavers", never "She sets the cup down" or "Her voice wavers". Do not use he/she/they or his/her/their to refer to characters in narration.',
    'Refer to the player with the literal token {{user}}, and {{user}}\'s for a possessive. This token represents the selected in-world persona. The interface substitutes the persona name locally. Use named-character grammar. Never substitute any account or persona name into model output, or refer to the player as "the player" or "you" in narration.',
    personaControlInstructions(personaControlMode),
    VN_CHOICE_FORMAT,
    VN_STORY_CONSISTENCY,
    "Before finishing, check every passage's speaker/emotion marker and the playable turn's choices. Ending mid-scene means pausing for a player decision, with choices still included.",
    "</vn-turn-format>",
  ].join("\n");
}

export function buildSpeakerFormatBlock(world: SpeakerFormatWorld, personaControlMode?: PersonaControlMode): string {
  if (usesVnSpeakerFormat(world)) {
    const names = (world.entries ?? []).filter(e => e.role === "character" && e.enabled !== false).map(e => displayCharacterName(e.name));
    return [
      "<vn-format>",
      "Follow this VN output contract even when older authored style text calls markers optional or asks for free-form roleplay.",
      `Character names: ${names.join(", ")}.`,
      "Use the authored VN markers. Prefix EVERY spoken passage with [SPEAKER:Name:emotion], preserving the exact character name and expression; [Name:Name:emotion] is also supported.",
      vnSpriteFormat(world),
      "For a character without a defined character entry, use [SPEAKER:NPC:emotion]. Every dialogue passage needs an identifier, including incidental NPCs without a portrait.",
      VN_NPC_FORMAT,
      "For narration use [SPEAKER:Narrator:normal]. Keep every action and description in its own *italic* narration passage, separate from spoken text.",
      'Use exact character names and named possessives throughout narrator actions and descriptions. Write "Evelia sets the cup down" and "Evelia’s voice wavers"; never refer to characters as he/she/they or his/her/their in narration.',
    'Refer to the player with the literal token {{user}}, and {{user}}\'s for a possessive. This token represents the selected in-world persona. The interface substitutes the persona name locally. Use named-character grammar. Never substitute any account or persona name into model output, or refer to the player as "the player" or "you" in narration.',
      'Dialogue is plain text in double quotes. Remove star emphasis inside quotes. Never mix an action into a spoken passage.',
      'Always use the character’s exact name for speech attribution. Never use "she says", "he says", or "they say", or pronouns with any other speech verb (asks, whispers, replies, etc.). Write "Miveth says" or "Evelia asks" in narration instead. Prefer the speaker marker without redundant attribution.',
      "Keep [SCENE:scene-id] when the location changes. Do not replace expression markers with the chat-only two-field speaker tag.",
    personaControlInstructions(personaControlMode),
    VN_CHOICE_FORMAT,
    VN_STORY_CONSISTENCY,
      "</vn-format>",
    ].join("\n");
  }
  if (!speakerTagEnabled(world)) return "";
  const names = (world.entries ?? []).filter(e => e.role === "character" && e.enabled !== false && displayCharacterName(e.name)).map(e => displayCharacterName(e.name));
  return [
    "<speaker-format>",
    `Characters: ${names.join(", ")}.`,
    "Begin EVERY reply with a speaker tag as the very first thing, before any prose:",
    "  [speaker: Name]",
    "Name is exactly one of the names above — the speaker of the FIRST paragraph. For an undefined character, use NPC, including in later NPC: dialogue paragraphs.",
    `When the first paragraph is narration, write [speaker: ${NARRATOR_SPEAKER}].`,
    "The tag is stripped before the player sees the reply; never mention it in the text.",
    "Start a new paragraph whenever the speaker changes, separating paragraphs with a blank line.",
    "Start each character's paragraph with Name: dialogue, using their exact name above and enclosing the spoken text in double quotes.",
    "Start each narration paragraph with Narrator: narration. The labels become section headers for the player.",
    "Do not put different characters' dialogue in the same paragraph.",
    'Always name the character in speech attribution. Never use "she says", "he says", or "they say", or pronouns with other speech verbs; use the exact character name.',
    "Actions and descriptions belong to Narrator, written in *italics* in their own narration paragraph, even when the action names a character.",
    "Do not put action text or emphasis markers inside quoted dialogue. Quoted dialogue is plain spoken text.",
    "Use the bracketed speaker tag only once at the start of the reply; use plain Name: labels for later paragraphs.",
    "</speaker-format>",
  ].join("\n");
}
