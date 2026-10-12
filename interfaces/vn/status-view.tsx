import { normalizeStatusConfig, statusRange, statusText } from "./status-data";
import { gaugeStyles } from "./status-gauge";
import { StatusWidget, widgetStyles } from "./status-widgets";

export const statusStyles = `
.vn-status-view{--status-accent:#c8b17e;color:#e8dfcd;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.5;min-width:0}
.vn-status-subtitle{margin:0 0 20px;color:var(--status-accent);font-size:14px}
.vn-status-tabs{display:flex;border-bottom:1px solid #b69a6940;gap:14px;margin-bottom:24px;overflow-x:auto;scrollbar-width:thin}
.vn-status-tabs button{min-height:44px;padding:8px 12px!important;background:transparent!important;cursor:pointer;border:0!important;border-bottom:2px solid transparent!important;font-size:16px!important;color:#bfb097!important;text-align:left}
.vn-status-tabs button[aria-selected=true]{border-bottom-color:var(--status-accent)!important;color:#e8dfcd!important}
.vn-status-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 18px}
.vn-status-field{grid-column:1/-1;min-width:0;overflow-wrap:anywhere}
.vn-status-field[data-format=segments]{grid-column:auto}
.vn-status-label{display:flex;align-items:center;gap:8px;font-size:16px;margin-bottom:7px}
.vn-status-label>span:first-child{color:var(--field-color)}
.vn-status-value{font-size:22px;color:#f0e5ce;overflow-wrap:anywhere;white-space:pre-wrap}
.vn-status-meter{height:27px;position:relative;overflow:hidden;border-radius:5px;background:#b69a6926}
.vn-status-fill{height:100%;background:var(--field-color);border-radius:5px}
.vn-status-meter>span{position:absolute;inset:0;display:grid;place-items:center;font-size:14px;color:#fff;text-shadow:0 1px 3px #000}
.vn-status-scale{display:flex;gap:4px;margin-top:8px}
.vn-status-scale i{height:5px;border-radius:2px;background:#b69a6940;flex:1}
.vn-status-scale i[data-filled=true]{background:var(--field-color)}
.vn-status-ratio{margin-left:auto;font-size:12px;color:#bfb097}
.vn-status-items{display:flex;flex-wrap:wrap;gap:8px}
.vn-status-item{border:1px solid #b69a694d;background:#b69a6912;border-radius:24px;padding:6px 12px;font-size:14px}
.vn-status-item small{margin-left:10px;color:var(--status-accent)}
.vn-status-field[data-format=inventory] .vn-status-items{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}
.vn-status-field[data-format=inventory] .vn-status-item{border-radius:5px;padding:14px 10px;min-width:0}
.vn-status-empty{color:#bfb097;font-size:14px;margin:0}
.vn-status-footer{border-top:1px solid #b69a6933;margin-top:24px;padding-top:14px;color:#bfb097;font-size:12px}
@media(max-width:360px){.vn-status-tabs{gap:8px}.vn-status-tabs button{font-size:14px!important}.vn-status-field[data-format=inventory] .vn-status-items{grid-template-columns:repeat(2,minmax(0,1fr))}}
`;

export function StatusView({ config, variables, preview = false }) {
  const settings = normalizeStatusConfig(config);
  const [tab, setTab] = React.useState("overview");
  const activeTab = settings.groups.some(group => group.id === tab) ? tab : settings.groups[0].id;
  const fields = settings.fields.filter(field => field.group === activeTab);
  return <div className="vn-status-view" style={{ "--status-accent": settings.accent }}>
    <style>{statusStyles + gaugeStyles + widgetStyles}</style>
    <p className="vn-status-subtitle">{settings.subtitle}</p>
    <div className="vn-status-tabs" role="tablist" aria-label="Status categories">
      {settings.groups.map((group, index) => <button key={group.id} type="button" id={`status-tab-${index}`} role="tab" aria-selected={activeTab === group.id} aria-controls="status-fields" tabIndex={activeTab === group.id ? 0 : -1} onClick={() => setTab(group.id)} onKeyDown={event => {
        const groups = settings.groups.map(group => group.id);
        const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (offset || event.key === "Home" || event.key === "End") {
          event.preventDefault();
          const next = event.key === "Home" ? groups[0] : event.key === "End" ? groups[groups.length - 1] : groups[(index + offset + groups.length) % groups.length];
          setTab(next); event.currentTarget.parentElement.querySelector(`#status-tab-${groups.indexOf(next)}`)?.focus();
        }
      }}>{group.label}</button>)}
    </div>
    <div className="vn-status-fields" id="status-fields" role="tabpanel" aria-labelledby={`status-tab-${settings.groups.findIndex(group => group.id === activeTab)}`}>
      {fields.map(field => {
        const range = statusRange(field, variables);
        return <div key={field.id} className="vn-status-field" data-format={field.format} style={{ "--field-color": field.color }}>
          <div className="vn-status-label"><span aria-hidden="true">{field.icon}</span><span>{field.label}</span>{field.format === "segments" && <span className="vn-status-ratio">{statusText(range.value)} / {range.max}</span>}</div>
          <StatusWidget field={field} variables={variables} />
        </div>;
      })}
      {!fields.length && <p className="vn-status-empty">No status fields in this category.</p>}
    </div>
    <p className="vn-status-footer">{preview ? "Preview · starting values" : "Read-only · latest confirmed state"}</p>
  </div>;
}
