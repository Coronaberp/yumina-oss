import { personaControlInstructions, type PersonaControlMode } from '@yumina/shared';
import {
  completeStoryEnding,
  resolveStoryProgress,
  ResponseParser,
} from "@yumina/engine";
import type { ChatMessage, GameState, WorldDefinition } from "@yumina/engine";

/** Resolve progression after the ordinary turn, before any closing call. */
export function evaluatePendingStoryEnding(
  world: WorldDefinition,
  state: GameState,
  operationId: string,
): GameState {
  return resolveStoryProgress(world, state, { operationId, selectEnding: true });
}

/** Authored prose completes an already persisted ending-ready state only. */
export function completeAuthoredStoryEnding(state: GameState, presentation: string): GameState {
  if (state.story?.ending?.mode !== "authored") throw new Error("The pending ending is not authored");
  const prose = state.story.ending.prose;
  if (!prose.trim()) throw new Error("The authored ending has no prose");
  if (presentation !== prose) throw new Error("Authored ending prose must match the captured definition");
  return completeStoryEnding(state, prose);
}

/** Build one closing-only request. The model receives the fixed outcome, never ending conditions. */
export function buildStoryEndingPrompt(state: GameState, scene: string, personaControlMode?: PersonaControlMode): ChatMessage[] {
  const ending = state.story?.ending;
  if (state.story?.status !== "ending-ready" || !ending || ending.mode !== "ai") throw new Error("No AI ending is pending");
  return [
    { role: "system", content: [
      "Write the final closing prose for this story.",
      "{{user}} refers to the selected persona. Use only this literal token for player references, with named-character grammar; the interface displays the persona name locally.",
      personaControlInstructions(personaControlMode),
      `Fixed outcome: ${ending.outcome}`,
      state.story?.route?.guidance?.trim() ? `Active route guidance: ${state.story.route.guidance.trim()}` : "",
      ending.guidance.trim() ? `Creator guidance: ${ending.guidance.trim()}` : "",
      "Do not introduce a new choice, ask the player a question, emit state directives, select another ending, or advance the plot beyond this outcome.",
      "Return only the prose, with no JSON wrapper and no labels.",
    ].filter(Boolean).join("\n") },
    { role: "user", content: `Completed scene:\n${scene.slice(-24000)}` },
  ];
}

/** Validate closing output before it can transition ending-ready to completed. */
export function validateStoryEndingPresentation(raw: string): string {
  const prose = raw.trim().replace(/^```(?:text|markdown)?\s*([\s\S]*?)\s*```$/i, "$1").trim();
  if (!prose) throw new Error("The ending response was empty");
  const parsed = new ResponseParser().parse(prose);
  if (/\[(?:choices?|options?)(?:\s*:|\s*\])/i.test(prose) || (parsed.choices?.length ?? 0) > 0 || parsed.effects.length > 0 || parsed.audioEffects.length > 0 || /\[(?:route|ending|story|state|game-state)(?:\s*:|\s*\])/i.test(prose) || /(?:^|\n)\s*(?:\d+[.)]|[-*])\s+[^\n]+(?:\n|$)/.test(prose)) {
    throw new Error("The ending response contained a choice or state directive");
  }
  return prose;
}
