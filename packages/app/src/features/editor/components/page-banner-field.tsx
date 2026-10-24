import { ImageImportDialog, type ImageImportContext } from "@/components/image-import-dialog";
import { useSession } from "@/lib/auth-client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Camera, FolderOpen, ImageIcon, Loader2, X } from "lucide-react";
import { CroppedImage } from "@/lib/cover-crop";
import { DEFAULT_WORLD_BANNER_CROP, normalizeWorldBannerCrop } from "@/lib/world-detail-media";
import { useEditorStore } from "@/stores/editor";
import { useAssetStore } from "@/stores/assets";
import { AssetPicker } from "../asset-picker";
import { CoverCropDialog } from "./cover-crop-dialog";

const REGISTERED_IMAGE = /^@asset:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function PageBannerField() {
  const draft = useEditorStore(s => s.worldDraft);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const disabled = useEditorStore(s => s.readOnlyInspect || s.editingLocked || s.guestMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ worldId: string; request: number } | null>(null);
  const [framing, setFraming] = useState<{ src: string; request: number } | null>(null);
  const [imageImport, setImageImport] = useState<{ request: number; owner: string | undefined; banner: string | undefined } | null>(null);
  const ownerId = useSession().data?.user.id;
  const owner = useRef(ownerId);
  useLayoutEffect(() => { owner.current = ownerId; }, [ownerId]);
  const previousOwner = useRef(ownerId);
  const request = useRef(0);
  const inFlight = useRef<number | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let previous = useEditorStore.getState();
    // A first save assigns a server ID to the same draft; a world switch retires all pending actions.
    const unsubscribe = useEditorStore.subscribe(next => {
      if (next.worldDraft.id !== previous.worldDraft.id ||
          (previous.serverWorldId && next.serverWorldId !== previous.serverWorldId) ||
          (!previous.readOnlyInspect && next.readOnlyInspect) ||
          (!previous.editingLocked && next.editingLocked) || (!previous.guestMode && next.guestMode)) {
        request.current++;
        setPicker(null); setFraming(null); setImageImport(null); setBusy(false); setError(null);
      }
      previous = next;
    });
    return () => { alive.current = false; unsubscribe(); };
  }, []);

  useLayoutEffect(() => {
    if (previousOwner.current !== ownerId) {
      previousOwner.current = ownerId;
      request.current++;
      setImageImport(null); setPicker(null); setFraming(null); setBusy(false);
    }
  }, [ownerId]);

  function current(token: number) {
    const state = useEditorStore.getState();
    return alive.current && owner.current === previousOwner.current && token === request.current && !state.readOnlyInspect && !state.editingLocked && !state.guestMode;
  }

  async function savedWorld(token: number) {
    if (!current(token)) return null;
    if (!useEditorStore.getState().serverWorldId) await useEditorStore.getState().saveDraft();
    if (!current(token)) return null;
    const id = useEditorStore.getState().serverWorldId;
    if (!id) setError("Save this world before adding a page banner.");
    return id;
  }

  async function applyImage(ref: string, token: number) {
    if (!current(token) || !REGISTERED_IMAGE.test(ref)) return;
    // Selecting a local asset can beat a pending global-asset import in the same picker.
    // Consume this action before committing so only its first accepted result wins.
    request.current++;
    setBusy(false);
    const state = useEditorStore.getState();
    state.setField("bannerImageUrl", ref);
    state.setField("bannerCrop", { ...DEFAULT_WORLD_BANNER_CROP });
    setPicker(null); setFraming(null);
    await state.saveDraft();
  }

  async function upload(files: File[], context: ImageImportContext, target: NonNullable<typeof imageImport>) {
    const token = target.request;
    const file = files[0];
    const startedOwner = target.owner;
    const startedBanner = target.banner;
    const check = () => {
      context.signal.throwIfAborted();
      if (!current(token) || owner.current !== startedOwner ||
          useEditorStore.getState().worldDraft.bannerImageUrl !== startedBanner) {
        throw new DOMException("The image destination changed.", "AbortError");
      }
    };
    check();
    if (!file || inFlight.current === token) return;
    inFlight.current = token;
    setBusy(true); setError(null); setPicker(null); setFraming(null);
    try {
      const id = await savedWorld(token);
      check();
      if (!id) throw new Error("Save this world before adding a page banner.");
      const asset = await useAssetStore.getState().uploadAsset(id, file, "image", {
        signal: context.signal, onProgress: context.onProgress, silent: true,
      });
      check();
      if (!asset) throw new Error("Couldn't upload the page banner. Try again.");
      await applyImage(`@asset:${asset.id}`, token);
    } catch (error) {
      if (current(token) && !context.signal.aborted) setError(error instanceof Error ? error.message : "Couldn't upload the page banner. Try again.");
      throw error;
    } finally {
      if (inFlight.current === token) inFlight.current = null;
      if (current(token)) setBusy(false);
    }
  }

  async function openPicker() {
    if (disabled || busy) return;
    const token = ++request.current;
    setError(null); setFraming(null);
    const id = await savedWorld(token);
    if (id && current(token)) setPicker({ worldId: id, request: token });
  }

  async function remove() {
    if (disabled || busy) return;
    request.current++;
    setPicker(null); setFraming(null); setError(null);
    const state = useEditorStore.getState();
    state.setField("bannerImageUrl", "");
    state.setField("bannerCrop", { ...DEFAULT_WORLD_BANNER_CROP });
    await state.saveDraft();
  }

  const banner = draft.bannerImageUrl || "";
  const crop = normalizeWorldBannerCrop(draft.bannerCrop);
  const buttonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40";

  return (
    <section aria-labelledby="page-banner-label" aria-describedby="page-banner-description" className="rounded-lg border border-border bg-background p-5">
      <h3 id="page-banner-label" className="text-sm font-semibold text-foreground">Page banner <span className="font-normal text-muted-foreground">(optional)</span></h3>
      <p id="page-banner-description" className="mt-1 text-xs leading-relaxed text-muted-foreground">Wide artwork for the top of your world page. Recommended 16:5, such as 1600 × 500. The portrait card cover stays separate.</p>
      <div data-banner-preview className="relative mt-4 aspect-[16/5] w-full overflow-hidden rounded-xl border border-border bg-card">
        {banner ? <CroppedImage src={banner} alt="Page banner preview" crop={crop} className="h-full w-full" /> : (
          <div className="flex h-full items-center justify-center gap-2 px-3 text-center text-xs text-muted-foreground"><ImageIcon className="h-5 w-5 shrink-0" aria-hidden="true" />Uses the card cover until you add a banner</div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={disabled || busy} className={buttonClass} onClick={() => { setError(null); setImageImport({ request: ++request.current, owner: owner.current, banner: useEditorStore.getState().worldDraft.bannerImageUrl }); }}>{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Camera className="h-4 w-4" aria-hidden="true" />}{busy ? "Uploading banner…" : banner ? "Change banner" : "Upload banner"}</button>
        <button type="button" disabled={disabled || busy} className={buttonClass} onClick={() => void openPicker()}><FolderOpen className="h-4 w-4" aria-hidden="true" />From assets</button>
        {banner && <>
          <button type="button" disabled={disabled || busy} className={buttonClass} onClick={() => setFraming({ src: banner, request: ++request.current })}><ImageIcon className="h-4 w-4" aria-hidden="true" />Adjust banner framing</button>
          <button type="button" disabled={disabled || busy} className={buttonClass} onClick={() => void remove()}><X className="h-4 w-4" aria-hidden="true" />Remove banner</button>
        </>}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      {imageImport !== null && !disabled && <ImageImportDialog title="Upload page banner" crop="none" preserveOriginal maxFiles={1} maxBytes={Infinity} accept="image/jpeg,image/png,image/gif,image/webp" onImport={(files, context) => upload(files, context, imageImport)} onClose={() => { request.current++; setImageImport(null); setBusy(false); }} />}
      {picker && !disabled && serverWorldId === picker.worldId && <AssetPicker worldId={picker.worldId} filterType="image" onSelect={ref => void applyImage(ref, picker.request)} onClose={() => { request.current++; setPicker(null); }} />}
      {framing && !disabled && <CoverCropDialog src={framing.src} variant="banner" initialBannerCrop={crop} onCancel={() => setFraming(null)} onSave={value => {
        if (!current(framing.request) || useEditorStore.getState().worldDraft.bannerImageUrl !== framing.src || !value.bannerCrop) return;
        useEditorStore.getState().setField("bannerCrop", value.bannerCrop);
        setFraming(null);
        void useEditorStore.getState().saveDraft();
      }} />}
    </section>
  );
}
