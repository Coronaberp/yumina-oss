import { VN_TEXT_FONTS, normalizeVnText, resolveVnText, vnTextCss } from "./text-style";
import { vnTextDefaults } from "./text-defaults";
import { vnMenuLayout } from "./menu-layout";

export function VnTextStyle({ api }) {
  return <style>{vnTextCss(vnTextDefaults, api.vnTextPreferences) + textSettingsCss + vnMenuLayout}</style>;
}

export function VnTextSettings({ api, onResetLegacy }) {
  const [value, setValue] = React.useState(() => normalizeVnText(api.vnTextPreferences));
  const [status, setStatus] = React.useState("");
  const [error, setError] = React.useState("");
  const pending = React.useRef(0);
  const latest = React.useRef(value);
  const revision = React.useRef(0);
  const signature = JSON.stringify(api.vnTextPreferences);
  React.useEffect(() => {
    if (!pending.current) { const next = normalizeVnText(api.vnTextPreferences); latest.current = next; setValue(next); }
  }, [signature]);
  const effective = resolveVnText(vnTextDefaults, value);
  async function save(next) {
    latest.current = next; setValue(next); setError(""); setStatus("Saving…");
    const id = ++revision.current;
    pending.current++;
    try {
      if (!api.setVnTextPreferences) throw new Error("Personal VN settings require the updated player.");
      await api.setVnTextPreferences(next);
      if (id === revision.current) { onResetLegacy(); setStatus("Saved to your account"); }
    } catch (failure) {
      if (id === revision.current) { setError(failure.message || "Could not save your VN settings."); setStatus(""); }
    } finally { pending.current--; }
  }
  function update(kind, field, nextValue) {
    const next = { ...latest.current, [kind]: { ...latest.current[kind] } };
    if (nextValue === "" || nextValue === undefined) delete next[kind][field];
    else next[kind][field] = nextValue;
    void save(normalizeVnText(next));
  }
  return <div className="vn-text-settings">
    <h2>Reading appearance</h2>
    <p>Personal settings apply to all your VN cards. Leave a field on card default to use the creator’s choice.</p>
    {(["dialogue", "narration"]).map(kind => <fieldset key={kind}>
      <legend>{kind === "dialogue" ? "Messages" : "Narration"}</legend>
      <label>Font<select aria-label={`${kind === "dialogue" ? "Messages" : "Narration"} font`} value={value[kind].font || ""} onChange={e => update(kind, "font", e.target.value)}>
        <option value="">Use card default</option>{VN_TEXT_FONTS.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}
      </select></label>
      <label>Size<select aria-label={`${kind === "dialogue" ? "Messages" : "Narration"} size`} value={value[kind].size || ""} onChange={e => update(kind, "size", e.target.value ? Number(e.target.value) : "")}>
        <option value="">Use card default</option>{Array.from({ length: 43 }, (_, index) => index + 14).map(size => <option key={size} value={size}>{size} px</option>)}
      </select></label>
      <div className="vn-text-color-row"><label>Color<input aria-label={`${kind === "dialogue" ? "Messages" : "Narration"} color`} type="color" value={effective[kind].color || "#e9e0cd"} onChange={e => update(kind, "color", e.target.value)} /></label>
        <button type="button" className="vn-text-reset" disabled={!value[kind].color} onClick={() => update(kind, "color", "")}>{value[kind].color ? "Use card default" : "Card default"}</button>
      </div>
      <p className="vn-text-sample" style={{ fontFamily: VN_TEXT_FONTS.find(font => font.id === effective[kind].font)?.family, fontSize: effective[kind].size ? `${effective[kind].size}px` : "20px", color: effective[kind].color, fontStyle: kind === "narration" ? "italic" : undefined }}>{kind === "dialogue" ? "We have a story to tell." : "The evening light fills the room."}</p>
    </fieldset>)}
    <button type="button" className="vn-text-reset" onClick={() => void save(normalizeVnText({}))}>Reset to card defaults</button>
    {status && <p role="status">{status}</p>}
    {error && <div role="alert"><p>{error}</p><button className="vn-text-reset" onClick={() => void save(latest.current)}>Retry saving</button></div>}
  </div>;
}

const textSettingsCss = `
.vn .vn-text-settings{margin:12px 0 28px;min-width:0}
.vn .vn-text-settings h2{font:inherit;font-size:22px;color:var(--gold);margin:0 0 10px}
.vn .vn-text-settings p{font-size:15px;line-height:1.5;margin:8px 0 16px;color:var(--cream);opacity:.8}
.vn .vn-text-settings fieldset{min-width:0;border:1px solid var(--line,#b69a694d);border-radius:8px;padding:16px;margin:16px 0}
.vn .vn-text-settings legend{padding:0 8px;color:var(--gold);font-size:20px}
.vn .vn-text-settings label{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:17px;margin:0 0 14px}
.vn .vn-text-settings select{min-width:0;max-width:72%;border:1px solid var(--line,#b69a694d);background:#2c2419;color:var(--cream);border-radius:6px;padding:10px;font:inherit}
.vn .vn-text-settings .vn-text-color-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.vn .vn-text-settings .vn-text-color-row label{flex:1;margin:0}
.vn .vn-text-settings input[type=color]{width:54px;height:40px;border:1px solid var(--line,#b69a694d);background:transparent;padding:3px;border-radius:6px;cursor:pointer}
.vn .vn-text-settings .vn-text-reset{width:auto;padding:8px 12px;border:1px solid var(--line,#b69a694d);border-radius:6px;font-size:15px;color:var(--gold);background:transparent}
.vn .vn-text-settings .vn-text-reset:disabled{opacity:.55;cursor:default}
.vn .vn-text-settings p.vn-text-sample{opacity:1;margin:18px 0 0;overflow-wrap:anywhere}
`;
