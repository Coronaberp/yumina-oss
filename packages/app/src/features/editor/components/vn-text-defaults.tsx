import { ColorPicker } from "@/components/ui/color-picker";
import { VN_TEXT_DEFAULTS_FILE, VN_TEXT_FONTS, readVnTextDefaults, writeVnTextDefaults, type VnTextStyle } from "@yumina/shared";
import { useEditorStore } from "@/stores/editor";
import { Select } from "@/components/ui/select";
import { withVnTextSettings } from "../lib/vn-text-template";

export function VnTextDefaults() {
  const root = useEditorStore(state => state.worldDraft.rootComponent);
  const locked = useEditorStore(state => state.readOnlyInspect || state.guestMode);
  let values;
  try { values = readVnTextDefaults(root?.files[VN_TEXT_DEFAULTS_FILE]); }
  catch (error) { return <p role="status" className="text-sm text-muted-foreground">{(error as Error).message}</p>; }
  function update(kind: "dialogue" | "narration", field?: keyof VnTextStyle, value?: string | number) {
    const store = useEditorStore.getState(), current = store.worldDraft.rootComponent;
    if (!current || store.guestMode || store.readOnlyInspect) return;
    const next = readVnTextDefaults(current.files[VN_TEXT_DEFAULTS_FILE]);
    if (!field) next[kind] = {};
    else if (value === "" || value === undefined) delete next[kind][field];
    else Object.assign(next[kind], { [field]: value });
    store.updateRootComponent({ files: { ...withVnTextSettings(current.files), [VN_TEXT_DEFAULTS_FILE]: writeVnTextDefaults(next) } });
  }
  return <section className="space-y-4 border-t border-border pt-5" data-vn-text-defaults>
    <div><h3 className="text-base font-medium">VN reading defaults</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Set how messages and narration look for readers. These defaults are saved with this card. Readers can override them in VN Menu → Settings.</p></div>
    <div className="grid gap-4 sm:grid-cols-2">
      {(["dialogue", "narration"] as const).map(kind => {
        const title = kind === "dialogue" ? "Messages" : "Narration", style = values[kind];
        return <fieldset key={kind} disabled={locked} className="min-w-0 space-y-4 rounded-xl border border-border p-4">
          <legend className="px-2 text-sm font-medium">{title}</legend>
          <div className="space-y-2"><label className="text-xs" id={`vn-${kind}-font-label`}>Font</label><Select aria-label={`${title} default font`} disabled={locked} value={style.font ?? ""} onValueChange={value => update(kind, "font", value)} options={[{ value: "", label: "Layout default" }, ...VN_TEXT_FONTS.map(font => ({ value: font.id, label: font.label }))]} /></div>
          <div className="space-y-2"><label className="text-xs" id={`vn-${kind}-size-label`}>Size</label><Select aria-label={`${title} default size`} disabled={locked} value={style.size ? String(style.size) : ""} onValueChange={value => update(kind, "size", value ? Number(value) : "")} options={[{ value: "", label: "Layout default" }, ...Array.from({ length: 43 }, (_, index) => ({ value: String(index + 14), label: `${index + 14} px` }))]} /></div>
          <div className="flex flex-wrap items-center gap-3"><label className="flex items-center gap-3 text-xs">Color<ColorPicker disabled={locked} aria-label={`${title} default color`}  value={style.color ?? "#e9e0cd"} onValueChange={color => update(kind, "color", color)} className="h-10 w-14 cursor-pointer rounded border border-border bg-card p-1" /></label><button disabled={locked || !style.color} type="button" onClick={() => update(kind, "color", "")} className="text-xs text-primary disabled:text-muted-foreground">{style.color ? "Use layout default" : "Layout default"}</button></div>
          <p className="break-words rounded-lg bg-muted/30 p-3 leading-relaxed" style={{ fontFamily: VN_TEXT_FONTS.find(font => font.id === style.font)?.family, fontSize: style.size ?? 20, color: style.color, fontStyle: kind === "narration" ? "italic" : undefined }}>{kind === "dialogue" ? "We have a story to tell." : "The evening light fills the room."}</p>
          <button type="button" disabled={locked} onClick={() => update(kind)} className="text-xs text-primary">Reset {title.toLowerCase()}</button>
        </fieldset>;
      })}
    </div>
  </section>;
}
