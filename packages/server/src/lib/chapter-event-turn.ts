import { advanceChapterEvents, runReactionChain, type ChapterEventEvidence, type GameStateManager, type ReactionEvaluator, type ReactionRunResult, type WorldDefinition } from "@yumina/engine";

/** Event effects join the same turn ledger and reaction budget. Reactions that
 * already fired for the narrative cannot fire twice for an event reward. */
export function settleChapterEventTurn(world: WorldDefinition, manager: GameStateManager, evaluator: ReactionEvaluator, evidence: ChapterEventEvidence | undefined, previous: ReactionRunResult): ReactionRunResult {
  const changes = advanceChapterEvents(world, manager, evidence);
  if (!changes.length) return previous;
  const fired = new Set(previous.firedIds);
  const followup = runReactionChain(evaluator, manager, changes.map(change => ({ type: "state:changed" as const, ...change })), (world.reactions ?? []).filter(r => !fired.has(r.id)), (world.rules ?? []).filter(r => !fired.has(r.id)));
  return {
    changes: [...previous.changes, ...changes, ...followup.changes],
    audioEffects: [...previous.audioEffects, ...followup.audioEffects],
    notifications: [...previous.notifications, ...followup.notifications],
    contextMessages: [...previous.contextMessages, ...followup.contextMessages],
    firedIds: [...previous.firedIds, ...followup.firedIds],
  };
}
