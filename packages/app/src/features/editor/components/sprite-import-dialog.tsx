import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { spriteImportProblems, type SpriteImportItem } from "../lib/sprite-import";
function FilePreview({ file }: { file: File }) {
  const preview = useRef<HTMLImageElement>(null);
  useEffect(() => { const value = URL.createObjectURL(file); if (preview.current) preview.current.src = value; return () => URL.revokeObjectURL(value); }, [file]);
  return <img ref={preview} alt="" className="h-24 w-16 shrink-0 object-contain" />;
}
export function SpriteImportDialog({ rows, emotions, occupied, character, typeLabel, variantLabel, busy, blocked, onChange, onStart, onClose }: {
  rows: SpriteImportItem[]; emotions: Record<string, string>; occupied: ReadonlySet<string>; character: string; typeLabel: string; variantLabel?: string;
  busy: boolean; blocked: boolean; onChange: (id: string, patch: Partial<SpriteImportItem> | null) => void; onStart: () => void; onClose: () => void;
}) {
  const { t } = useTranslation("editor");
  const problems = spriteImportProblems(rows, emotions, occupied);
  const remaining = rows.filter(row => row.status !== "done").length;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto p-4 sm:p-6" onEscapeKeyDown={e => { if (busy) e.preventDefault(); }} onInteractOutside={e => { if (busy) e.preventDefault(); }}>
      <DialogHeader className="pr-6 text-left"><DialogTitle>{t("spriteManager.reviewTitle")}</DialogTitle><DialogDescription>{t("spriteManager.reviewHint", { character, type: [typeLabel, variantLabel].filter(Boolean).join(" / ") })}</DialogDescription></DialogHeader>
      {blocked && <p role="alert" className="text-sm text-destructive">{t("spriteManager.staleQueue")}</p>}
      <div className="space-y-3">{rows.map(row => <div key={row.id} className="flex min-w-0 gap-3 rounded-lg border border-border bg-card p-3">
        <FilePreview file={row.file} /><div className="min-w-0 flex-1 space-y-2">
          <p className="break-all text-xs text-muted-foreground">{row.file.name}</p>
          <Select aria-label={t("spriteManager.assignEmotion", { file: row.file.name })} value={row.emotion} disabled={busy || row.status === "done" || blocked} onValueChange={emotion => onChange(row.id, { emotion, replace: false })} className="min-h-11 w-full py-2" options={[{ value: "", label: t("spriteManager.selectEmotion") }, ...Object.entries(emotions).map(([value, label]) => ({ value, label }))]} />
          {row.status !== "done" && occupied.has(row.emotion) && <label className="flex min-h-11 items-center gap-2 text-xs text-foreground"><Checkbox checked={row.replace} disabled={busy || blocked} onCheckedChange={value => onChange(row.id, { replace: value === true })} />{t("spriteManager.replaceExisting")}</label>}
          {problems[row.id] && <p role="alert" className="text-xs text-destructive">{t(`spriteManager.problem${problems[row.id]}`)}</p>}
          {row.error && <p role="alert" className="break-words text-xs text-destructive">{row.error}</p>}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span role="status">{row.status === "uploading" ? t("visualNovel.uploading", { percent: row.progress }) : row.status === "done" ? t("spriteManager.assigned") : row.status === "error" ? t("spriteManager.retryReady") : t("spriteManager.ready")}</span>
            {row.status !== "done" && <button type="button" disabled={busy} onClick={() => onChange(row.id, null)} className="min-h-11 rounded-lg px-2 text-foreground underline disabled:opacity-40">{t("spriteManager.removeFromQueue")}</button>}
          </div>
        </div>
      </div>)}</div>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm text-foreground disabled:opacity-40">{t(remaining ? "spriteManager.closeReview" : "spriteManager.done")}</button>
        {!!remaining && <button type="button" disabled={busy || blocked || !!Object.keys(problems).length} onClick={onStart} className="min-h-11 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40">{t(busy ? "spriteManager.importing" : rows.some(row => row.status === "error") ? "spriteManager.retryRemaining" : "spriteManager.importCount", { count: remaining })}</button>}
      </div>
    </DialogContent>
  </Dialog>;
}
