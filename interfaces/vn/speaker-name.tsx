/** Abbreviate log labels only; canonical names still identify portraits and sprites. */
export function shortSpeakerName(name: string): string {
  const full = name.trim();
  const parenthesis = full.search(/[（(]/u);
  if (parenthesis >= 0) return full.slice(0, parenthesis).trim() || full;
  const characters = Array.from(full);
  return characters.length > 10 ? characters.slice(0, 10).join("") + "...." : full;
}

export function SpeakerName({ name = "", suffix = "", className, truncate = true }) {
  const label = React.useRef(null);
  const visible = (truncate ? shortSpeakerName(name) : name.trim()) + suffix;
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
