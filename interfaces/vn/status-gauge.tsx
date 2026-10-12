import { statusText } from "./status-data";

// Centered arcs share one coordinate system. A full circle needs two SVG arcs.
export function StatusGauge({ field, range, ring = false, level, glow = 0 }) {
  const shape = ring ? "full" : field.gaugeShape;
  const arc = shape === "full" ? "M 60 12 A 48 48 0 1 1 60 108 A 48 48 0 1 1 60 12"
    : shape === "quarter" ? "M 26.06 26.06 A 48 48 0 0 1 93.94 26.06"
    : "M 12 60 A 48 48 0 0 1 108 60";
  const valid = range.value !== null && range.max > range.min;
  return <div className="vn-status-gauge" data-shape={shape} data-level-up={glow > 0}>
    <div key={glow} className={glow > 0 ? "vn-status-gauge-face vn-status-level-up" : "vn-status-gauge-face"}>
      <svg viewBox={shape === "full" ? "0 0 120 120" : "0 0 120 78"} role={valid ? "meter" : "img"} aria-label={valid ? field.label : `${field.label}: ${statusText(range.value)}`} aria-valuemin={valid ? range.min : undefined} aria-valuemax={valid ? range.max : undefined} aria-valuenow={valid ? Math.max(range.min, Math.min(range.max, range.value)) : undefined}>
        <path className="vn-status-gauge-track" d={arc} />
        <path className="vn-status-gauge-fill" d={arc} pathLength="100" strokeDasharray="100" style={{ strokeDashoffset: 100 - range.percent, opacity: range.percent > 0 ? 1 : 0 }} />
      </svg>
      <span className="vn-status-gauge-icon" aria-hidden="true">{field.icon || "✦"}</span>
    </div>
    <div className="vn-status-gauge-value">{statusText(range.value)}<small> / {range.max}</small></div>
    {ring && level !== undefined && <div className="vn-status-level">Level {statusText(level)}</div>}
  </div>;
}

export const gaugeStyles = `
.vn-status-field[data-format=gauge],.vn-status-field[data-format=xp-ring],.vn-status-field[data-format=pips]{grid-column:auto}
.vn-status-gauge{text-align:center;min-width:0}
.vn-status-gauge-face{position:relative;width:min(100%,150px);margin:0 auto}
.vn-status-gauge svg{display:block;width:100%;overflow:visible;fill:none;stroke-width:7;stroke-linecap:round}
.vn-status-gauge-track{stroke:#b69a692b}
.vn-status-gauge-fill{stroke:var(--field-color);transition:stroke-dashoffset .5s ease,opacity .2s ease}
.vn-status-gauge-icon{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:25px;line-height:1;color:var(--field-color)}
.vn-status-gauge[data-shape=half] .vn-status-gauge-icon{top:65%}
.vn-status-gauge[data-shape=quarter] .vn-status-gauge-icon{top:65%}
.vn-status-gauge-value{margin-top:5px;font-size:22px;color:#f0e5ce;font-variant-numeric:tabular-nums}
.vn-status-gauge-value small,.vn-status-level{font-size:12px;color:#bfb097}
.vn-status-level-up{animation:vn-status-level-glow .9s ease-out}
@keyframes vn-status-level-glow{35%{filter:drop-shadow(0 0 7px var(--field-color))}100%{filter:none}}
`;
