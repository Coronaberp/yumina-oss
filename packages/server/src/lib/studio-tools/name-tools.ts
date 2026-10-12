import { NAME_STYLE_KEYS } from "@yumina/shared";
import type { ToolDefinition } from "../llm/types.js";

const constraints = { type: "object", additionalProperties: false, properties: {
  minLength: { type: "integer", minimum: 3, maximum: 40 }, maxLength: { type: "integer", minimum: 3, maximum: 40 },
  minSyllables: { type: "integer", minimum: 1, maximum: 12 }, maxSyllables: { type: "integer", minimum: 1, maximum: 12 },
  prefix: { type: "string", description: "Required Latin-letter prefix, applied before length and syllable checks." },
  suffix: { type: "string", description: "Required Latin-letter suffix." },
} };
const fragments = { type: "array", minItems: 1, maxItems: 200, items: {
  type: "array", description: "Exactly [fragment, positive integer weight], in that order.",
  items: { anyOf: [{ type: "string" }, { type: "integer", minimum: 1, maximum: 1000 }] }, minItems: 2, maxItems: 2,
} };
export const NAME_OPTIONS_TOOL_PROPERTIES = {
  style: { type: "string", enum: [...NAME_STYLE_KEYS, "random"], description: "Fictional language-inspired phonetics. Omit to use a profile's style, or a random style without a profile." },
  surnameStyle: { type: "string", enum: [...NAME_STYLE_KEYS] },
  gender: { type: "string", enum: ["masculine", "feminine", "neutral"] },
  weirdness: { type: "number", minimum: 0, maximum: 1, description: "Default 0.35; 0 conservative, 1 unusual." },
  format: { type: "string", enum: ["given", "surname", "full"] },
  order: { type: "string", enum: ["given-family", "family-given"] },
  surname: { type: "string", description: "An exact family name supplied by the creator. Reuse for related characters; never invent this parameter." },
  particle: { type: "string", description: "Creator-supplied particle, e.g. de or von, before the family name." },
  constraints: { ...constraints, description: "Given-name (or single-name) length, affixes and estimated syllable counts. Defaults to 3–15 letters. Syllables use vowel-group counting, not linguistic analysis." },
  surnameConstraints: { ...constraints, description: "Constraints on generated family names." },
  maxFullLength: { type: "integer", minimum: 3, maximum: 120 },
  avoidSimilar: { type: "boolean", description: "Default true: reject confusingly similar names using local edit distance. False returns similarity warnings while still excluding exact duplicates." },
  phonetics: { type: "object", additionalProperties: false, description: "Optional creator-authored fragment overrides. Use installed tables unless the creator supplies fragments; never invent fragments to bypass the generator.", properties: {
    starts: fragments, middles: fragments,
    endings: { type: "object", properties: { masculine: fragments, feminine: fragments, neutral: fragments } },
    syllableWeights: { type: "array", items: { type: "integer", minimum: 1, maximum: 1000 }, minItems: 1, maxItems: 8 },
    joiners: { type: "array", items: { type: "string", enum: ["", "-", "'"] }, minItems: 1, maxItems: 3 },
  } },
};
export const NAME_PROFILES_TOOL_SCHEMA = { type: "array", maxItems: 100, description: "Reusable creator-defined naming cultures. Replaces the list; read settings first and preserve unrelated profiles. Names are generated locally without an LLM.", items: {
  type: "object", additionalProperties: false, properties: { ...NAME_OPTIONS_TOOL_PROPERTIES,
    id: { type: "string" }, label: { type: "string" },
    region: { type: "string" }, species: { type: "string" }, clan: { type: "string" }, family: { type: "string" },
  }, required: ["id", "label"],
} };
export const NAME_READ_TOOLS: ToolDefinition[] = [
  { type: "function", function: { name: "generate_names", description: "Generate fictional names locally using the creator's TypeScript phonetic generator. REQUIRED whenever you suggest new names; never invent or alter names yourself. Supports full names, order, culture/family profiles and constraints. Excludes existing and previously generated card names; returns parts and similarity warnings. Does not edit the card. Preserve supplied existing names.", parameters: {
    type: "object", additionalProperties: false, properties: { ...NAME_OPTIONS_TOOL_PROPERTIES,
      profileId: { type: "string", description: "Creator-defined culture profile ID from list_name_profiles." },
      count: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
      seed: { anyOf: [{ type: "string" }, { type: "integer" }], description: "Optional reproducible seed. Previously reserved names are still excluded on later requests." },
      exclude: { type: "array", items: { type: "string" }, maxItems: 1000 },
    },
  } } },
  { type: "function", function: { name: "list_name_profiles", description: "List available phonetic styles and this card's creator-defined culture/family naming profiles, plus instructions to configure them. No model generation or edits.", parameters: { type: "object", properties: {} } } },
];
