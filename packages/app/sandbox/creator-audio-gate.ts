/** Suppress raw creator media as well as SDK tracks while the listener owns audio. */
export function createCreatorAudioGate(original: { play: (this: { pause(): void }) => Promise<void> }) {
  let allowed = true;
  const setAllowed = (value: boolean, media: Iterable<{ pause(): void }>) => {
    allowed = value;
    if (!allowed) for (const element of media) element.pause();
  };
  return {
    allowed: () => allowed,
    setAllowed,
    setOwnership(mode: string, suspended: boolean, media: Iterable<{ pause(): void }>) {
      setAllowed(mode === "creator" && !suspended, media);
    },
    play(element: { pause(): void }) {
      if (!allowed) return Promise.resolve();
      return original.play.call(element);
    },
  };
}
