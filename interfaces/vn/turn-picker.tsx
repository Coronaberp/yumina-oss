/** The VN runtime supplies React. Keep the popup inside the themed log. */
export function TurnPicker({ value, onChange, replies, currentTurnId, pending }) {
  const [open, setOpen] = React.useState(false);
  const root = React.useRef(null);
  const trigger = React.useRef(null);
  const id = React.useId();
  const options = [{ value: "", label: "All turns" }, ...replies.map((message, index) => ({ value: message.id, label: `Turn ${index + 1}${message.id === currentTurnId ? " (current)" : ""}` })), ...(pending ? [{ value: "pending", label: "Awaiting reply" }] : [])];
  const selected = Math.max(0, options.findIndex(option => option.value === value));
  React.useEffect(() => {
    if (!open) return;
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    const active = root.current?.querySelector('[role="option"][aria-selected="true"]');
    active?.focus(); active?.scrollIntoView?.({ block: "nearest" });
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const choose = next => { onChange(next); setOpen(false); trigger.current?.focus(); };
  return <div className="vn-turn-picker" ref={root} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <style>{`.vn-turn-picker{position:relative;min-width:150px;max-width:100%;font:inherit}.vn-turn-trigger{display:flex;align-items:center;justify-content:space-between;gap:18px;min-height:44px;width:100%;padding:8px 12px!important;border:1px solid #b69a6966!important;border-radius:6px;background:#261f18!important;color:var(--cream)!important;text-align:left}.vn-turn-trigger:focus-visible,.vn-turn-option:focus-visible{outline:2px solid var(--gold);outline-offset:-3px}.vn-turn-chevron{font-size:14px;color:var(--gold);transform:rotate(0);transition:transform .12s}.vn-turn-trigger[aria-expanded=true] .vn-turn-chevron{transform:rotate(180deg)}.vn-turn-list{position:absolute;top:calc(100% + 6px);left:0;z-index:100;min-width:100%;width:max-content;max-width:calc(100vw - 48px);max-height:min(320px,45dvh);overflow-y:auto;overscroll-behavior:contain;padding:6px;background:#2a2118;border:1px solid #b69a6999;border-radius:8px;box-shadow:0 10px 28px #0008;scrollbar-width:thin;scrollbar-color:#b69a6966 #2a2118}.vn-turn-option{display:flex;align-items:center;justify-content:space-between;gap:18px;width:100%;min-height:44px;padding:10px 12px!important;border-radius:5px;text-align:left;font-size:14px!important;color:var(--cream)!important;background:transparent!important}.vn-turn-option:hover,.vn-turn-option:focus{background:#ccaa671c!important}.vn-turn-option[aria-selected=true]{color:#ffe9b7!important;background:#ccaa672b!important}.vn-turn-check{color:var(--gold)}@media(max-width:600px){.vn-turn-picker{min-width:140px}.vn-turn-list{max-height:40dvh}}`}</style>
    <button ref={trigger} type="button" className="vn-turn-trigger" aria-label="Filter by turn" aria-haspopup="listbox" aria-expanded={open} aria-controls={id} onClick={() => setOpen(current => !current)} onKeyDown={event => {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); setOpen(true); }
    }}><span>{options[selected].label}</span><span className="vn-turn-chevron" aria-hidden="true">⌄</span></button>
    {open && <div id={id} role="listbox" aria-label="Filter by turn" className="vn-turn-list" onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll('[role="option"]')];
      const index = buttons.indexOf(document.activeElement);
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus(); buttons[next]?.scrollIntoView?.({ block: "nearest" });
      }
    }}>{options.map(option => <button key={option.value} type="button" role="option" data-value={option.value} aria-selected={option.value === value} tabIndex={option.value === value ? 0 : -1} className="vn-turn-option" onClick={() => choose(option.value)}><span>{option.label}</span>{option.value === value && <span className="vn-turn-check" aria-hidden="true">✓</span>}</button>)}</div>}
  </div>;
}
