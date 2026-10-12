import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import ReactCrop, { type PercentCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const fullImage: PercentCrop = { unit: "%", x: 0, y: 0, width: 100, height: 100 };

interface SpriteCropDialogProps {
  file: File;
  src: string;
  onCancel: () => void;
  onConfirm: (file: File) => void;
}

export function SpriteCropDialog({ file, src, onCancel, onConfirm }: SpriteCropDialogProps) {
  const { t } = useTranslation("editor");
  const { t: common } = useTranslation("common");
  const [crop, setCrop] = useState<PercentCrop>(fullImage);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const image = useRef<HTMLImageElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const confirm = async () => {
    const source = image.current;
    if (!loaded || busy || !source || crop.width <= 0 || crop.height <= 0) return;
    setBusy(true);
    setError("");
    try {
      const x = Math.min(source.naturalWidth - 1, Math.max(0, Math.round(crop.x * source.naturalWidth / 100)));
      const y = Math.min(source.naturalHeight - 1, Math.max(0, Math.round(crop.y * source.naturalHeight / 100)));
      const width = Math.min(source.naturalWidth - x, Math.max(1, Math.round(crop.width * source.naturalWidth / 100)));
      const height = Math.min(source.naturalHeight - y, Math.max(1, Math.round(crop.height * source.naturalHeight / 100)));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(source, x, y, width, height, 0, 0, width, height);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(value => value ? resolve(value) : reject(new Error("Crop failed")), "image/png");
      });
      if (alive.current) {
        onConfirm(new File([blob], file.name.replace(/\.[^.]+$/, "") + ".png", { type: "image/png", lastModified: file.lastModified }));
      }
    } catch {
      if (alive.current) setError(t("visualNovel.cropFailed"));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return <Dialog open onOpenChange={open => { if (!open) onCancel(); }}>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] max-w-3xl flex-col overflow-y-auto p-4 sm:p-6">
      <DialogHeader className="shrink-0 pr-6 text-left">
        <DialogTitle>{t("visualNovel.cropSprite")}</DialogTitle>
        <DialogDescription>{t("visualNovel.cropSpriteHint")}</DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 items-center justify-center rounded-lg border border-border bg-background p-3">
        <ReactCrop crop={crop} keepSelection ruleOfThirds minWidth={8} minHeight={8} disabled={!loaded || busy}
          onChange={(_, percentCrop) => setCrop(percentCrop)} className="max-h-[52dvh] max-w-full sm:max-h-[58dvh]"
          style={{ backgroundColor: "#222", backgroundImage: "conic-gradient(#333 25%, #222 0 50%, #333 0 75%, #222 0)", backgroundSize: "16px 16px" }}>
          <img ref={image} src={src} alt={file.name} draggable={false} className="block max-h-[52dvh] max-w-full select-none object-contain sm:max-h-[58dvh]"
            onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setError(t("visualNovel.cropFailed")); }} />
        </ReactCrop>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter className="shrink-0 gap-2 sm:space-x-0">
        <button type="button" disabled={!loaded || busy} onClick={() => setCrop(fullImage)} className="rounded-lg border border-border px-3 py-2 text-sm text-foreground disabled:opacity-40 sm:mr-auto">{t("visualNovel.useWholeImage")}</button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-border px-3 py-2 text-sm text-foreground">{common("action.cancel")}</button>
        <button type="button" disabled={!loaded || busy || crop.width <= 0 || crop.height <= 0} onClick={() => void confirm()} className="flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t("visualNovel.cropAndUpload")}
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
