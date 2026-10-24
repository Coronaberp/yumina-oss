import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImagePlus, Plus, Search, Upload, UserRound } from "lucide-react";
import { Select } from "@/components/ui/select";
import { ImageLightbox, type PreviewImage } from "@/components/image-lightbox";
import { useEditorStore } from "@/stores/editor";
import { uploadAssetWithPresignedUrl } from "@/lib/asset-upload";
import { resolveImageUrl } from "@/lib/asset-url";
import { useSession } from "@/lib/auth-client";
import type { Asset } from "@/stores/assets";
import { AssetPicker } from "../asset-picker";
import { interfaceKey } from "../lib/interface-presets";
import { assignVnSprite, readVnSpriteInventory, readVnSpriteOutfit, removeVnSprite, vnCharacterNames, writeVnSpriteWardrobeDescription, VN_SPRITE_EMOTION_WARNING } from "../lib/vn-assets";
import { runSpriteImport, spriteImportProblems, spriteTargetIsCurrent, suggestSpriteEmotion, type SpriteImportItem, type SpriteTargetSnapshot } from "../lib/sprite-import";
import { ImageImportDialog, type ImageImportContext } from "@/components/image-import-dialog";
import { DebouncedTextarea } from "./debounced-field";
import { SpriteCatalogDialog } from "./sprite-catalog-dialog";
import { SpriteImportDialog } from "./sprite-import-dialog";
import spriteTemplate from "../../../../../../interfaces/vn/sprites.ts?raw";
const apiBase = import.meta.env.VITE_API_URL || "";
const file = "sprites.ts";
const buttonClass = "min-h-11 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";
type SlotTarget = { snapshot: SpriteTargetSnapshot; emotion: string };
export function SpriteManager() {
  const { t } = useTranslation("editor");
  const draft = useEditorStore(s => s.worldDraft);
  const worldId = useEditorStore(s => s.serverWorldId);
  const { data: session, isPending: accountPending } = useSession();
  const ownerId = session?.user.id ?? "";
  const ownerRef = useRef(ownerId);
  ownerRef.current = ownerId;
  const readOnly = useEditorStore(s => s.editingLocked || s.readOnlyInspect || s.guestMode);
  const root = draft.rootComponent;
  const source = root?.files[file] ?? spriteTemplate;
  const data = useMemo(() => {
    try { return { ...readVnSpriteInventory(source, draft.entries), error: "" }; }
    catch (error) { return { ...readVnSpriteInventory('export const sprites = {};'), error: error instanceof Error ? error.message : String(error) }; }
  }, [source, draft.entries]);
  const characters = data.characters;
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [newCharacter, setNewCharacter] = useState("");
  const [selectedCharacter, setSelectedCharacter] = useState("");
  const character = characters.includes(selectedCharacter) ? selectedCharacter : characters[0] ?? "";
  const [selectedType, setSelectedType] = useState("normal");
  const spriteType = Object.hasOwn(data.config.types, selectedType) ? selectedType : "normal";
  const [selectedVariant, setSelectedVariant] = useState("");
  const spriteVariant = selectedVariant && Object.hasOwn(data.variants[spriteType] ?? {}, selectedVariant) ? selectedVariant : "";
  const variantRef = useRef(spriteVariant);
  variantRef.current = spriteVariant;
  const slots = data.rows.filter(row => row.name.toLowerCase() === character.toLowerCase() && row.spriteType === spriteType && (row.spriteVariant ?? "") === spriteVariant);
  const outfit = useMemo(() => { try { return readVnSpriteOutfit(source, character, spriteType, spriteVariant); } catch { return { expressions: {}, description: "", defaultEmotion: undefined }; } }, [source, character, spriteType, spriteVariant]);
  const outfitKey = JSON.stringify([draft.id, root?.id, character, spriteType, spriteVariant]);
  const [pendingExpressions, setPendingExpressions] = useState<Record<string, string[]>>({});
  const [addingExpression, setAddingExpression] = useState(false);
  const shownEmotions = [...new Set(["normal", ...slots.map(row => row.variant), ...(pendingExpressions[outfitKey] ?? [])])].filter(id => Object.hasOwn(data.config.emotions, id));
  const availableEmotions = Object.entries(data.config.emotions).filter(([id]) => !shownEmotions.includes(id));
  const occupied = new Set(slots.map(row => row.variant));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState(0);
  const [catalog, setCatalog] = useState(false);
  const [picker, setPicker] = useState<SlotTarget | null>(null);
  const [imageImport, setImageImport] = useState<{ target: SpriteTargetSnapshot; emotion?: string; files?: File[] } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SlotTarget | null>(null);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  const [review, setReview] = useState<{ target: SpriteTargetSnapshot; rows: SpriteImportItem[] } | null>(null);
  const reviewRef = useRef(review);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { controller.current?.abort(); }, [ownerId, worldId]);
  const locked = readOnly || busy || !!imageImport || !!picker || !!review || !!data.error || !root;
  const canUpload = !locked && !accountPending && !!ownerId && !!character && !!worldId;
  function snapshot(): SpriteTargetSnapshot | null {
    const state = useEditorStore.getState(), current = state.worldDraft.rootComponent;
    if (!current || !ownerRef.current || state.worldDraft.id !== draft.id || current.id !== root?.id || interfaceKey(current) !== interfaceKey(root!) || state.editingLocked || state.readOnlyInspect || state.guestMode || busyRef.current || data.error) return null;
    return { draftId: state.worldDraft.id, rootId: current.id, interfaceId: interfaceKey(current), source: current.files[file] ?? spriteTemplate, character, spriteType, spriteVariant, ownerId: ownerRef.current, serverWorldId: state.serverWorldId ?? "" };
  }
  function isCurrent(target: SpriteTargetSnapshot) {
    const state = useEditorStore.getState(), current = state.worldDraft.rootComponent;
    return alive.current && spriteTargetIsCurrent(target, current ? { draftId: state.worldDraft.id, rootId: current.id, interfaceId: interfaceKey(current), source: current.files[file] ?? spriteTemplate, spriteVariant: variantRef.current, ownerId: ownerRef.current, serverWorldId: state.serverWorldId ?? "" } : null, state.editingLocked || state.readOnlyInspect || state.guestMode);
  }
  function write(change: (source: string) => string, target: SpriteTargetSnapshot | null = snapshot()) {
    if (!target || !isCurrent(target)) { if (alive.current) setError(t("visualNovel.assignmentChanged")); return false; }
    try {
      const state = useEditorStore.getState(), current = state.worldDraft.rootComponent!;
      const nextSource = change(target.source);
      state.updateRootComponent({ files: { ...current.files, [file]: nextSource } });
      target.source = nextSource;
      setError(""); return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : t("visualNovel.codeManaged")); return false; }
  }
  function assign(target: SlotTarget, assetRef: string) {
    return write(value => assignVnSprite(value, target.snapshot.character, target.snapshot.spriteType, target.emotion, assetRef, target.snapshot.spriteVariant), target.snapshot);
  }
  async function uploadImage(image: File, onProgress: (value: number) => void, target: SpriteTargetSnapshot, context?: ImageImportContext) {
    if (!worldId || !isCurrent(target)) throw Error(t("visualNovel.assignmentChanged"));
    const asset = await uploadAssetWithPresignedUrl<Asset>({ file: image, preferredType: "image", prepareUrl: `${apiBase}/api/worlds/${worldId}/assets/upload-url`, registerUrl: `${apiBase}/api/worlds/${worldId}/assets`, registerBody: ({ key, contentType }) => ({ key, filename: image.name, type: "image", mimeType: contentType, sizeBytes: image.size }), fetchImpl: (input, init) => { if (!isCurrent(target)) throw Error(t("visualNovel.assignmentChanged")); return fetch(input, init); }, signal: controller.current?.signal, onProgress: value => { if (alive.current && !controller.current?.signal.aborted) { onProgress(Math.round(value.fraction * 100)); context?.onProgress(value); } } });
    return `@asset:${asset.id}`;
  }
  async function uploadSingle(image: File, target: SlotTarget, context: ImageImportContext) {
    if (busyRef.current || !isCurrent(target.snapshot)) throw Error(t("visualNovel.assignmentChanged"));
    busyRef.current = true; setBusy(true); setProgress(0); setError("");
    const abort = new AbortController(); controller.current = abort;
    const cancel = () => abort.abort();
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();
    try {
      abort.signal.throwIfAborted();
      const assetRef = await uploadImage(image, setProgress, target.snapshot, context);
      abort.signal.throwIfAborted();
      if (!assign(target, assetRef)) throw Error(t("visualNovel.assignmentChanged"));
    } catch (failure) {
      if (alive.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : t("visualNovel.uploadFailed"));
      throw failure;
    } finally {
      context.signal.removeEventListener("abort", cancel);
      busyRef.current = false; if (alive.current) setBusy(false);
    }
  }
  function beginReview(images: File[], target: SpriteTargetSnapshot | null = snapshot()) {
    if (!target || !isCurrent(target) || busyRef.current || !images.length) return;
    const next = { target, rows: images.map(image => ({ id: crypto.randomUUID(), file: image, emotion: suggestSpriteEmotion(image.name, data.config.emotions), replace: false, status: "queued" as const, progress: 0 })) };
    reviewRef.current = next; setReview(next); setError("");
  }
  function updateRow(id: string, patch: Partial<SpriteImportItem> | null) {
    const current = reviewRef.current; if (!current || !alive.current) return;
    const next = { ...current, rows: patch ? current.rows.map(row => row.id === id ? { ...row, ...patch } : row) : current.rows.filter(row => row.id !== id) };
    reviewRef.current = next; setReview(next);
  }
  async function startImport() {
    const current = reviewRef.current;
    if (!current || busyRef.current || !isCurrent(current.target) || Object.keys(spriteImportProblems(current.rows, data.config.emotions, occupied)).length) return;
    busyRef.current = true; setBusy(true); controller.current = new AbortController();
    await runSpriteImport(current.rows, {
      isCurrent: () => isCurrent(current.target),
      upload: (row, update) => uploadImage(row.file, update, current.target),
      assign: (row, assetRef) => { if (!assign({ snapshot: current.target, emotion: row.emotion }, assetRef)) throw Error(t("visualNovel.assignmentChanged")); },
      update: updateRow,
      staleMessage: t("spriteManager.staleQueue"),
    });
    busyRef.current = false; if (alive.current) setBusy(false);
  }
  const setTarget = (emotion: string, action: "upload" | "library") => {
    const target = snapshot(); if (!target) return;
    const slot = { snapshot: target, emotion };
    if (action === "library") setPicker(slot);
    else setImageImport({ target, emotion });
  };
  const selectionLocked = busy || !!imageImport || !!picker || !!review;
  const filteredCharacters = characters.filter(value => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const outfitDescription = outfit.description;
  function addCharacter() {
    const name = newCharacter.trim();
    if (locked || !name || name.length > 200) return;
    if (["__proto__", "constructor", "prototype"].includes(name)) { setError(t("spriteManager.invalidName")); return; }
    const existing = characters.find(value => value.toLowerCase() === name.toLowerCase());
    if (existing) { setSelectedCharacter(existing); setQuery(""); setAdding(false); return; }
    const state = useEditorStore.getState();
    if (state.editingLocked || state.readOnlyInspect || state.guestMode || state.worldDraft.id !== draft.id) return;
    state.addEntry("character", "system-presets");
    const created = useEditorStore.getState().worldDraft.entries.at(-1);
    if (created) state.updateEntry(created.id, { name, tags: ["Character"], alwaysSend: true });
    setSelectedCharacter(name); setQuery(""); setNewCharacter(""); setAdding(false);
  }
  return <section aria-label={t("spriteManager.collection")} className="grid min-w-0 gap-5 xl:grid-cols-[minmax(180px,220px)_minmax(0,1fr)]">
    <aside className="min-w-0 space-y-3 xl:border-r xl:border-border xl:pr-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t("visualNovel.characters")} <span className="font-normal text-muted-foreground">{characters.length}</span></h2>
        <button type="button" aria-label={t("spriteManager.addCharacter")} disabled={locked} onClick={() => setAdding(value => !value)} className={`${buttonClass} flex items-center gap-1.5`}><Plus className="h-4 w-4" />{t("spriteManager.add")}</button>
      </div>
      {adding && <form className="space-y-2 rounded-lg border border-border bg-card p-3" onSubmit={event => { event.preventDefault(); addCharacter(); }}>
        <label className="block space-y-1.5 text-xs text-muted-foreground"><span>{t("spriteManager.characterName")}</span><input autoFocus value={newCharacter} maxLength={200} disabled={locked} onChange={event => setNewCharacter(event.target.value)} className="min-h-11 w-full min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary" /></label>
        <div className="flex flex-wrap gap-2"><button type="submit" disabled={locked || !newCharacter.trim()} className={buttonClass}>{t("spriteManager.addCharacter")}</button><button type="button" className={buttonClass} onClick={() => setAdding(false)}>{t("spriteManager.cancel")}</button></div>
      </form>}
      <label className="flex min-h-11 items-center gap-2 rounded-lg border border-border bg-background px-3 focus-within:ring-2 focus-within:ring-primary"><Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" /><input aria-label={t("spriteManager.searchCharacters")} placeholder={t("spriteManager.searchCharacters")} value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-foreground outline-none" /></label>
      <div role="group" aria-label={t("spriteManager.selectCharacter")} className="flex gap-2 overflow-x-auto pb-1 xl:max-h-[65dvh] xl:flex-col xl:overflow-y-auto xl:overflow-x-hidden">
        {filteredCharacters.map(name => {
          const images = data.rows.filter(row => row.name.toLowerCase() === name.toLowerCase());
          const portrait = draft.entries.find(entry => vnCharacterNames([entry]).some(value => value.toLowerCase() === name.toLowerCase()))?.portrait;
          const image = portrait || images.find(row => row.variant === "normal" && row.spriteType === "normal")?.assetRef || images[0]?.assetRef;
          return <button key={name} type="button" aria-pressed={character === name} disabled={selectionLocked} onClick={() => { setSelectedCharacter(name); setRemoveTarget(null); }} className={`flex min-h-16 w-48 shrink-0 items-center gap-3 rounded-lg border p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40 xl:w-full ${character === name ? "border-primary/50 bg-primary/10" : "border-border bg-card hover:bg-accent"}`}>
            <span className="flex h-12 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-background">{image ? <img src={resolveImageUrl(image)} alt="" loading="lazy" className={`h-full w-full ${portrait ? "object-cover" : "object-contain object-top"}`} /> : <UserRound aria-hidden="true" className="h-5 w-5 text-muted-foreground" />}</span>
            <span className="min-w-0"><span className="block truncate text-sm font-medium text-foreground" title={name}>{name}</span><span className="mt-0.5 block text-xs text-muted-foreground">{t("spriteManager.assignments", { count: images.length })}</span></span>
          </button>;
        })}
      </div>
      {!filteredCharacters.length && characters.length > 0 && <p className="text-xs text-muted-foreground">{t("spriteManager.noMatches")}</p>}
    </aside>
    <div className="min-w-0 space-y-4">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0"><h2 className="break-words text-lg font-semibold text-foreground">{character || t("spriteManager.selectCharacter")}</h2><p className="mt-1 text-xs text-muted-foreground">{t("spriteManager.characterHint")}</p></div>
      <button type="button" disabled={locked} onClick={() => { setError(""); setCatalog(true); }} className={buttonClass}>{t("spriteManager.manage")}</button>
    </div>
    {Object.keys(data.config.emotions).length >= VN_SPRITE_EMOTION_WARNING && <p role="status" className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs text-foreground">{t("spriteManager.emotionWarning")}</p>}
    {data.error && <p role="alert" className="break-words rounded-lg border border-border p-3 text-sm text-muted-foreground">{t("visualNovel.codeManaged")} {data.error}</p>}
    {!characters.length && <p className="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">{t("spriteManager.noCharacters")}</p>}
    {!!character && <>
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <label className="block max-w-sm space-y-1.5 text-xs font-medium text-muted-foreground"><span>{t("spriteManager.wardrobe")}</span><Select browseOnly aria-label={t("spriteManager.wardrobe")} value={spriteType} disabled={selectionLocked} onValueChange={value => { setSelectedType(value); setSelectedVariant(""); setAddingExpression(false); setRemoveTarget(null); }} options={Object.entries(data.config.types).map(([value, label]) => ({ value, label }))} /></label>

        {!!Object.keys(data.variants[spriteType] ?? {}).length && <label className="block max-w-sm space-y-1.5 text-xs font-medium text-muted-foreground"><span>{t("spriteManager.outfitVariant")}</span><Select browseOnly aria-label={t("spriteManager.outfitVariant")} value={spriteVariant} disabled={selectionLocked} onValueChange={value => { setSelectedVariant(value); setAddingExpression(false); setRemoveTarget(null); }} options={[{ value: "", label: t("spriteManager.baseVariant") }, ...Object.entries(data.variants[spriteType] ?? {}).map(([value, label]) => ({ value, label: label.trim().toLocaleLowerCase() === t("spriteManager.baseVariant").trim().toLocaleLowerCase() ? `${label} (${value})` : label }))]} /></label>}
        <label className="block space-y-1.5 text-xs font-medium text-muted-foreground"><span>{t("spriteManager.outfitDescription")}</span>
          <DebouncedTextarea key={outfitKey} value={outfitDescription} disabled={locked} maxLength={2000} rows={3} placeholder={t("spriteManager.outfitPlaceholder")} onCommit={description => {
            const current = snapshot();
            if (current) write(value => writeVnSpriteWardrobeDescription(value, character, spriteType, description, spriteVariant), current);
          }} className="min-h-24 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm font-normal text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40" />
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("spriteManager.outfitHint", { character, type: [data.config.types[spriteType], spriteVariant && data.variants[spriteType]?.[spriteVariant]].filter(Boolean).join(" / ") })}</p>
      </div>
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed p-4 ${dragging ? "border-primary bg-primary/10" : "border-border bg-card"}`} onDragOver={event => { if (!Array.from(event.dataTransfer.types).includes("Files")) return; event.preventDefault(); event.stopPropagation(); if (canUpload) setDragging(true); }} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); if (canUpload) { const target = snapshot(); if (target) setImageImport({ target, files: Array.from(event.dataTransfer.files) }); } }}>
        <div className="min-w-0"><p className="text-sm font-medium text-foreground">{t("spriteManager.imageCount", { count: slots.length })}</p><p className="mt-1 text-xs text-muted-foreground">{t("spriteManager.dropHint")}</p></div>
        <button type="button" disabled={!canUpload} onClick={() => { const target = snapshot(); if (target) setImageImport({ target }); }} className={`${buttonClass} flex items-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90`}><Upload className="h-4 w-4" />{t("spriteManager.importImages")}</button>
      </div>
      <p className="text-xs text-muted-foreground">{t("spriteManager.optionalExpressionsHint")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={locked || !availableEmotions.length} onClick={() => setAddingExpression(value => !value)} className={buttonClass}><Plus className="mr-1 inline h-4 w-4" />{t("spriteManager.addExpression")}</button>
        {addingExpression && <div className="w-full max-w-sm"><Select aria-label={t("spriteManager.chooseExpression")} value="" disabled={locked} placeholder={t("spriteManager.chooseExpression")} options={availableEmotions.map(([value, label]) => ({ value, label }))} onValueChange={value => { setPendingExpressions(previous => ({ ...previous, [outfitKey]: [...(previous[outfitKey] ?? []), value] })); setAddingExpression(false); }} /></div>}
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-4">
        {shownEmotions.map(emotion => {
          const label = data.config.emotions[emotion];
          const assetRef = slots.find(row => row.variant === emotion)?.assetRef;
          return <article key={emotion} className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
            {assetRef ? <button type="button" aria-label={t("spriteManager.preview", { emotion: label })} onClick={() => { const src = resolveImageUrl(assetRef); if (src) setPreview({ src, alt: `${character} — ${data.config.types[spriteType]} — ${label}` }); }} className="flex h-44 w-full cursor-zoom-in items-end justify-center bg-background p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:h-52"><img src={resolveImageUrl(assetRef)} alt={`${character} — ${label}`} loading="lazy" className="h-full max-w-full object-contain" /></button> : <div className="flex h-44 items-center justify-center bg-background p-3 text-center text-xs text-muted-foreground sm:h-52">{t("spriteManager.emptySlot")}</div>}
            <div className="space-y-2 p-3"><p className="break-words text-sm font-medium text-foreground">{label}</p><div className="flex flex-wrap gap-1.5">
              <button type="button" disabled={!canUpload} onClick={() => setTarget(emotion, "upload")} className={buttonClass}>{t(assetRef ? "spriteManager.replace" : "spriteManager.upload")}</button>
              <button type="button" aria-label={t("spriteManager.libraryFor", { emotion: label })} disabled={!canUpload} onClick={() => setTarget(emotion, "library")} className={`${buttonClass} flex items-center gap-1.5`}><ImagePlus className="h-3.5 w-3.5" />{t("spriteManager.library")}</button>
              {assetRef && <button type="button" disabled={locked} onClick={() => { const target = snapshot(); if (target) setRemoveTarget({ snapshot: target, emotion }); }} className={`${buttonClass} text-destructive`}>{t("spriteManager.remove")}</button>}
            </div>
            {removeTarget?.emotion === emotion && <div className="space-y-2 rounded-lg bg-background p-2"><p className="text-xs text-muted-foreground">{t("spriteManager.removeSlotHint")}</p><button type="button" disabled={locked} className={`${buttonClass} text-destructive`} onClick={() => { if (write(value => removeVnSprite(value, removeTarget.snapshot.character, removeTarget.snapshot.spriteType, emotion, removeTarget.snapshot.spriteVariant), removeTarget.snapshot)) setRemoveTarget(null); }}>{t("spriteManager.confirm")}</button><button type="button" onClick={() => setRemoveTarget(null)} className={buttonClass}>{t("spriteManager.cancel")}</button></div>}
            </div>
          </article>;
        })}
      </div>
    </>}
    {busy && !review && <p role="status" className="text-sm text-muted-foreground">{t("visualNovel.uploading", { percent: progress })}</p>}
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    <p className="text-xs text-muted-foreground">{t(worldId ? "visualNovel.saveHint" : "visualNovel.saveFirst")}</p>
    </div>
    {catalog && <SpriteCatalogDialog error={error} config={data.config} variants={data.variants} variantUsage={(type, id) => data.rows.filter(row => row.spriteType === type && row.spriteVariant === id).length} disabled={locked} onWrite={change => write(change)} usage={(kind, id) => data.rows.filter(row => kind === "types" ? row.spriteType === id : row.variant === id).length} onClose={() => setCatalog(false)} />}
    {picker && worldId && <AssetPicker worldId={worldId} filterType="image" onClose={() => setPicker(null)} onSelect={assetRef => { assign(picker, assetRef); setPicker(null); }} />}
    {imageImport && <ImageImportDialog multiple={!imageImport.emotion} initialFiles={imageImport.files} onClose={() => { controller.current?.abort(); setImageImport(null); }} onImport={async (images, context) => {
      context.signal.throwIfAborted();
      if (!isCurrent(imageImport.target)) throw Error(t("visualNovel.assignmentChanged"));
      if (imageImport.emotion) await uploadSingle(images[0]!, { snapshot: imageImport.target, emotion: imageImport.emotion }, context);
      else beginReview(images, imageImport.target);
    }} />}
    {review && <SpriteImportDialog rows={review.rows} emotions={data.config.emotions} occupied={occupied} character={review.target.character} typeLabel={data.config.types[review.target.spriteType] ?? review.target.spriteType} variantLabel={data.variants[review.target.spriteType]?.[review.target.spriteVariant ?? ""]} busy={busy} blocked={!isCurrent(review.target)} onChange={updateRow} onStart={() => void startImport()} onClose={() => { reviewRef.current = null; setReview(null); }} />}
    <ImageLightbox image={preview} onClose={() => setPreview(null)} />
  </section>;
}
