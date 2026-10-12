import { statusItems, statusPips, statusRange, statusText, statusValue } from "./status-data";
import { StatusGauge } from "./status-gauge";

function useChange(value, increaseOnly = false) {
  const previous = React.useRef(value);
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    if (!Object.is(previous.current, value) && (!increaseOnly || typeof value === "number" && typeof previous.current === "number" && value > previous.current)) setRevision(revision => revision + 1);
    previous.current = value;
  }, [value, increaseOnly]);
  return revision;
}

function StatusItem({ item, inventory, chips }) {
  const revision = useChange(item.quantity);
  return <span className={`vn-status-item${inventory ? " vn-status-slot" : ""}${chips && item.expiring ? " vn-status-expiring" : ""}`} data-expiring={chips ? !!item.expiring : undefined}>
    {item.icon && <span className="vn-status-item-icon" aria-hidden="true">{item.icon}</span>}
    <span>{item.name}</span>{item.quantity !== undefined && <small key={revision} className={revision ? "vn-status-count-change" : ""}>×{item.quantity}</small>}
    {chips && item.expiring && <span className="vn-status-expiry" aria-label="Expires soon"> · ending soon</span>}
  </span>;
}

function SceneBadge({ field, value }) {
  const text = statusText(value);
  const automatic = /storm|thunder/i.test(text) ? "⛈" : /rain|drizzle/i.test(text) ? "☂" : /snow|winter/i.test(text) ? "❄" : /cloud|overcast/i.test(text) ? "☁" : /night|moon|midnight/i.test(text) ? "☾" : /dawn|dusk|sunset|sunrise/i.test(text) ? "◒" : /day|sun|morning|noon|clear/i.test(text) ? "☀" : field.icon || "✦";
  const icon = field.sceneIcon === "field" ? field.icon || "✦" : automatic;
  const previous = React.useRef(icon);
  const [oldIcon, setOldIcon] = React.useState(null);
  const revision = useChange(text);
  React.useEffect(() => {
    if (previous.current === icon) return;
    setOldIcon(previous.current); previous.current = icon;
    const timer = setTimeout(() => setOldIcon(null), 350);
    return () => clearTimeout(timer);
  }, [icon]);
  return <div className="vn-status-scene"><span className="vn-status-scene-icons" aria-hidden="true">
    {oldIcon && <span key={`old-${oldIcon}`} className="vn-status-scene-old">{oldIcon}</span>}
    <span key={icon} className="vn-status-scene-icon">{icon}</span>
  </span><span key={revision} className={revision ? "vn-status-changed" : ""}>{text}</span></div>;
}

export function StatusWidget({ field, variables }) {
  const value = statusValue(variables, field.variableId, field.path);
  const range = statusRange(field, variables);
  const level = field.levelVariableId ? statusValue(variables, field.levelVariableId, field.levelPath) : undefined;
  const levelUp = useChange(level, true);
  const revision = useChange(statusText(value));
  if (field.format === "gauge" || field.format === "xp-ring") return <StatusGauge field={field} range={range} ring={field.format === "xp-ring"} level={level} glow={levelUp} />;
  if (field.format === "bar" || field.format === "resource") {
    const valid = range.value !== null && range.max > range.min;
    return <div className="vn-status-meter" role={valid ? "meter" : undefined} aria-label={field.label} aria-valuemin={valid ? range.min : undefined} aria-valuemax={valid ? range.max : undefined} aria-valuenow={valid ? Math.max(range.min, Math.min(range.max, range.value)) : undefined}>
      {field.format === "resource" && <div className="vn-status-trail" style={{ width: `${range.percent}%` }} />}
      <div className="vn-status-fill" style={{ width: `${range.percent}%` }} /><span>{statusText(range.value)} / {range.max}</span>
    </div>;
  }
  if (field.format === "segments" || field.format === "pips") {
    const pips = statusPips(range, field.pipCount);
    if (field.format === "pips" && pips.signed) {
      const icon = field.pipShape === "star" ? "★" : field.pipShape === "diamond" ? "◆" : "♥";
      return <div className="vn-status-pips vn-status-signed-pips" aria-label={`${field.label}: ${statusText(range.value)} / ${range.max}`}>
        <span className="vn-status-pips-meter" data-negative={pips.negative}>{Array.from({ length: pips.count }, (_, index) => <i key={index} data-filled={index < pips.filled} aria-hidden="true">{icon}</i>)}</span>
        <span className="vn-status-pips-value">{statusText(range.value)} · {range.value === null ? "Unknown" : range.value < 0 ? "Hostile" : range.value > 0 ? "Close" : "Neutral"}</span>
      </div>;
    }
    const count = field.format === "pips" ? field.pipCount : 10;
    const filled = Math.round(range.percent / 100 * count);
    return <div className={field.format === "pips" ? "vn-status-pips" : "vn-status-scale"} aria-label={`${field.label}: ${statusText(range.value)} / ${range.max}`}>
      {Array.from({ length: count }, (_, index) => <span className="vn-status-pip-wrap" key={index}><i key={index < filled ? "filled" : "empty"} data-filled={index < filled} aria-hidden="true">{field.format === "pips" ? field.pipShape === "star" ? "★" : field.pipShape === "diamond" ? "◆" : "♥" : ""}</i></span>)}
      {field.format === "pips" && <span className="vn-status-pips-value">{statusText(range.value)} / {range.max}</span>}
    </div>;
  }
  if (["badges", "inventory", "chips"].includes(field.format)) {
    const items = statusItems(value);
    const counts = new Map();
    return <div className="vn-status-items">{items.map(item => {
      const occurrence = counts.get(item.name) || 0; counts.set(item.name, occurrence + 1);
      return <StatusItem key={`${item.name}-${occurrence}`} item={item} inventory={field.format === "inventory"} chips={field.format === "chips"} />;
    })}{!items.length && <span className="vn-status-empty">{value === undefined ? "—" : "None"}</span>}</div>;
  }
  if (field.format === "scene") return <SceneBadge field={field} value={value} />;
  return <div key={revision} className={`vn-status-value${revision ? " vn-status-changed" : ""}`}>{statusText(value)}</div>;
}

export const widgetStyles = `
.vn-status-pips-meter{display:flex;gap:4px;min-width:0;max-width:100%}
.vn-status-signed-pips .vn-status-pips-meter i{font-style:normal;font-size:clamp(12px,3vw,20px);color:#b69a6955;transition:color .3s ease}
.vn-status-signed-pips .vn-status-pips-meter[data-negative=true] i[data-filled=true]{color:#15100d;text-shadow:0 0 1px #c8b17e,0 0 2px #c8b17e}
.vn-status-signed-pips .vn-status-pips-meter[data-negative=false] i[data-filled=true]{color:var(--field-color)}
.vn-status-fill{position:relative;transition:width .28s ease}
.vn-status-trail{position:absolute;inset:0 auto 0 0;background:var(--field-color);opacity:.35;transition:width .75s .18s ease}
.vn-status-pip-wrap{flex:1;min-width:0}
.vn-status-scale i{display:block;transition:background-color .3s ease}
.vn-status-scale i[data-filled=true]{animation:vn-status-pip-in .35s ease-out}
.vn-status-pips{display:flex;flex-wrap:wrap;gap:5px;color:#b69a6955;align-items:center}
.vn-status-pips .vn-status-pip-wrap{flex:0 0 auto}
.vn-status-pips i{display:block;font-style:normal;font-size:22px;line-height:1.2;transition:color .3s ease}
.vn-status-pips i[data-filled=true]{color:var(--field-color);animation:vn-status-pip-in .35s ease-out}
.vn-status-pips-value{flex-basis:100%;font-size:12px;color:#bfb097;margin-top:4px}
.vn-status-item{animation:vn-status-item-in .3s ease-out}
.vn-status-slot{position:relative;animation:vn-status-slot-in .65s ease-out}
.vn-status-slot small{display:inline-block}
.vn-status-item-icon{display:inline-block;color:var(--field-color);margin-right:7px}
.vn-status-expiring{border-color:var(--field-color);animation:vn-status-expiring .7s ease-out}
.vn-status-expiry{color:#bfb097;font-size:11px}
.vn-status-count-change{animation:vn-status-count-lift .35s ease-out}
.vn-status-changed{animation:vn-status-value-in .3s ease-out}
.vn-status-scene{display:flex;align-items:center;gap:12px;border:1px solid #b69a694d;border-radius:6px;padding:12px 14px;background:#b69a6912}
.vn-status-scene-icons{position:relative;display:grid;place-items:center;width:34px;min-width:34px;height:34px;font-size:28px;color:var(--field-color)}
.vn-status-scene-icon{animation:vn-status-item-in .35s ease-out}
.vn-status-scene-old{position:absolute;animation:vn-status-icon-out .35s ease-out forwards}
@keyframes vn-status-pip-in{0%{opacity:.5;transform:scale(.88)}100%{opacity:1;transform:scale(1)}}
@keyframes vn-status-item-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes vn-status-slot-in{0%{box-shadow:inset 0 0 0 1px var(--field-color);background:#b69a692e}100%{box-shadow:inset 0 0 0 1px transparent}}
@keyframes vn-status-expiring{40%{box-shadow:0 0 0 3px #b69a6924}100%{box-shadow:0 0 0 0 transparent}}
@keyframes vn-status-count-lift{40%{transform:translateY(-3px);color:#f0e5ce}100%{transform:none}}
@keyframes vn-status-value-in{from{opacity:.55;transform:translateY(2px)}to{opacity:1;transform:none}}
@keyframes vn-status-icon-out{to{opacity:0}}
@media(prefers-reduced-motion:reduce){.vn-status-view *,.vn-status-view *::before,.vn-status-view *::after{animation:none!important;transition:none!important}.vn-status-scene-old{display:none}}
`;
