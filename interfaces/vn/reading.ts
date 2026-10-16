/** Reveal long passages a screenful at a time before a reading tap advances. */
export function usePassageReading(view, turn, index, text, playerLine) {
  React.useLayoutEffect(() => {
    const passage = view.current?.querySelector(".vn-text");
    if (passage) passage.scrollTop = 0;
  }, [turn, index, text, playerLine]);

  return () => {
    const passage = view.current?.querySelector(".vn-text");
    if (!passage || passage.clientHeight <= 0 || passage.scrollHeight - passage.clientHeight - passage.scrollTop <= 1) return false;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    passage.scrollBy({ top: Math.max(1, passage.clientHeight * 0.8), behavior: reducedMotion ? "instant" : "smooth" });
    return true;
  };
}
