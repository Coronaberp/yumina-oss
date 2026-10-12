import {
  characterIdentifiers, displayCharacterName, keywordMatches, checkConditions,
  filterEntriesByActiveLoreSlots, filterEntriesByActiveWorldbooks,
  type WorldDefinition, type WorldEntry, type GameState,
} from "@yumina/engine";
import { identityRoleMatches, explicitlyEmptyCharacterScene } from "./story-character-identity.js";

/** Names and portrait identifiers stay available even when biographies are recalled. */
export function storyCharacterRoster(world: WorldDefinition, state?: GameState): WorldEntry | undefined {
  const names = world.entries.filter(e => e.role === "character" && (state?.ruleState?.toggledEntries?.[e.id] ?? e.enabled) !== false && !e.memory?.hidden)
    .map(e => e.name?.trim()).filter(Boolean);
  if (!names.length) return;
  return {
    id: "__story_character_roster__", name: "Character roster", role: "custom",
    content: `## Character roster\n${[...new Set(names)].map(name => `- ${name}`).join("\n")}\nCharacter biographies are supplied when relevant to the current scene.`,
    alwaysSend: true, enabled: true, keywords: [], conditions: [], conditionLogic: "all", section: "system-presets", position: 0,
  };
}

/** Keep author gates on biographies; retrieval cannot reveal an inactive entry. */
export function eligibleStoryCharacters(world: WorldDefinition, state?: GameState): WorldEntry[] {
  const characters = world.entries.filter(e => e.role === "character" &&
    (state?.ruleState?.toggledEntries?.[e.id] ?? e.enabled) !== false && !e.memory?.hidden &&
    (!state || !e.conditions?.length || checkConditions(state, e.conditions, e.conditionLogic)));
  return state ? filterEntriesByActiveLoreSlots(filterEntriesByActiveWorldbooks(characters, world.worldbooks, state), world.loreUiBindings, state) : characters;
}

export function storyCharacterKeywords(entries: readonly WorldEntry[]): Map<string, string[]> {
  const names = entries.map(e => displayCharacterName(e.name));
  const identifiers = characterIdentifiers(names);
  return new Map(entries.map(e => [e.id, [...new Set([
    e.name, displayCharacterName(e.name), e.id, ...(e.keywords ?? []),
    ...identifiers.filter(candidate => candidate.name === displayCharacterName(e.name)).map(candidate => candidate.identifier),
  ])].filter(Boolean)]));
}

export function neededStoryCharacters(world: WorldDefinition, query: string, state?: GameState): WorldEntry[] {
  const characters = eligibleStoryCharacters(world, state);
  if (explicitlyEmptyCharacterScene(query)) return [];
  const keys = storyCharacterKeywords(characters);
  const named = characters.filter(e => keys.get(e.id)!.some(key => keywordMatches(query, key, true)));
  return [...new Map([...named, ...identityRoleMatches(characters, query)].map(e => [e.id, e])).values()];
}
