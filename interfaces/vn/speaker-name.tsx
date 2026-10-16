/** Log columns use short labels; stacked phone rows can show up to 80 characters. */
export function shortSpeakerName(name: string, stacked = false): string {
  const full = name.trim();
  if (stacked) {
    const characters = Array.from(full);
    return characters.length > 80 ? characters.slice(0, 80).join("") + "...." : full;
  }
  const parenthesis = full.search(/[（(]/u);
  if (parenthesis >= 0) return full.slice(0, parenthesis).trim() || full;
  const characters = Array.from(full);
  return characters.length > 10 ? characters.slice(0, 10).join("") + "...." : full;
}

export function SpeakerName({ name = "", suffix = "", className, truncate = true }) {
  const label = React.useRef(null);
  const [stacked, setStacked] = React.useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(max-width:600px) and (orientation:portrait)").matches);
  React.useLayoutEffect(() => {
    const media = window.matchMedia?.("(max-width:600px) and (orientation:portrait)");
    if (!media) return;
    const update = () => setStacked(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const visible = (truncate ? shortSpeakerName(name, stacked) : name.trim()) + suffix;
  React.useLayoutEffect(() => {
    const container = label.current;
    const text = container?.firstElementChild;
    if (!container || !text) return;
    let active = true;
    function fit() {
      if (!active) return;
      container.style.removeProperty("font-size");
      const size = parseFloat(window.getComputedStyle(container).fontSize);
      const width = text.getBoundingClientRect().width;
      const available = container.clientWidth;
      if (size > 0 && width > available && available > 0) {
        container.style.fontSize = `${size * Math.max(1, available - 1) / width}px`;
      }
    }
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(container);
    window.addEventListener("resize", fit);
    document.fonts?.ready.then(fit);
    document.fonts?.addEventListener("loadingdone", fit);
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener("resize", fit);
      document.fonts?.removeEventListener("loadingdone", fit);
    };
  }, [visible]);
  return <div ref={label} className={className} role={name ? "heading" : undefined} aria-level={name ? 3 : undefined} title={name ? name + suffix : undefined} aria-label={name ? name + suffix : undefined}>
    {visible && <span className="vn-name-text">{visible}</span>}
  </div>;
}
