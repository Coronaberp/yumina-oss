import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { addVnSpriteVariant, renameVnSpriteVariant, removeVnSpriteVariant, addVnSpriteOption, renameVnSpriteOption, removeVnSpriteOption, VN_SPRITE_EMOTION_LIMIT, VN_SPRITE_EMOTION_WARNING, VN_SPRITE_DEFAULT_EMOTIONS, type VnSpriteConfig } from "../lib/vn-assets";
const inputClass = "min-h-11 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";
const buttonClass = "min-h-11 rounded-lg border border-border px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";
const builtins = new Set(Object.keys(VN_SPRITE_DEFAULT_EMOTIONS));
export function SpriteCatalogDialog({ config, variants, variantUsage, usage, disabled, error, onWrite, onClose }: {
  config: VnSpriteConfig;
  variants: Record<string, Record<string, string>>;
  variantUsage: (type: string, id: string) => number;
  usage: (kind: "types" | "emotions", id: string) => number;
  disabled: boolean;
  error: string;
  onWrite: (change: (source: string) => string) => boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("editor");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [names, setNames] = useState({ types: "", emotions: "" });
  const [variantType, setVariantType] = useState("normal");
  const type = Object.hasOwn(config.types, variantType) ? variantType : "normal";
  const [variantName, setVariantName] = useState("");
  const [removeVariant, setRemoveVariant] = useState<string | null>(null);
  const [remove, setRemove] = useState<{ kind: "types" | "emotions"; id: string } | null>(null);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto p-4 sm:p-6">
      <DialogHeader className="pr-5 text-left"><DialogTitle>{t("spriteManager.manage")}</DialogTitle><DialogDescription>{t("spriteManager.catalogHint")}</DialogDescription></DialogHeader>
      {(["types", "emotions"] as const).map(kind => <section key={kind} className="min-w-0 space-y-3">
        <div><h3 className="text-sm font-semibold text-foreground">{t(`spriteManager.${kind}`)} <span className="font-normal text-muted-foreground">{Object.keys(config[kind]).length}{kind === "emotions" ? ` / ${VN_SPRITE_EMOTION_LIMIT}` : ""}</span></h3><p className="mt-1 text-xs text-muted-foreground">{t(`spriteManager.${kind}Limit`)}</p></div>
        {kind === "emotions" && Object.keys(config.emotions).length >= VN_SPRITE_EMOTION_WARNING && <p role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-foreground">{t("spriteManager.emotionWarning")}</p>}
        <div className="divide-y divide-border rounded-lg border border-border">
          {Object.entries(config[kind]).map(([id, label]) => {
            const protectedOption = kind === "types" ? id === "normal" : builtins.has(id);
            const key = `${kind}:${id}`;
            return <div key={id} className="space-y-2 p-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {protectedOption ? <span className="min-w-0 flex-1 break-words text-sm text-foreground">{label}</span> : <input aria-label={t("spriteManager.optionLabel", { label })} value={labels[key] ?? label} maxLength={60} disabled={disabled} onChange={e => setLabels(previous => ({ ...previous, [key]: e.target.value }))} className={`${inputClass} w-32 flex-1`} />}
                <span className="text-xs text-muted-foreground">{t("spriteManager.assignments", { count: usage(kind, id) })}</span>
                {protectedOption ? <span className="text-xs text-muted-foreground">{t("spriteManager.builtin")}</span> : <>
                  <button type="button" disabled={disabled || !(labels[key] ?? label).trim() || (labels[key] ?? label) === label} onClick={() => onWrite(source => renameVnSpriteOption(source, kind, id, labels[key]))} className={buttonClass}>{t("spriteManager.rename")}</button>
                  <button type="button" disabled={disabled} onClick={() => setRemove({ kind, id })} className={`${buttonClass} text-destructive`}>{t("spriteManager.remove")}</button>
                </>}
              </div>
              <p className="break-all text-xs text-muted-foreground">{t("spriteManager.tagId", { id })}</p>
              {remove?.kind === kind && remove.id === id && <div className="space-y-2 rounded-lg bg-background p-3">
                <p className="text-sm text-foreground">{t("spriteManager.confirmRemove", { label, count: usage(kind, id) })}</p>
                <div className="flex flex-wrap gap-2"><button type="button" disabled={disabled} onClick={() => { if (onWrite(source => removeVnSpriteOption(source, kind, id))) setRemove(null); }} className={`${buttonClass} text-destructive`}>{t("spriteManager.removeAssignments")}</button><button type="button" onClick={() => setRemove(null)} className={buttonClass}>{t("spriteManager.cancel")}</button></div>
              </div>}
            </div>;
          })}
        </div>
        <form className="flex min-w-0 gap-2" onSubmit={e => { e.preventDefault(); if (onWrite(source => addVnSpriteOption(source, kind, names[kind]))) setNames(previous => ({ ...previous, [kind]: "" })); }}>
          <input aria-label={t(`spriteManager.new${kind === "types" ? "Type" : "Emotion"}`)} placeholder={t(`spriteManager.new${kind === "types" ? "Type" : "Emotion"}`)} disabled={disabled || (kind === "emotions" && Object.keys(config.emotions).length >= VN_SPRITE_EMOTION_LIMIT)} maxLength={60} value={names[kind]} onChange={e => setNames(previous => ({ ...previous, [kind]: e.target.value }))} className={`${inputClass} w-0 flex-1`} />
          <button type="submit" disabled={disabled || !names[kind].trim() || (kind === "emotions" && Object.keys(config.emotions).length >= VN_SPRITE_EMOTION_LIMIT)} className={buttonClass}>{t("spriteManager.add")}</button>
        </form>
      </section>)}
      <section className="min-w-0 space-y-3 rounded-xl border border-border p-3">
        <h3 className="text-sm font-semibold text-foreground">{t("spriteManager.variants")}</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("spriteManager.variantHint")}</p>
        <Select aria-label={t("spriteManager.variantType")} value={type} disabled={disabled} options={Object.entries(config.types).map(([value, label]) => ({ value, label }))} onValueChange={value => { setVariantType(value); setRemoveVariant(null); }} />
        {Object.entries(variants[type] ?? {}).map(([id, label]) => {
          const key = `variant:${type}:${id}`;
          return <div key={key} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <input aria-label={t("spriteManager.variantName", { label })} value={labels[key] ?? label} maxLength={60} disabled={disabled} onChange={event => setLabels(previous => ({ ...previous, [key]: event.target.value }))} className={`${inputClass} w-32 flex-1`} />
              <span className="text-xs text-muted-foreground">{t("spriteManager.assignments", { count: variantUsage(type, id) })}</span>
              <button type="button" disabled={disabled || !(labels[key] ?? label).trim() || (labels[key] ?? label) === label} onClick={() => onWrite(source => renameVnSpriteVariant(source, type, id, labels[key]))} className={buttonClass}>{t("spriteManager.rename")}</button>
              <button type="button" disabled={disabled} onClick={() => setRemoveVariant(id)} className={`${buttonClass} text-destructive`}>{t("spriteManager.remove")}</button>
            </div>
            <p className="break-all text-xs text-muted-foreground">{t("spriteManager.tagId", { id })}</p>
            {removeVariant === id && <div className="space-y-2 rounded-lg bg-background p-3"><p className="text-sm text-foreground">{t("spriteManager.removeVariantHint")}</p><div className="flex flex-wrap gap-2"><button type="button" disabled={disabled} onClick={() => { if (onWrite(source => removeVnSpriteVariant(source, type, id))) setRemoveVariant(null); }} className={`${buttonClass} text-destructive`}>{t("spriteManager.removeAssignments")}</button><button type="button" onClick={() => setRemoveVariant(null)} className={buttonClass}>{t("spriteManager.cancel")}</button></div></div>}
          </div>;
        })}
        <form className="flex min-w-0 gap-2" onSubmit={event => { event.preventDefault(); if (onWrite(source => addVnSpriteVariant(source, type, variantName))) setVariantName(""); }}>
          <input aria-label={t("spriteManager.newVariant")} placeholder={t("spriteManager.newVariant")} disabled={disabled} maxLength={60} value={variantName} onChange={event => setVariantName(event.target.value)} className={`${inputClass} w-0 flex-1`} />
          <button type="submit" disabled={disabled || !variantName.trim()} className={buttonClass}>{t("spriteManager.add")}</button>
        </form>
      </section>
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <button type="button" onClick={onClose} className={buttonClass}>{t("spriteManager.done")}</button>
    </DialogContent>
  </Dialog>;
}
