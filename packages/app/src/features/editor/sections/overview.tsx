import { ImageImportDialog, type ImageImportContext } from "@/components/image-import-dialog";
import { useSession } from "@/lib/auth-client";
import { confirmAction } from "@/components/ui/global-confirm-dialog";
import { Select } from "@/components/ui/select";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Plus, ImageIcon, Loader2, Camera, FolderOpen, Upload, Globe, Type, History } from "lucide-react";
import { FieldError } from "@/components/ui/field-error";
import { WorldUpdateHistory } from "@/features/library/world-update-history";
import { MAX_WORLD_DESCRIPTION, MAX_WORLD_NAME } from "@yumina/shared";
import { parseImportedFile } from "@/lib/import-world";
import {
  getAssetUploadErrorMessage,
  uploadAssetWithPresignedUrl,
} from "@/lib/asset-upload";
import {
  CroppedImage,
  normalizeCoverCrop,
  type CoverCropSettings,
} from "@/lib/cover-crop";
import { getWorldGalleryDisplayCrop } from "@/lib/world-cover-crop";
import { useEditorStore } from "@/stores/editor";
import { AssetPicker } from "../asset-picker";
import { CoverCropDialog } from "../components/cover-crop-dialog";
import { PageBannerField } from "../components/page-banner-field";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";


const apiBase = import.meta.env.VITE_API_URL || "";

const FROM_ASSET_TIMEOUT_MS = 20_000;

function fetchWithTimeout(input: RequestInfo, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeoutId);
  });
}


interface CardMediaTarget {
  check: (signal?: AbortSignal) => void;
  cancel: () => void;
  begin: (signal?: AbortSignal) => boolean;
  end: (success: boolean) => void;
  worldId: (signal?: AbortSignal) => Promise<string>;
}

// Keep an upload attached to the exact draft, account and destination that opened it.
function useCardMediaTarget(onRetire: () => void) {
  const ownerId = useSession().data?.user.id;
  const owner = useRef(ownerId);
  const retireCallback = useRef(onRetire);
  useLayoutEffect(() => { owner.current = ownerId; retireCallback.current = onRetire; });
  const revision = useRef(0);
  const alive = useRef(true);
  const retire = useCallback(() => { revision.current++; retireCallback.current(); }, []);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = useEditorStore.subscribe((next, previous) => {
      if (next.worldDraft.id !== previous.worldDraft.id ||
          (previous.serverWorldId && next.serverWorldId !== previous.serverWorldId) ||
          (!previous.readOnlyInspect && next.readOnlyInspect) ||
          (!previous.editingLocked && next.editingLocked) || (!previous.guestMode && next.guestMode)) retire();
    });
    return () => { alive.current = false; unsubscribe(); };
  }, [retire]);
  useLayoutEffect(() => { retire(); }, [ownerId, retire]);
  const capture = useCallback((field: "avatar" | "galleryImages"): CardMediaTarget => {
    const initial = useEditorStore.getState();
    const token = revision.current;
    const account = owner.current;
    const draftId = initial.worldDraft.id;
    let worldId = initial.serverWorldId;
    let active = true, running = false;
    const value = field === "avatar" ? initial.worldDraft.avatar : initial.galleryImages;
    const check = (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const current = useEditorStore.getState();
      if (!active || !alive.current || token !== revision.current || owner.current !== account ||
          current.worldDraft.id !== draftId || (worldId && current.serverWorldId !== worldId) ||
          current.readOnlyInspect || current.editingLocked || current.guestMode ||
          (field === "avatar" ? current.worldDraft.avatar : current.galleryImages) !== value) {
        throw new DOMException("The image destination changed.", "AbortError");
      }
    };
    return { check, cancel: () => { active = false; },
      begin: signal => { check(signal); if (running) return false; running = true; return true; },
      end: success => { running = false; if (success) active = false; },
      worldId: async signal => {
      check(signal);
      if (!worldId) { await useEditorStore.getState().saveDraft(); check(signal); worldId = useEditorStore.getState().serverWorldId; }
      if (!worldId) throw new Error("Save this world before adding an image.");
      return worldId;
    } };
  }, []);
  return { capture, retire };
}

export function OverviewSection() {
  const { t } = useTranslation("editor");
  const { t: tLibrary } = useTranslation("library");
  const worldDraft = useEditorStore(s => s.worldDraft);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const readOnlyInspect = useEditorStore(s => s.readOnlyInspect);
  const guestMode = useEditorStore(s => s.guestMode);
  const historyState = useEditorStore(s => `${s.worldStatus}:${s.pendingEdit?.status ?? ""}`);
  const setField = useEditorStore(s => s.setField);
  const loadWorldDefinition = useEditorStore(s => s.loadWorldDefinition);
  const galleryImages = useEditorStore(s => s.galleryImages) ?? [];
  const setGalleryImages = useEditorStore(s => s.setGalleryImages);
  const language = useEditorStore(s => s.language);

  const [uploadingCover, setUploadingCover] = useState(false);
  const [uploadingGallery, setUploadingGallery] = useState(false);
  const [removingIndex, setRemovingIndex] = useState<number | null>(null);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [loadedGallery, setLoadedGallery] = useState(false);
  const [coverPickerTarget, setCoverPickerTarget] = useState<CardMediaTarget | null>(null);
  const [galleryPickerTarget, setGalleryPickerTarget] = useState<CardMediaTarget | null>(null);
  // Every failure on this screen has a panel to sit in: cover problems print
  // under the cover buttons, gallery problems under the gallery grid (R4).
  // Successes need nothing — the image itself is the confirmation.
  const [coverError, setCoverError] = useState<string | null>(null);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [cropDialog, setCropDialog] = useState<{
    src: string;
    target: CardMediaTarget;
    coverCrop: CoverCropSettings;
    galleryCoverCrop: CoverCropSettings;
  } | null>(null);
  const activeUpload = useRef<CardMediaTarget | null>(null);
  const [imageImport, setImageImport] = useState<{ kind: "cover" | "gallery"; target: CardMediaTarget } | null>(null);
  const media = useCardMediaTarget(() => {
    setImageImport(null); setCoverPickerTarget(null); setGalleryPickerTarget(null); setCropDialog(null);
    setUploadingCover(false); setUploadingGallery(false); activeUpload.current = null;
  });
  const openCropDialog = (next: NonNullable<typeof cropDialog>) => {
    setCropDialog(previous => { previous?.target.cancel(); return next; });
  };
  const openImageImport = (kind: "cover" | "gallery") => {
    const state = useEditorStore.getState();
    if (state.readOnlyInspect || state.editingLocked || state.guestMode || (kind === "gallery" && state.galleryImages.length >= 8)) return;
    imageImport?.target.cancel();
    (kind === "cover" ? coverPickerTarget : galleryPickerTarget)?.cancel();
    setImageImport({ kind, target: media.capture(kind === "cover" ? "avatar" : "galleryImages") });
  };
  const openAssetPicker = async (kind: "cover" | "gallery") => {
    (kind === "cover" ? coverPickerTarget : galleryPickerTarget)?.cancel();
    const target = media.capture(kind === "cover" ? "avatar" : "galleryImages");
    try {
      await target.worldId(); target.check();
      if (kind === "cover") setCoverPickerTarget(target); else setGalleryPickerTarget(target);
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") (kind === "cover" ? setCoverError : setGalleryError)(error.message);
    }
  };
  const importFileRef = useRef<HTMLInputElement>(null);

  const handleImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) {
        return;
      }

      // When called from inside the editor of an existing/published world,
      // we MUST keep `serverWorldId` so:
      //   1. The route page (`worlds.$worldId.edit`) doesn't get stuck on its
      //      loading spinner because `serverWorldId !== worldId`.
      //   2. The next save PATCHes the existing world instead of creating
      //      a new one (which would orphan the published card).
      const isReplacingExisting = !!serverWorldId;
      if (isReplacingExisting) {
        const ok = (await confirmAction(t("overview.confirmReplaceWorld")));
        if (!ok) {
          e.target.value = "";
          return;
        }
      }

      try {
        const { world, coverImage } = await parseImportedFile(file, { sourceHint: "yumina" });
        loadWorldDefinition(world, {
          preserveServerState: isReplacingExisting,
        });
        if (coverImage) {
          // Use the PNG card image as the cover (saves the world first if new).
          await useEditorStore.getState().applyImportedCover(coverImage);
        }
        const entryCount = world.entries.length;
        const variableCount = world.variables.length;
        const ruleCount = world.rules.length;
        const componentCount = world.components.length;
        const audioCount = (world.audioTracks ?? []).length;
        const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
        const summary = `Imported "${world.name}" (${n(entryCount, "entry", "entries")}, ${n(variableCount, "variable", "variables")}, ${n(ruleCount, "rule", "rules")}, ${n(componentCount, "component", "components")}, ${audioCount} audio)`;
        // Replacing a live card needs a save to take effect — say so in the
        // same line, where the creator is already reading the result.
        setImportResult(
          isReplacingExisting
            ? `${summary} — ${t("overview.importReplacedSaveReminder")}`
            : summary
        );
      } catch (error) {
        setImportResult(
          error instanceof Error
            ? error.message
            : t("extra.failedParseWorld")
        );
      } finally {
        e.target.value = "";
      }
    },
    [loadWorldDefinition, serverWorldId, t]
  );

  const handleCoverUpload = async (file: File, context: ImageImportContext, target: CardMediaTarget) => {
    if (!target.begin(context.signal)) return;
    let success = false; activeUpload.current = target;
    setUploadingCover(true); setCoverError(null);
    try {
      const id = await target.worldId(context.signal);
      const data = await uploadAssetWithPresignedUrl<{ thumbnailUrl: string }>({
        file, preferredType: "image", resizeImageMaxDimension: 2048,
        prepareUrl: `${apiBase}/api/worlds/${id}/thumbnail`,
        registerUrl: `${apiBase}/api/worlds/${id}/thumbnail/confirm`,
        registerBody: ({ key }) => ({ key }), signal: context.signal, onProgress: context.onProgress,
      });
      target.check(context.signal);
      setField("avatar", data.thumbnailUrl);
      success = true;
      openCropDialog({ target: media.capture("avatar"), src: data.thumbnailUrl,
        coverCrop: normalizeCoverCrop(useEditorStore.getState().worldDraft.coverCrop),
        galleryCoverCrop: normalizeCoverCrop(useEditorStore.getState().worldDraft.galleryCoverCrop),
      });
    } catch (error) {
      if (activeUpload.current === target && !context.signal.aborted && error instanceof Error && error.name !== "AbortError") setCoverError(getAssetUploadErrorMessage(error));
      throw error;
    } finally { target.end(success); if (activeUpload.current === target) { activeUpload.current = null; setUploadingCover(false); } }
  };

  const handleCoverFromAsset = async (assetRef: string, target: CardMediaTarget) => {
    const match = assetRef.match(/@asset:(.+)/);
    if (!match) return;
    try { if (!target.begin()) return; } catch { return; }
    let success = false;
    try {
      setCoverError(null);
      const id = await target.worldId();
      const res = await fetchWithTimeout(`${apiBase}/api/worlds/${id}/thumbnail/from-asset`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ assetId: match[1] }),
      }, FROM_ASSET_TIMEOUT_MS);
      target.check();
      if (!res.ok) {
        const error = await res.json().catch(() => ({})); target.check();
        throw new Error((error as { error?: string }).error || t("overview.coverFromAssetFailed"));
      }
      const { data } = await res.json(); target.check();
      setField("avatar", data.thumbnailUrl); success = true;
      openCropDialog({ target: media.capture("avatar"), src: data.thumbnailUrl,
        coverCrop: normalizeCoverCrop(useEditorStore.getState().worldDraft.coverCrop),
        galleryCoverCrop: normalizeCoverCrop(useEditorStore.getState().worldDraft.galleryCoverCrop),
      });
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") setCoverError(error.message);
    } finally { target.end(success); }
  };

  const handleSaveCrop = useCallback(
    async (value: { coverCrop: CoverCropSettings; galleryCoverCrop: CoverCropSettings }) => {
      if (!cropDialog) return;
      try { cropDialog.target.check(); } catch { return; }
      if (useEditorStore.getState().worldDraft.avatar !== cropDialog.src) return;
      cropDialog.target.cancel();
      setField("coverCrop", value.coverCrop);
      setField("galleryCoverCrop", getWorldGalleryDisplayCrop(value.galleryCoverCrop));
      setCropDialog(null);
      // The cover preview above re-renders with the new crop and the header
      // shows the save — nothing else to announce.
      await useEditorStore.getState().saveDraft();
    },
    [setField, cropDialog]
  );

  const coverCrop = normalizeCoverCrop(worldDraft.coverCrop);
  const galleryCoverCrop = getWorldGalleryDisplayCrop(worldDraft.galleryCoverCrop);

  const handleGalleryFromAsset = async (assetRef: string, target: CardMediaTarget) => {
    const match = assetRef.match(/@asset:(.+)/);
    if (!match) return;
    try { if (!target.begin()) return; } catch { return; }
    let success = false;
    try {
      setGalleryError(null);
      const id = await target.worldId();
      if (useEditorStore.getState().galleryImages.length >= 8) throw new Error(t("overview.maxGalleryError"));
      const res = await fetchWithTimeout(`${apiBase}/api/worlds/${id}/gallery/from-asset`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ assetId: match[1] }),
      }, FROM_ASSET_TIMEOUT_MS);
      target.check();
      if (!res.ok) {
        const error = await res.json().catch(() => ({})); target.check();
        throw new Error((error as { error?: string }).error || t("overview.galleryAddFailed"));
      }
      const { data } = await res.json(); target.check();
      setGalleryImages([...useEditorStore.getState().galleryImages, data.url]); success = true;
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") setGalleryError(error.message);
    } finally { target.end(success); }
  };

  // Load gallery images from server on mount (they're presigned URLs)
  useEffect(() => {
    if (!serverWorldId || loadedGallery) return;
    setLoadedGallery(true);
    // Gallery images are already loaded via loadWorld into the store
  }, [serverWorldId, loadedGallery]);

  const handleGalleryUpload = async (file: File, context: ImageImportContext, target: CardMediaTarget) => {
    if (useEditorStore.getState().galleryImages.length >= 8) throw new Error(t("overview.maxGalleryError"));
    if (!target.begin(context.signal)) return;
    let success = false; activeUpload.current = target;
    setUploadingGallery(true); setGalleryError(null);
    try {
      const id = await target.worldId(context.signal);
      const data = await uploadAssetWithPresignedUrl<{ url: string; galleryImages: string[] }>({
        file, preferredType: "image",
        prepareUrl: `${apiBase}/api/worlds/${id}/gallery/upload-url`,
        registerUrl: `${apiBase}/api/worlds/${id}/gallery/confirm`,
        registerBody: ({ key }) => ({ key }), signal: context.signal, onProgress: context.onProgress,
      });
      target.check(context.signal);
      setGalleryImages([...useEditorStore.getState().galleryImages, data.url]);
      success = true;
    } catch (error) {
      if (activeUpload.current === target && !context.signal.aborted && error instanceof Error && error.name !== "AbortError") setGalleryError(getAssetUploadErrorMessage(error));
      throw error;
    } finally { target.end(success); if (activeUpload.current === target) { activeUpload.current = null; setUploadingGallery(false); } }
  };

  const handleRemoveGalleryImage = useCallback(
    async (index: number) => {
      if (!serverWorldId) return;
      setRemovingIndex(index);
      setGalleryError(null);
      try {
        const res = await fetch(
          `${apiBase}/api/worlds/${serverWorldId}/gallery/${index}`,
          {
            method: "DELETE",
            credentials: "include",
          }
        );
        if (!res.ok) {
          setGalleryError(t("overview.imageRemoveFailed"));
          return;
        }
        // The tile leaves the grid — that is the confirmation.
        const updated = galleryImages.filter((_, i) => i !== index);
        setGalleryImages(updated);
      } catch {
        setGalleryError(t("overview.imageRemoveFailed"));
      } finally {
        setRemovingIndex(null);
      }
    },
    [serverWorldId, galleryImages, setGalleryImages, t]
  );

  return (
    <div className="@container flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-8">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("overview.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground/50">
            {t("overview.description")}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-background p-5" data-tour="overview-title-card">
          <div className="mb-3 flex items-center justify-between gap-3">
            <label
              htmlFor="overview-world-title"
              className="text-sm font-semibold text-foreground"
            >
              {t("overview.worldTitle", { defaultValue: "World title" })}
            </label>
            <span className="shrink-0 rounded-full border border-border/70 bg-background/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground/60">
              {(worldDraft.name ?? "").length}/{MAX_WORLD_NAME}
            </span>
          </div>
          <div className="relative">
            <Type className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground/55" />
            <input
              id="overview-world-title"
              type="text"
              value={worldDraft.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder={t("shell.namePlaceholder")}
              maxLength={MAX_WORLD_NAME}
              className="w-full rounded-xl border border-border bg-card py-4 pl-12 pr-4 text-xl font-semibold text-foreground outline-none transition-colors placeholder:text-muted-foreground/30 focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <section className="rounded-lg border border-border bg-background p-5" aria-labelledby="overview-update-history-title">
          {serverWorldId ? (
            <WorldUpdateHistory
              key={`${serverWorldId}:${historyState}`}
              worldId={serverWorldId}
              canEdit={!readOnlyInspect && !guestMode}
              showCreateButton
              heading={(
                <h3 id="overview-update-history-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <History className="h-4 w-4 text-primary" aria-hidden="true" />
                  {tLibrary("detail.updateHistory")}
                </h3>
              )}
            />
          ) : (
            <>
            <h3 id="overview-update-history-title" className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
              <History className="h-4 w-4 text-primary" aria-hidden="true" />
              {tLibrary("detail.updateHistory")}
            </h3>
            <p className="py-6 text-center text-sm text-muted-foreground">{tLibrary("detail.updateHistorySaveFirst")}</p>
            </>
          )}
        </section>

        <div className="rounded-lg border border-border bg-background p-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-foreground">{t("overview.importJson")}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground/50">
              {t("overview.importJsonDesc")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={importFileRef}
              type="file"
              accept=".json,.png"
              onChange={handleImport}
              className="hidden"
            />
            <button
              onClick={() => importFileRef.current?.click()}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              <Upload className="h-3.5 w-3.5" />
              {t("overview.chooseFile")}
            </button>
            {importResult && (
              <span className="text-xs text-muted-foreground/60">
                {importResult}
              </span>
            )}
          </div>
        </div>

        {/* Cover Image */}
        <div className="rounded-lg border border-border bg-background p-5">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-foreground">{t("overview.portraitCardCover", { defaultValue: "Portrait card cover" })}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground/50">
              {t("overview.coverImageDesc")}
            </p>
          </div>
          <div className="flex flex-col @[480px]:flex-row @[480px]:items-start gap-4 @[480px]:gap-6">
            <div className="group relative aspect-[3/4] w-32 shrink-0 overflow-hidden rounded-xl border border-border bg-card shadow-lg">
              {worldDraft.avatar ? (
                <>
                  <div className="absolute inset-0 z-10 bg-black/40 transition-colors group-hover:bg-black/20" />
                  <CroppedImage
                    src={worldDraft.avatar}
                    alt="Cover"
                    crop={coverCrop}
                    className="h-full w-full"
                  />
                </>
              ) : (
                <>
                  <div className="absolute inset-0 z-10 bg-black/20 transition-colors group-hover:bg-black/10" />
                  <div className="flex h-full w-full items-center justify-center bg-card">
                    <ImageIcon className="h-10 w-10 text-muted-foreground/20" />
                  </div>
                </>
              )}
              <div className="touch-reveal absolute inset-0 z-20 flex items-center justify-center opacity-0 backdrop-blur-[2px] transition-opacity group-hover:opacity-100">
                <button
                  onClick={() => openImageImport("cover")}
                  disabled={uploadingCover}
                  className="flex items-center gap-2 rounded-lg border border-border bg-black/60 px-3 py-2 text-xs font-medium text-foreground shadow-lg transition-all hover:border-primary/50 hover:bg-black/80 hover:text-primary disabled:opacity-50"
                >
                  {uploadingCover ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Camera className="h-4 w-4" />
                  )}
                  {uploadingCover ? t("overview.uploading") : t("overview.change")}
                </button>
              </div>
              {uploadingCover && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2 pt-2">
              {worldDraft.avatar && (
                <div className="mb-2 w-48 max-w-full rounded-lg border border-border bg-card p-2">
                  <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/50">
                    Gallery preview
                  </p>
                  <CroppedImage
                    src={worldDraft.avatar}
                    alt="Gallery preview"
                    crop={galleryCoverCrop}
                    className="aspect-[16/5] w-full rounded-md border border-border"
                  />
                </div>
              )}
              <button
                onClick={() => openImageImport("cover")}
                disabled={uploadingCover}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
              >
                {/* The cover tile has its own spinner overlay; this button is the
                    other way in, so it shows the upload in place too (R6/T0 —
                    progress on the control, no pill). */}
                {uploadingCover ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Camera className="h-3.5 w-3.5" />
                )}
                {uploadingCover
                  ? t("overview.uploading")
                  : worldDraft.avatar
                    ? t("overview.changeCover")
                    : t("overview.uploadCover")}
              </button>
              <button
                onClick={() => void openAssetPicker("cover")}
                className="flex items-center gap-2 rounded-lg border border-dashed border-primary/30 bg-primary/5 px-3 py-1.5 text-sm font-medium text-primary/70 transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-primary"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {t("overview.fromAssets")}
              </button>
              {worldDraft.avatar && (
                <button
                  onClick={() => {
                    openCropDialog({
                      target: media.capture("avatar"),
                      src: worldDraft.avatar!,
                      coverCrop,
                      galleryCoverCrop,
                    });
                  }}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                  Adjust crop
                </button>
              )}
              <p className="text-xs text-muted-foreground/40">
                {t("overview.imageFormats")}
              </p>
              <FieldError id="cover-error" message={coverError} />
            </div>
          </div>
        </div>

        <PageBannerField />

        {/* Gallery Images */}
        <div className="rounded-lg border border-border bg-background p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {t("overview.galleryImages")}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground/50">
                {t("overview.galleryImagesDesc")}
              </p>
            </div>
            <span className="text-xs text-muted-foreground/40">
              {galleryImages.length}/8
            </span>
          </div>

          <div className="grid grid-cols-2 @[640px]:grid-cols-4 gap-3">
            {galleryImages.map((url, index) => (
              <div
                key={`${index}-${url}`}
                className="group relative aspect-video overflow-hidden rounded-lg border border-border bg-card"
              >
                <img
                  src={url}
                  alt={`Gallery ${index + 1}`}
                  className="h-full w-full object-cover"
                />
                <TwoTapDeleteButton
                  onConfirm={() => handleRemoveGalleryImage(index)}
                  disabled={removingIndex === index}
                  className="touch-reveal absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-red-600 active:bg-red-600 group-hover:opacity-100 disabled:opacity-50 [@media(hover:none)]:h-9 [@media(hover:none)]:w-9"
                  armedClassName="opacity-100 bg-red-600"
                  armedTitle={t("twoTapConfirm")}
                >
                  {removingIndex === index ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <X className="h-3 w-3" />
                  )}
                </TwoTapDeleteButton>
              </div>
            ))}

            {galleryImages.length < 8 && (
              <>
                <button
                  onClick={() => openImageImport("gallery")}
                  disabled={uploadingGallery}
                  className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-border bg-card text-muted-foreground/40 transition-colors hover:border-primary/50 hover:text-primary/60 disabled:opacity-50"
                >
                  {uploadingGallery ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : (
                    <div className="flex flex-col items-center gap-1">
                      <Plus className="h-5 w-5" />
                      <span className="text-[10px] font-medium">{t("overview.upload")}</span>
                    </div>
                  )}
                </button>
                <button
                  onClick={() => void openAssetPicker("gallery")}
                  className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-primary/30 bg-primary/5 text-primary/40 transition-colors hover:border-primary/50 hover:bg-primary/10 hover:text-primary/60"
                >
                  <div className="flex flex-col items-center gap-1">
                    <FolderOpen className="h-5 w-5" />
                    <span className="text-[10px] font-medium">{t("overview.fromAssets")}</span>
                  </div>
                </button>
              </>
            )}
          </div>

          {galleryImages.length === 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground/40">
              <ImageIcon className="h-3.5 w-3.5" />
              {t("overview.noGalleryImages")}
            </div>
          )}

          <FieldError id="gallery-error" message={galleryError} />

        </div>

        {/* Description */}
        <div className="rounded-lg border border-border bg-background p-5" data-tour="overview-description">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-foreground">
              {t("overview.descriptionTitle")}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground/50">
              {t("overview.descriptionDesc")}
            </p>
          </div>
          <textarea
            value={worldDraft.description}
            onChange={(e) => setField("description", e.target.value)}
            placeholder={t("overview.descriptionPlaceholder")}
            rows={8}
            maxLength={MAX_WORLD_DESCRIPTION}
            className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="mt-1 flex items-center justify-between">
            <p className="text-xs text-muted-foreground/40">
              {t("overview.markdownSupported")}
            </p>
            <span className="text-xs text-muted-foreground/30">
              {(worldDraft.description ?? "").length}/{MAX_WORLD_DESCRIPTION}
            </span>
          </div>
        </div>

        {/* Language */}
        <div className="rounded-lg border border-border bg-background p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Globe className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-foreground">{t("overview.language")}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground/50">
                {t("overview.languageDesc")}
              </p>
            </div>
            <Select compact
              value={language ?? ""}
              onValueChange={(selectedValue) => useEditorStore.getState().setLanguage(selectedValue || null)}
              className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">—</option>
              <option value="en">English</option>
              <option value="zh">中文</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="es">Español</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
              <option value="pt">Português</option>
              <option value="ru">Русский</option>
            </Select>
          </div>
        </div>

        {/* Variant Group removed — variant management is now in the tab bar above */}
      </div>

      {cropDialog && (
        <CoverCropDialog
          src={cropDialog.src}
          initialCoverCrop={cropDialog.coverCrop}
          initialGalleryCrop={cropDialog.galleryCoverCrop}
          onCancel={() => { cropDialog.target.cancel(); setCropDialog(null); }}
          onSave={handleSaveCrop}
        />
      )}

      {imageImport && <ImageImportDialog title={imageImport.kind === "cover" ? "Upload portrait card cover" : "Upload gallery image"} crop="none" preserveOriginal maxFiles={1} maxBytes={Infinity} accept="image/jpeg,image/png,image/gif,image/webp" onImport={async (files, context) => {
        const file = files[0]; if (!file) return;
        if (imageImport.kind === "cover") await handleCoverUpload(file, context, imageImport.target);
        else await handleGalleryUpload(file, context, imageImport.target);
      }} onClose={() => { imageImport.target.cancel(); activeUpload.current = null; setImageImport(null); setUploadingCover(false); setUploadingGallery(false); }} />}

      {coverPickerTarget && (serverWorldId || useEditorStore.getState().serverWorldId) && (
        <AssetPicker
          worldId={(serverWorldId || useEditorStore.getState().serverWorldId)!}
          filterType="image"
          onSelect={(ref) => {
            void handleCoverFromAsset(ref, coverPickerTarget);
            setCoverPickerTarget(null);
          }}
          onClose={() => { coverPickerTarget.cancel(); setCoverPickerTarget(null); }}
        />
      )}

      {galleryPickerTarget && (serverWorldId || useEditorStore.getState().serverWorldId) && (
        <AssetPicker
          worldId={(serverWorldId || useEditorStore.getState().serverWorldId)!}
          filterType="image"
          onSelect={(ref) => {
            void handleGalleryFromAsset(ref, galleryPickerTarget);
            setGalleryPickerTarget(null);
          }}
          onClose={() => { galleryPickerTarget.cancel(); setGalleryPickerTarget(null); }}
        />
      )}
    </div>
  );
}
