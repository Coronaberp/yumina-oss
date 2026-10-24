import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardPaste, Link, Loader2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getImageFilesFromTransfer } from "@/lib/clipboard-image";
import { prepareImportedImage, MAX_IMAGE_IMPORT_BYTES, type ImageSource } from "@/lib/image-import";
import type { UploadProgress } from "@/lib/asset-upload";
import { SpriteCropDialog } from "@/features/editor/components/sprite-crop-dialog";
import { useSession } from "@/lib/auth-client";

export interface ImageImportContext {
  signal: AbortSignal;
  onProgress: (progress: UploadProgress) => void;
}

export interface ImageImportDialogProps {
  multiple?: boolean;
  initialFiles?: File[];
  title?: string;
  description?: string;
  maxFiles?: number;
  maxBytes?: number;
  accept?: string;
  /** Cropping is an explicit derivative edit; ordinary acquisition keeps the original. */
  crop?: "freeform" | "none";
  preserveOriginal?: boolean;
  portalContainer?: HTMLElement | null;
  onImport: (files: File[], context: ImageImportContext) => void | Promise<void>;
  onClose: () => void;
}

const apiBase = import.meta.env.VITE_API_URL || "";
const DEFAULT_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const IMAGE_EXTENSIONS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic" };
const buttonClass = "flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-foreground disabled:opacity-40";
type CropRequest = { file: File; url: string; resolve: (file: File | null) => void };
type Preview = { files: File[]; urls: string[]; controller: AbortController };

function accepts(file: File, accept: string) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = (file.type || IMAGE_EXTENSIONS[extension] || "").toLowerCase();
  if (!mime.startsWith("image/")) return false;
  return accept.split(",").some(value => {
    const rule = value.trim().toLowerCase();
    return rule === "image/*" || rule === mime || (rule.startsWith(".") && rule === `.${extension}`);
  });
}

export function ImageImportDialog({ multiple = false, initialFiles, title, description, maxFiles, maxBytes = MAX_IMAGE_IMPORT_BYTES, accept = DEFAULT_ACCEPT, crop: cropMode = "none", preserveOriginal = true, portalContainer, onImport, onClose }: ImageImportDialogProps) {
  const { t } = useTranslation("editor");
  const { data: session, isPending } = useSession();
  const owner = useRef<string | null>(null);
  const currentOwner = useRef(session?.user.id);
  currentOwner.current = session?.user.id;
  const alive = useRef(true);
  const closed = useRef(false);
  const [links, setLinks] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [crop, setCrop] = useState<CropRequest | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | null>(null);
  const committing = useRef<AbortController | null>(null);
  const cropRequest = useRef<CropRequest | null>(null);
  const previewRequest = useRef<Preview | null>(null);
  const limit = maxFiles ?? (multiple ? 30 : 1);

  function dispose() {
    operation.current?.abort();
    cropRequest.current?.resolve(null);
    if (cropRequest.current) URL.revokeObjectURL(cropRequest.current.url);
    cropRequest.current = null;
    for (const url of previewRequest.current?.urls ?? []) URL.revokeObjectURL(url);
    previewRequest.current = null;
  }
  function close() {
    if (closed.current) return;
    closed.current = true;
    dispose();
    onClose();
  }
  function current(controller: AbortController) {
    return alive.current && !closed.current && !controller.signal.aborted && operation.current === controller && !!owner.current && currentOwner.current === owner.current;
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; dispose(); };
  }, []);
  useEffect(() => {
    if (isPending) return;
    if (!session?.user.id || (owner.current && owner.current !== session.user.id)) close();
    else owner.current = session.user.id;
    // Current owner is rechecked synchronously before every async assignment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPending, session?.user.id]);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled && !isPending && initialFiles?.length) void importSources(initialFiles); });
    return () => { cancelled = true; };
    // Only a newly selected source list starts a batch, never dialog progress updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFiles, isPending, session?.user.id]);

  function validate(file: File) {
    if (!accepts(file, accept)) throw Error(t("imageImport.unsupported", { defaultValue: "Choose an image in a supported format." }));
    if (!file.size || file.size > maxBytes) throw Error(t("imageImport.sizeLimit", { defaultValue: Number.isFinite(maxBytes) ? `Images must be under ${Math.round(maxBytes / 1024 / 1024 * 10) / 10} MB.` : "Choose a non-empty image." }));
  }

  async function submit(files: File[], controller: AbortController) {
    if (!current(controller) || committing.current === controller) return;
    // Retire duplicate confirmations synchronously, before React disables the button.
    committing.current = controller;
    setBusy(true); setError(""); setUploadProgress(null);
    setProgress(t("imageImport.uploading", { defaultValue: "Uploading image…" }));
    try {
      await onImport(files, { signal: controller.signal, onProgress: value => {
        if (current(controller) && committing.current === controller) setUploadProgress(value);
      } });
      if (current(controller)) close();
    } catch (failure) {
      if (current(controller)) {
        // Keep this exact prepared batch so retries can reuse completed uploads.
        // Managed crop confirmation still submits immediately on the first attempt.
        if (!previewRequest.current) {
          const pending = { files, urls: files.map(file => URL.createObjectURL(file)), controller };
          previewRequest.current = pending; setPreview(pending);
        }
        setError(failure instanceof Error ? failure.message : t("imageImport.failed"));
      }
    } finally {
      if (current(controller)) {
        committing.current = null; setBusy(false); setProgress(""); setUploadProgress(null);
        if (!previewRequest.current) operation.current = null;
      }
    }
  }

  async function importSources(sources: ImageSource[]) {
    if (!sources.length || operation.current || closed.current || !owner.current || currentOwner.current !== owner.current) return;
    if (sources.length > limit) { setError(t("imageImport.tooMany", { count: limit, defaultValue: `Choose up to ${limit} image${limit === 1 ? "" : "s"}.` })); return; }
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); setUploadProgress(null);
    try {
      // Reject an invalid batch before making preparation requests for any of it.
      sources.forEach(source => { if (typeof source !== "string") validate(source); });
      const files: File[] = [];
      for (const [index, source] of sources.entries()) {
        if (!current(controller)) return;
        setProgress(t("imageImport.preparing", { current: index + 1, total: sources.length }));
        const prepared = preserveOriginal && typeof source !== "string"
          ? { file: source, skipCrop: source.type === "image/gif" || source.type === "image/webp" }
          : await prepareImportedImage(source, controller.signal, `${apiBase}/api/user-assets/import-image`);
        if (!current(controller)) return;
        validate(prepared.file);
        if (cropMode === "none" || prepared.skipCrop) files.push(prepared.file);
        else {
          const file = await new Promise<File | null>(resolve => {
            const request = { file: prepared.file, url: URL.createObjectURL(prepared.file), resolve };
            cropRequest.current = request; setCrop(request);
          });
          const request = cropRequest.current; cropRequest.current = null;
          if (request) URL.revokeObjectURL(request.url);
          if (!current(controller)) return;
          setCrop(null);
          if (!file) return;
          validate(file); files.push(file);
        }
      }
      if (!current(controller)) return;
      if (cropMode === "none") {
        const pending = { files, urls: files.map(file => URL.createObjectURL(file)), controller };
        previewRequest.current = pending; setPreview(pending); setBusy(false); setProgress("");
      } else await submit(files, controller);
    } catch (failure) {
      if (current(controller)) { setError(failure instanceof Error ? failure.message : t("imageImport.failed")); operation.current = null; setBusy(false); setProgress(""); }
    }
  }

  function restart() {
    dispose(); operation.current = null; committing.current = null;
    setPreview(null); setCrop(null); setBusy(false); setError(""); setProgress(""); setUploadProgress(null);
  }
  function transfer(data: DataTransfer | null | undefined) {
    const files = getImageFilesFromTransfer(data);
    if (!files.length) return false;
    void importSources(files); return true;
  }
  const percent = uploadProgress && Number.isFinite(uploadProgress.fraction) ? Math.max(0, Math.min(100, Math.round(uploadProgress.fraction * 100))) : null;
  if (crop) return <SpriteCropDialog key={crop.url} file={crop.file} src={crop.url} title={t("imageImport.cropTitle")} description={t("imageImport.cropHint")} confirmLabel={t("imageImport.useImage")} onCancel={close} onConfirm={file => {
    if (cropRequest.current !== crop) return;
    // Resolving once also prevents a rapid double click from confirming twice.
    crop.resolve(file);
  }} />;
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent portalContainer={portalContainer} overlayClassName="z-[200]" onEscapeKeyDown={event => event.stopPropagation()} aria-busy={busy} className="z-[201] max-h-[90dvh] max-w-lg overflow-y-auto p-4 sm:p-6" onPaste={event => {
      if (transfer(event.clipboardData)) { event.preventDefault(); event.stopPropagation(); }
    }} onDragOver={event => {
      if (!Array.from(event.dataTransfer.types ?? []).includes("Files")) return;
      event.preventDefault(); event.stopPropagation(); if (!busy && !preview) setDragging(true);
    }} onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    }} onDrop={event => {
      setDragging(false);
      if (transfer(event.dataTransfer)) { event.preventDefault(); event.stopPropagation(); }
    }}>
      <DialogHeader className="pr-6 text-left"><DialogTitle>{title ?? t("imageImport.title")}</DialogTitle><DialogDescription>{description ?? t("imageImport.hint")}</DialogDescription></DialogHeader>
      {preview ? <>
        <div className="grid max-h-[45dvh] grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
          {preview.files.map((file, index) => <figure key={preview.urls[index]} className="min-w-0 overflow-hidden rounded-lg border border-border bg-background p-2"><img src={preview.urls[index]} alt={file.name} className="h-40 w-full object-contain" /><figcaption className="mt-1 break-words text-xs text-muted-foreground">{file.name}</figcaption></figure>)}
        </div>
        <button type="button" disabled={busy} className={`${buttonClass} bg-primary text-primary-foreground`} onClick={() => void submit(preview.files, preview.controller)}>{t(preview.files.length === 1 ? "imageImport.confirmImage" : "imageImport.confirmImages", { defaultValue: preview.files.length === 1 ? "Use image" : "Use images" })}</button>
        <button type="button" disabled={busy} className={buttonClass} onClick={restart}>{t("imageImport.chooseDifferent", { defaultValue: "Choose different images" })}</button>
      </> : <>
        <input ref={input} type="file" accept={accept} multiple={multiple} disabled={busy || isPending} className="hidden" aria-label={t("imageImport.files")} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void importSources(files); }} />
        <button type="button" disabled={busy || isPending} className={buttonClass} onClick={() => input.current?.click()}><Upload size={16} />{t("imageImport.files")}</button>
        <div tabIndex={0} aria-label={t("imageImport.paste")} aria-disabled={busy} className={`rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${dragging ? "border-primary bg-primary/10" : "border-border"}`}><ClipboardPaste className="mx-auto mb-2 h-5 w-5" />{t("imageImport.pasteHint")}<p className="mt-1">{t("imageImport.dropHint", { defaultValue: "Or drop images here" })}</p></div>
        <form className="space-y-2" onSubmit={event => { event.preventDefault(); void importSources(links.split(/\r?\n/).map(value => value.trim()).filter(Boolean)); }}>
          <label className="block text-sm text-foreground" htmlFor="image-import-links">{t("imageImport.links")}</label>
          <textarea id="image-import-links" value={links} onChange={event => setLinks(event.target.value)} disabled={busy} rows={multiple ? 3 : 2} maxLength={multiple ? 120_000 : 4096} placeholder="https://example.com/image.png" className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
          <button type="submit" disabled={busy || isPending || !links.trim()} className={`${buttonClass} w-full`}><Link size={16} />{t("imageImport.importLinks")}</button>
        </form>
        {!preserveOriginal && <p className="text-xs text-muted-foreground">{t("imageImport.safetyHint")}</p>}
      </>}
      {busy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" />{progress}</p>}
      {busy && percent !== null && <div role="progressbar" aria-label={t("imageImport.uploadProgress", { defaultValue: "Upload progress" })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} /></div>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      <button type="button" className={buttonClass} onClick={close}>{t("imageImport.cancel", { defaultValue: "Cancel" })}</button>
    </DialogContent>
  </Dialog>;
}
