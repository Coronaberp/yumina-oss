/** Saved pace values identify Fast/Default/Slow; they scale the whole wait.
 * Count rendered text, estimating only one visible screenful for overflow. */
export function autoReadingDelay(text, pace = 4500, passage = null) {
  const speed = [2500, 4500, 7000].includes(pace) ? pace : 4500;
  const count = Array.from(String(passage?.textContent ?? text).replace(/\s+/g, " ").trim()).length;
  const visibleFraction = passage?.clientHeight > 0 && passage.scrollHeight > passage.clientHeight
    ? Math.min(1, passage.clientHeight / passage.scrollHeight) : 1;
  return Math.max(700, Math.round(speed * (0.2 + count * visibleFraction / 350)));
}

/** One reader-owned timer. SDK rerenders refresh callbacks without restarting
 * the wait; page changes and interruptions cancel even already-queued work. */
export function useAutoReading(options) {
  const current = React.useRef(options);
  current.current = options;
  const { active, paused, halted, pageKey, text, pace, view } = options;
  React.useEffect(() => {
    if (!active) return;
    if (halted || document.hidden) { current.current.onStop(); return; }
    if (paused) return;
    let cancelled = false, timer;
    function schedule() {
      timer = setTimeout(() => {
        const latest = current.current;
        if (cancelled || !latest.active || latest.paused || latest.halted || latest.pageKey !== pageKey || document.hidden) return;
        if (latest.scrollPassage()) schedule();
        else latest.onAdvance();
      }, autoReadingDelay(text, pace, view.current?.querySelector(".vn-text")));
    }
    schedule();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, paused, halted, pageKey, text, pace, view]);

  React.useEffect(() => {
    const node = view.current;
    const visibility = () => { if (document.hidden) current.current.onStop(); };
    const pointer = event => { if (event.target.closest?.(".vn-text")) current.current.onStop(); };
    document.addEventListener("visibilitychange", visibility);
    node?.addEventListener("pointerdown", pointer);
    return () => { document.removeEventListener("visibilitychange", visibility); node?.removeEventListener("pointerdown", pointer); };
  }, [view]);
}
