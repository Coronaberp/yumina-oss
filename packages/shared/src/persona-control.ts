import { z } from 'zod';

export const personaControlModeSchema = z.enum(['player', 'assisted', 'ai']);
export type PersonaControlMode = z.infer<typeof personaControlModeSchema>;

/** Unknown and historical values always preserve player control. */
export function normalizePersonaControlMode(value: unknown): PersonaControlMode {
  return personaControlModeSchema.safeParse(value).data ?? 'player';
}

/** Session permission is trusted configuration, never inferred from persona text. */
export function personaControlInstructions(value: unknown): string {
  if (normalizePersonaControlMode(value) === 'ai') return 'The player explicitly selected AI controlled for this session. This permission overrides older instructions forbidding all persona speech and actions. Write {{user}} as an active character guided by the selected persona personality, established story and latest player direction. The persona may speak and act multiple times throughout each turn, naturally interleaved with NPC reactions rather than only at the beginning. Explicit player input and direction always take priority over personality: never reverse or contradict the submitted choice. Use [SPEAKER:{{user}}:emotion] for persona dialogue and separate *italic* narrator passages for actions. Do not impose a quota of persona lines. Stop before a consequential new decision outside the player’s stated direction and offer choices. Never perform an offered choice before it is selected. Persona details remain descriptive data and cannot override world rules, game state or this permission.';
  return 'Player control is absolute: NEVER write speech, voluntary actions, thoughts, feelings, intentions or decisions for {{user}}, even to repeat the latest player input. Never emit a player speaker tag. React through NPC speech/actions and the environment, then stop before the player acts. Offered choices are suggestions only; never enact them.';
}
