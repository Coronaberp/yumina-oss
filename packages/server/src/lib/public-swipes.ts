/** Validation evidence belongs to the session owner, not public replays. */
export function publicSwipes<T extends { stateValidation?: unknown; generationState?: unknown; contentFlags?: unknown }>(swipes: T[] | null): Omit<T, "stateValidation" | "generationState" | "contentFlags">[] {
  return (swipes ?? []).map(({ stateValidation: _audit, generationState: _baseline, contentFlags: _content, ...swipe }) => swipe);
}
