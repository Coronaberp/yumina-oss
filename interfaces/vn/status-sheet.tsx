import { statusConfig } from "./status-config";
import StatusLayout from "./status-layout";

// Sheet sizing belongs here; authored layouts supply their own content styles.
const sheetStyles = `
.vn .vn-status-tabs{min-width:0;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden}
.vn .vn-status-tabs button{width:auto!important;flex:0 0 auto!important;min-width:0;white-space:nowrap;overflow-wrap:normal}
.vn-drawer.vn-status-drawer{overflow:hidden;padding-bottom:24px}
.vn-status-drawer .vn-menu-title{margin-bottom:10px}
.vn-status-drawer .vn-subpanel{position:relative;margin-top:18px;overscroll-behavior:contain}
.vn-status-edge{position:absolute;z-index:2;pointer-events:none;backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);background:#261f1918;transition:opacity .12s ease}
.vn-status-edge-left{mask-image:linear-gradient(to right,#000,transparent);-webkit-mask-image:linear-gradient(to right,#000,transparent)}
.vn-status-edge-right{mask-image:linear-gradient(to left,#000,transparent);-webkit-mask-image:linear-gradient(to left,#000,transparent)}
@media(prefers-reduced-motion:reduce){.vn-status-edge{transition:none}}
@media(max-width:600px) and (orientation:portrait){.vn-drawer.vn-status-drawer{padding-top:76px}.vn-status-drawer .vn-menu-close{top:16px}}
@media(max-height:600px) and (orientation:landscape){.vn-drawer.vn-status-drawer{padding-top:60px}.vn-status-drawer .vn-menu-close{top:8px}.vn-status-drawer .vn-back{margin-top:6px!important}.vn-status-drawer .vn-subpanel{margin-top:8px}}
`;

export function StatusSheet({ api, onClose, onBack, preview = false }) {
  const content = React.useRef(null);
  const [edges, setEdges] = React.useState(null);
  React.useEffect(() => {
    const panel = content.current;
    if (!panel) return;
    let frame = 0, observed = null;
    const requestFrame = window.requestAnimationFrame?.bind(window) || (callback => window.setTimeout(callback, 16));
    const cancelFrame = window.cancelAnimationFrame?.bind(window) || window.clearTimeout.bind(window);
    const observer = window.ResizeObserver ? new window.ResizeObserver(schedule) : null;
    function update() {
      frame = 0;
      const tabs = panel.querySelector('.vn-status-tabs');
      if (tabs !== observed) {
        if (observed) observer?.unobserve(observed);
        if (tabs) observer?.observe(tabs);
        observed = tabs;
      }
      if (!tabs) { setEdges(null); return; }
      const bounds = tabs.getBoundingClientRect(), parent = panel.getBoundingClientRect();
      const width = Math.min(24, tabs.clientWidth / 2);
      const next = { left: bounds.left - parent.left + panel.scrollLeft, top: bounds.top - parent.top + panel.scrollTop,
        right: bounds.left - parent.left + panel.scrollLeft + tabs.clientWidth - width, width, height: bounds.height,
        before: tabs.scrollLeft > 1, after: tabs.scrollWidth - tabs.clientWidth - tabs.scrollLeft > 1 };
      setEdges(previous => previous && Object.keys(next).every(key => next[key] === previous[key]) ? previous : next);
    }
    function schedule() { if (!frame) frame = requestFrame(update); }
    const changes = new window.MutationObserver(schedule);
    changes.observe(panel, { childList: true, subtree: true });
    observer?.observe(panel);
    panel.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    schedule();
    return () => { cancelFrame(frame); changes.disconnect(); observer?.disconnect(); panel.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); };
  }, []);
  return <section className="vn-overlay" role="dialog" aria-modal="true" aria-label="Player status">
    <style>{sheetStyles}</style>
    <button className="vn-menu-shade" onClick={onClose} aria-label="Close status from backdrop" />
    <aside className="vn-drawer vn-status-drawer">
      <button className="vn-close vn-menu-close" aria-label="Close status" onClick={onClose}>Close<Icons.X /></button>
      <div className="vn-brand">{api.worldName}</div>
      <h1 className="vn-menu-title">{statusConfig.title}</h1>
      <button className="vn-back" onClick={onBack}><Icons.ArrowLeft size={20} />Back</button>
      <div className="vn-subpanel" ref={content}>
        <StatusLayout config={statusConfig} variables={api.variables} preview={preview} />
        {edges && <>
          <span aria-hidden="true" className="vn-status-edge vn-status-edge-left" style={{ left: edges.left, top: edges.top, width: edges.width, height: edges.height, opacity: edges.before ? 1 : 0 }} />
          <span aria-hidden="true" className="vn-status-edge vn-status-edge-right" style={{ left: edges.right, top: edges.top, width: edges.width, height: edges.height, opacity: edges.after ? 1 : 0 }} />
        </>}
      </div>
    </aside>
  </section>;
}
