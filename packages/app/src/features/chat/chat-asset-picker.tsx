import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, Folder, Loader2, Search, Upload } from "lucide-react";
import { chatImageCopy, type ChatImageAttachment } from "@yumina/shared";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useUserAssetStore, type UserAsset, type AssetFolder } from "@/stores/user-assets";
import { cardImageUrl, fallbackToOriginalOnError } from "@/lib/asset-url";
import { assetFolderTrail, chatAssetQuery } from "./chat-asset-folders";
import { CHAT_IMAGE_MIME_TYPES, MAX_CHAT_IMAGE_BYTES } from "@yumina/shared";
import { chatImageCopy as chatInputCopy } from "@/lib/chat-image-input";
import { ImageImportDialog, type ImageImportContext } from "@/components/image-import-dialog";

const apiBase = import.meta.env.VITE_API_URL || "";

export function ChatAssetPicker({ onSelect, onClose }: {
  onSelect: (image: ChatImageAttachment) => void;
  onClose: () => void;
}) {
  const { i18n } = useTranslation();
  const copy = chatImageCopy(i18n.language);
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [assets, setAssets] = useState<UserAsset[]>([]);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<UserAsset | null>(null);
  const [imageImport, setImageImport] = useState<{ folderId: string | null; token: number } | null>(null);
  const imageRequest = useRef(0);
  const returnFocus = useRef(document.activeElement);
  const mounted = useRef(true);
  const uploadInFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // Local query state keeps browsing here independent of the Library page.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false);
    void Promise.all([
      fetch(`${apiBase}/api/user-assets?${chatAssetQuery(folderId, search, page)}`, { credentials: "include", signal: controller.signal }),
      fetch(`${apiBase}/api/user-assets/folders`, { credentials: "include", signal: controller.signal }),
    ]).then(async ([assetResponse, folderResponse]) => {
      if (!assetResponse.ok || !folderResponse.ok) throw new Error("Assets unavailable");
      const [assetBody, folderBody] = await Promise.all([assetResponse.json(), folderResponse.json()]);
      if (controller.signal.aborted) return;
      setAssets(assetBody.data ?? []); setTotal(assetBody.total ?? 0); setFolders(folderBody.data ?? []);
    }).catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [folderId, search, page, revision]);

  function closeImageImport() { imageRequest.current++; setImageImport(null); setUploading(false); uploadInFlight.current = false; }
  function navigate(id: string | null) { closeImageImport(); setFolderId(id); setSearch(""); setPage(1); setSelected(null); }
  async function upload(file: File, context: ImageImportContext, target: NonNullable<typeof imageImport>) {
    const current = () => mounted.current && imageRequest.current === target.token && !context.signal.aborted;
    if (!current()) return;
    if (uploadInFlight.current) return;
    if (!CHAT_IMAGE_MIME_TYPES.includes(file.type as typeof CHAT_IMAGE_MIME_TYPES[number])) {
      throw new Error(chatInputCopy(i18n.language, "format"));
    }
    if (!file.size || file.size > MAX_CHAT_IMAGE_BYTES) {
      throw new Error(chatInputCopy(i18n.language, "size"));
    }
    uploadInFlight.current = true; setUploading(true);
    try {
      const asset = await useUserAssetStore.getState().uploadAsset(file, "image", target.folderId ?? undefined, { addToList: false, signal: context.signal, onProgress: context.onProgress, silent: true });
      if (!current()) return;
      if (!asset) throw new Error(copy.failed);
      setSearch(""); setPage(1); setSelected(asset); setRevision(value => value + 1);
      uploadInFlight.current = false; setUploading(false); imageRequest.current++;
    } finally {
      if (current()) { uploadInFlight.current = false; setUploading(false); }
    }
  }
  const childFolders = folders.filter(folder => folder.parentFolderId === folderId && folder.name.toLowerCase().includes(search.trim().toLowerCase()));
  const trail = assetFolderTrail(folders, folderId);

  return <><Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:rounded-2xl" aria-describedby={undefined} onEscapeKeyDown={event => event.stopPropagation()} onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current instanceof HTMLElement && returnFocus.current.isConnected) returnFocus.current.focus(); }} portalContainer={document.fullscreenElement as HTMLElement | null}>
      <div className="border-b border-border px-4 py-4"><DialogTitle className="text-sm font-medium">{copy.title}</DialogTitle></div>
      <div className="flex gap-2 border-b border-border p-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-background px-2.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input aria-label={copy.search} placeholder={copy.search} value={search} disabled={uploading} onChange={e => { setSearch(e.target.value); setPage(1); setSelected(null); }} className="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" />
        </label>
        <button type="button" disabled={uploading} onClick={() => setImageImport({ folderId, token: ++imageRequest.current })} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm text-primary disabled:opacity-50">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{uploading ? copy.uploading : copy.upload}
        </button>
      </div>
      <nav aria-label={copy.root} className="flex flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <button type="button" disabled={uploading} onClick={() => navigate(null)} className="min-h-9 rounded px-1 hover:text-foreground">{copy.root}</button>
        {trail.map(folder => <span key={folder.id} className="flex min-w-0 items-center gap-1"><ChevronRight className="h-3 w-3 shrink-0" /><button type="button" disabled={uploading} onClick={() => navigate(folder.id)} className="min-h-9 max-w-48 truncate rounded px-1 hover:text-foreground" aria-current={folder.id === folderId ? "page" : undefined}>{folder.name}</button></span>)}
      </nav>
      <div className="max-h-[45dvh] min-h-36 overflow-y-auto p-3" aria-busy={loading || uploading}>
        {loading ? <div className="flex justify-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{copy.loading}</div> : error ? <div role="alert" className="py-8 text-center text-sm"><p>{copy.failed}</p><button type="button" onClick={() => setRevision(value => value + 1)} className="mt-2 text-primary">{copy.retry}</button></div> : <>
          {childFolders.length > 0 && <div className="mb-3 grid grid-cols-2 gap-2">{childFolders.map(folder => <button type="button" key={folder.id} disabled={uploading} onClick={() => navigate(folder.id)} className="flex min-w-0 items-center gap-2 rounded-lg border border-border p-3 text-left text-sm hover:bg-accent"><Folder className="h-4 w-4 shrink-0 text-primary" /><span className="truncate">{folder.name}</span><ChevronRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground" /></button>)}</div>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{assets.map(asset => <button type="button" key={asset.id} disabled={uploading} aria-pressed={selected?.id === asset.id} onClick={() => setSelected(selected?.id === asset.id ? null : asset)} className={`relative overflow-hidden rounded-lg border text-left ${selected?.id === asset.id ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/40"}`}>
            <img src={cardImageUrl(asset.url, 400)} alt={asset.filename} loading="lazy" onError={fallbackToOriginalOnError} className="h-24 w-full bg-accent/30 object-cover" />
            <span className="block truncate p-2 text-xs">{asset.filename}</span>
            {selected?.id === asset.id && <Check className="absolute right-1.5 top-1.5 h-5 w-5 rounded-full bg-primary p-0.5 text-primary-foreground" />}
          </button>)}</div>
          {!assets.length && !childFolders.length && <p className="py-8 text-center text-sm text-muted-foreground">{search ? copy.noMatches : copy.empty}</p>}
        </>}
      </div>
      {total > 24 && <div className="flex items-center justify-center gap-4 border-t border-border px-3 py-2 text-xs"><button type="button" disabled={page === 1 || loading || uploading} onClick={() => { setPage(value => value - 1); setSelected(null); }} className="min-h-9 disabled:opacity-40">{copy.previous}</button><span>{page} / {Math.ceil(total / 24)}</span><button type="button" disabled={page * 24 >= total || loading || uploading} onClick={() => { setPage(value => value + 1); setSelected(null); }} className="min-h-9 disabled:opacity-40">{copy.next}</button></div>}
      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3"><span className="text-xs text-muted-foreground" aria-live="polite">{selected ? copy.selected : copy.none}</span><button type="button" disabled={!selected || uploading || loading || error} onClick={() => { if (selected) onSelect({ type: "image", assetId: selected.id, url: selected.url, mimeType: selected.mimeType ?? "image/png", name: selected.filename }); }} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40">{copy.add}</button></div>
    </DialogContent>
  </Dialog>
  {imageImport && <ImageImportDialog preserveOriginal crop="none" maxBytes={MAX_CHAT_IMAGE_BYTES}
    title={copy.upload} portalContainer={document.fullscreenElement as HTMLElement | null}
    onImport={(files, context) => upload(files[0]!, context, imageImport)} onClose={closeImageImport} />}
  </>;
}
