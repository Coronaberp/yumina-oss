import { Select } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GripVertical, ImagePlus, Loader2, Search, Trash2, Upload } from "lucide-react";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, rectSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { displayCharacterName } from "@yumina/engine";
import { ImageLightbox, type PreviewImage } from "@/components/image-lightbox";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { useEditorStore } from "@/stores/editor";
import { uploadAssetWithPresignedUrl } from "@/lib/asset-upload";
import { resolveImageUrl } from "@/lib/asset-url";
import { useSession } from "@/lib/auth-client";
import type { Asset } from "@/stores/assets";
import { AssetPicker } from "../asset-picker";
import { AssetSuggestionInput } from "../components/asset-suggestion-input";
import { ImageImportDialog, type ImageImportContext } from "@/components/image-import-dialog";
import { SpriteManager } from "../components/sprite-manager";
import { interfaceKey } from "../lib/interface-presets";
import { assignVnAsset, assignVnNpcSprite, readVnAssetMap, readVnNpcSpritePools, removeVnAsset, removeVnNpcSprite, vnAssetFile, vnAssetRows, vnCharacterNames, writeVnAssetMap, writeVnNpcSpritePools, type NpcSpriteGender, type VnAssetKind, type VnAssetMap, type VnAssetRow } from "../lib/vn-assets";
import { readVnNpcDefaults, readVnNpcDefaultSpritePools, writeVnNpcDefaults, type VnNpcDefaults } from "../lib/vn-assets";
import { VN_ASSET_ORDER_FILE, vnAssetRowId, readVnAssetOrders, orderedVnAssetRows, reorderVnAssetRows, readVnOpeningScenes, writeVnOpeningScenes } from "../lib/vn-assets";
import spriteTemplate from "../../../../../../interfaces/vn/sprites.ts?raw";
import sceneTemplate from "../../../../../../interfaces/vn/scenes.ts?raw";

const apiBase = import.meta.env.VITE_API_URL || "";

function SpriteCharacterAvatar({ name, assetRef, portraitRef }: { name: string; assetRef: string; portraitRef?: string | null }) {
  const [portraitFailed, setPortraitFailed] = useState(false);
  const [spriteFailed, setSpriteFailed] = useState(false);
  const showingPortrait = !!portraitRef && !portraitFailed;
  const imageRef = showingPortrait ? portraitRef : assetRef;
  return <Avatar className="h-8 w-8 border border-border bg-background" aria-hidden="true">
    {!showingPortrait && spriteFailed ? <AvatarFallback className="bg-background text-xs text-muted-foreground">{name.trim().slice(0, 1)}</AvatarFallback>
      : <img src={resolveImageUrl(imageRef)} alt="" decoding="async" onError={() => showingPortrait ? setPortraitFailed(true) : setSpriteFailed(true)}
        className={showingPortrait ? "h-full w-full object-cover" : "absolute left-1/2 top-[-35%] h-auto w-[250%] max-w-none -translate-x-1/2"} />}
  </Avatar>;
}

function SortableVnAssetCard({ row, kind, npcGender, index, disabled, sortDisabled, isDefault, onPreview, onRemove, onDefault, onUpload, onLibrary }: {
  row: VnAssetRow; kind: VnAssetKind; npcGender: NpcSpriteGender | null; index: number;
  disabled: boolean; sortDisabled: boolean; isDefault: boolean;
  onPreview: (image: PreviewImage) => void; onRemove: () => void; onDefault: () => void;
  onUpload: () => void; onLibrary: () => void;
}) {
  const { t } = useTranslation("editor");
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: vnAssetRowId(row), disabled: sortDisabled });
  const name = npcGender ? t(`visualNovel.${npcGender}Npcs`) : row.name;
  const variant = npcGender ? t("visualNovel.npcSpriteNumber", { number: index + 1 }) : row.variant;
  const label = `${name} — ${variant}`;
  return <article ref={setNodeRef} data-vn-asset-id={vnAssetRowId(row)} data-npc-pool={npcGender ? "custom" : undefined}
    style={{ transform: CSS.Transform.toString(transform), transition }}
    className={`relative overflow-hidden rounded-xl border bg-card ${isDragging ? "z-10 border-primary opacity-80 shadow-lg" : "border-border"}`}>
    <button type="button" aria-haspopup="dialog" onClick={() => { const src = resolveImageUrl(row.assetRef); if (src) onPreview({ src, alt: label }); }}
      className={`w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${kind === "sprites" ? "flex h-48 items-end justify-center bg-background p-3" : "block h-40 bg-background"}`}>
      <img src={resolveImageUrl(row.assetRef)} alt={label} draggable={false} className={kind === "sprites" ? "h-full max-w-full object-contain" : "h-full w-full object-cover"} />
    </button>
    <div className="space-y-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><p className="break-words text-sm font-medium text-foreground">{name}</p><p className="text-xs text-muted-foreground">{variant}</p></div>
        <div className="flex shrink-0 items-center">
          {!sortDisabled && <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} aria-label={t("visualNovel.move", { name, variant })} title={t("visualNovel.move", { name, variant })}
            className="flex h-11 w-11 touch-none cursor-grab items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:cursor-grabbing"><GripVertical className="h-4 w-4" /></button>}
          <button type="button" disabled={disabled} onClick={onRemove} aria-label={t("visualNovel.remove", { name, variant: npcGender ? index + 1 : variant })} className="flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-destructive disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={disabled} onClick={onUpload} className="min-h-11 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40">{t("spriteManager.replace")}</button>
        <button type="button" disabled={disabled} onClick={onLibrary} className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40"><ImagePlus className="h-3.5 w-3.5" />{t("spriteManager.library")}</button>
        {kind === "backgrounds" && <button type="button" disabled={disabled || isDefault} onClick={onDefault} className="min-h-11 rounded-lg px-2 text-xs text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:text-muted-foreground">{t(isDefault ? "visualNovel.defaultBackground" : "visualNovel.setDefault")}</button>}
      </div>
    </div>
  </article>;
}

function VnAssetSection({ kind }: { kind: VnAssetKind }) {
  const { t } = useTranslation("editor");
  const root = useEditorStore(s => s.worldDraft.rootComponent);
  const worldId = useEditorStore(s => s.serverWorldId);
  const { data: session, isPending: accountPending } = useSession();
  const ownerId = session?.user.id ?? "";
  const ownerRef = useRef(ownerId);
  ownerRef.current = ownerId;
  const draftId = useEditorStore(s => s.worldDraft.id);
  const entries = useEditorStore(s => s.worldDraft.entries);
  const readOnly = useEditorStore(s => s.editingLocked || s.readOnlyInspect || s.guestMode);
  const updateRootComponent = useEditorStore(s => s.updateRootComponent);
  const [backgroundScope, setBackgroundScope] = useState("");
  const openings = entries.filter(entry => entry.role === "greeting").sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  const openingId = kind === "backgrounds" && openings.some(entry => entry.id === backgroundScope) ? backgroundScope : "";
  const file = vnAssetFile(kind);
  const source = root?.files[file] ?? (kind === "sprites" ? spriteTemplate : sceneTemplate);
  const configuration = useMemo(() => {
    try { return { map: openingId ? readVnOpeningScenes(source)[openingId] ?? {} : readVnAssetMap(source, kind), error: false }; }
    catch { return { map: {} as VnAssetMap, error: true }; }
  }, [source, kind, openingId]);
  const npcConfiguration = useMemo(() => {
    try { return { pools: readVnNpcSpritePools(source), error: false }; }
    catch { return { pools: { male: {}, female: {} }, error: true }; }
  }, [source]);
  const [spriteTarget, setSpriteTarget] = useState<"character" | NpcSpriteGender>("character");
  const npcGender = kind === "sprites" && spriteTarget !== "character" ? spriteTarget : null;
  const npcSupported = /export\s+function\s+npcSpriteFor\s*\(/.test(source);
  const defaultsSupported = /export\s+function\s+npcSpriteSelection\s*\(/.test(source);
  const defaultConfiguration = useMemo(() => {
    try { return { settings: readVnNpcDefaults(source), pools: { a: readVnNpcDefaultSpritePools(source, "a"), b: readVnNpcDefaultSpritePools(source, "b") }, error: false }; }
    catch { return { settings: { disabled: false, mode: "a" } as VnNpcDefaults, pools: { a: { male: {}, female: {} }, b: { male: {}, female: {} } }, error: true }; }
  }, [source]);
  const configurationError = npcGender ? npcConfiguration.error : configuration.error;
  const rawRows: VnAssetRow[] = npcGender
    ? Object.entries(npcConfiguration.pools[npcGender]).map(([id, assetRef]) => ({ name: npcGender, variant: id, assetRef }))
    : vnAssetRows(configuration.map, kind);
  const orderSource = root?.files[VN_ASSET_ORDER_FILE];
  const orderConfiguration = useMemo(() => {
    try { return { orders: readVnAssetOrders(orderSource), error: false }; }
    catch { return { orders: {}, error: true }; }
  }, [orderSource]);
  const orderScope = kind === "sprites" ? `sprites:${npcGender ?? "character"}` : openingId ? `backgrounds:opening:${openingId}` : "backgrounds:global";
  const rows = orderedVnAssetRows(rawRows, orderConfiguration.orders[orderScope]);
  const spriteCharacters = useMemo(() => Object.entries(configuration.map).flatMap(([name, expressions]) => {
    const assetRef = typeof expressions === "string" ? expressions : expressions.normal || Object.values(expressions).find(Boolean);
    const portraitRef = entries.find(entry => vnCharacterNames([entry]).includes(displayCharacterName(name)))?.portrait;
    return assetRef ? [{ name, assetRef, portraitRef }] : [];
  }), [configuration.map, entries]);
  const [characterFilter, setCharacterFilter] = useState<string | null>(null);
  const [sceneQuery, setSceneQuery] = useState("");
  const [backgroundFormOpen, setBackgroundFormOpen] = useState(false);
  const activeCharacterFilter = kind === "sprites" && !npcGender && spriteCharacters.some(character => character.name === characterFilter) ? characterFilter : null;
  const visibleRows = rows.filter(row => (activeCharacterFilter === null || row.name === activeCharacterFilter) && (kind !== "backgrounds" || `${row.name} ${row.variant}`.toLocaleLowerCase().includes(sceneQuery.trim().toLocaleLowerCase())));
  const defaultRows = npcGender && defaultsSupported && !defaultConfiguration.error && !defaultConfiguration.settings.disabled
    ? Object.entries(defaultConfiguration.pools[defaultConfiguration.settings.mode][npcGender]) : [];
  const characters = vnCharacterNames(entries);
  const [name, setName] = useState(kind === "sprites" ? characters[0] ?? "" : "opening");
  const [variant, setVariant] = useState(kind === "sprites" ? "normal" : "day");
  const [makeDefault, setMakeDefault] = useState(!configuration.map.default);
  const makeDefaultId = useId();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [picker, setPicker] = useState<NonNullable<ReturnType<typeof prepareAssignment>> | null>(null);
  const [dragging, setDragging] = useState(false);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const [imageImport, setImageImport] = useState<{ snapshot: NonNullable<ReturnType<typeof prepareAssignment>>; files?: File[] } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  useEffect(() => { setMakeDefault(!configuration.map.default); }, [openingId, configuration.map.default]);
  useEffect(() => { controller.current?.abort(); }, [ownerId, worldId]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controller.current?.abort(); };
  }, []);

  const commit = (map: VnAssetMap) => {
    if (readOnly) return;
    const state = useEditorStore.getState();
    const currentRoot = state.worldDraft.rootComponent;
    if (state.editingLocked || state.readOnlyInspect || state.guestMode || state.worldDraft.id !== draftId || !root || !currentRoot || currentRoot.id !== root.id || interfaceKey(currentRoot) !== interfaceKey(root) || (currentRoot.files[file] ?? (kind === "sprites" ? spriteTemplate : sceneTemplate)) !== source) { setError(t("visualNovel.settingsChanged")); return; }
    try {
      updateRootComponent({ files: { ...currentRoot.files, [file]: openingId ? writeVnOpeningScenes(source, openingId, map, sceneTemplate) : writeVnAssetMap(source, kind, map) } });
      setError("");
    } catch { setError(t("visualNovel.codeManaged")); }
  };

  const prepareAssignment = (row?: VnAssetRow) => {
    const state = useEditorStore.getState();
    const targetName = row?.name ?? name.trim(), targetVariant = row?.variant ?? (npcGender ? crypto.randomUUID() : variant.trim());
    const current = state.worldDraft.rootComponent;
    if (!ownerRef.current || state.editingLocked || state.readOnlyInspect || state.guestMode || (!npcGender && (!targetName || !targetVariant)) || configurationError || (npcGender && !npcSupported) || !current) return null;
    if (state.worldDraft.id !== draftId || current.id !== root?.id || interfaceKey(current) !== interfaceKey(root!) || (current.files[file] ?? (kind === "sprites" ? spriteTemplate : sceneTemplate)) !== source) { setError(t("visualNovel.assignmentChanged")); return null; }
    if (kind === "backgrounds" && targetName.toLowerCase() === "default") { setError(t("visualNovel.reservedScene")); return null; }
    return { worldId: state.worldDraft.id, serverWorldId: state.serverWorldId, ownerId: ownerRef.current, rootId: current.id, interfaceId: interfaceKey(current), source: current.files[file], name: targetName, variant: targetVariant, makeDefault: row ? configuration.map.default === row.assetRef : makeDefault, npcGender, openingId };
  };

  const assignmentIsCurrent = (snapshot: NonNullable<ReturnType<typeof prepareAssignment>>) => {
    const state = useEditorStore.getState();
    const currentRoot = state.worldDraft.rootComponent;
    if (!alive.current || ownerRef.current !== snapshot.ownerId || state.serverWorldId !== snapshot.serverWorldId || state.editingLocked || state.readOnlyInspect || state.guestMode || state.worldDraft.id !== snapshot.worldId || !currentRoot || currentRoot.id !== snapshot.rootId || interfaceKey(currentRoot) !== snapshot.interfaceId || currentRoot.files[file] !== snapshot.source) {
      if (alive.current) setError(t("visualNovel.assignmentChanged"));
      return false;
    }
    return true;
  };

  const assign = (assetRef: string, snapshot: NonNullable<ReturnType<typeof prepareAssignment>>) => {
    if (!assignmentIsCurrent(snapshot)) return false;
    const currentRoot = useEditorStore.getState().worldDraft.rootComponent!;
    const currentSource = currentRoot.files[file] ?? (kind === "sprites" ? spriteTemplate : sceneTemplate);
    try {
      let updatedSource: string;
      if (snapshot.npcGender) {
        const pools = assignVnNpcSprite(readVnNpcSpritePools(currentSource), snapshot.npcGender, snapshot.variant, assetRef);
        updatedSource = writeVnNpcSpritePools(currentSource, pools);
      } else {
        const map = assignVnAsset(snapshot.openingId ? readVnOpeningScenes(currentSource)[snapshot.openingId] ?? {} : readVnAssetMap(currentSource, kind), snapshot.name, snapshot.variant, assetRef, kind === "sprites" ? "normal" : "day");
        if (kind === "backgrounds" && snapshot.makeDefault) map.default = assetRef;
        updatedSource = snapshot.openingId ? writeVnOpeningScenes(currentSource, snapshot.openingId, map, sceneTemplate) : writeVnAssetMap(currentSource, kind, map);
      }
      updateRootComponent({ files: { ...currentRoot.files, [file]: updatedSource } });
      setError(""); setPicker(null); setMakeDefault(false); setBackgroundFormOpen(false);
      return true;
    } catch { setError(t("visualNovel.codeManaged")); return false; }
  };

  const upload = async (fileToUpload: File, snapshot: NonNullable<ReturnType<typeof prepareAssignment>>, context: ImageImportContext) => {
    if (busyRef.current || !worldId || !assignmentIsCurrent(snapshot)) throw Error(t("visualNovel.assignmentChanged"));
    busyRef.current = true; setBusy(true); setError(""); setProgress(0);
    const abort = new AbortController(); controller.current = abort;
    const cancel = () => abort.abort();
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();
    try {
      abort.signal.throwIfAborted();
      const asset = await uploadAssetWithPresignedUrl<Asset>({
        file: fileToUpload, preferredType: "image",
        prepareUrl: `${apiBase}/api/worlds/${worldId}/assets/upload-url`,
        registerUrl: `${apiBase}/api/worlds/${worldId}/assets`,
        registerBody: ({ key, contentType }) => ({ key, filename: fileToUpload.name, type: "image", mimeType: contentType, sizeBytes: fileToUpload.size }),
        signal: abort.signal,
        fetchImpl: (input, init) => { if (!assignmentIsCurrent(snapshot)) throw Error(t("visualNovel.assignmentChanged")); return fetch(input, init); },
        onProgress: value => { if (alive.current && !abort.signal.aborted) { setProgress(Math.round(value.fraction * 100)); context.onProgress(value); } },
      });
      abort.signal.throwIfAborted();
      if (!assign(`@asset:${asset.id}`, snapshot)) throw Error(t("visualNovel.assignmentChanged"));
    } catch (failure) {
      if (alive.current && !abort.signal.aborted) setError(failure instanceof Error ? failure.message : t("visualNovel.uploadFailed"));
      throw failure;
    } finally {
      context.signal.removeEventListener("abort", cancel);
      busyRef.current = false; if (alive.current) setBusy(false);
    }
  };

  const remove = (row: VnAssetRow) => {
    if (npcGender) {
      const state = useEditorStore.getState();
      const currentRoot = state.worldDraft.rootComponent;
      if (state.editingLocked || state.readOnlyInspect || state.guestMode) return;
      if (!currentRoot || currentRoot.id !== root?.id || interfaceKey(currentRoot) !== interfaceKey(root!) || (currentRoot.files[file] ?? spriteTemplate) !== source) {
        setError(t("visualNovel.assignmentChanged")); return;
      }
      try {
        const pools = removeVnNpcSprite(readVnNpcSpritePools(source), npcGender, row.variant);
        updateRootComponent({ files: { ...currentRoot.files, [file]: writeVnNpcSpritePools(source, pools) } });
        setError("");
      } catch { setError(t("visualNovel.codeManaged")); }
      return;
    }
    const map = removeVnAsset(configuration.map, row.name, row.variant);
    if (kind === "backgrounds" && map.default === row.assetRef && !vnAssetRows(map, kind).some(item => item.assetRef === row.assetRef)) delete map.default;
    commit(map);
  };
  const disabled = readOnly || busy || !!imageImport || !!picker || configurationError || !!(npcGender && !npcSupported);
  const chooseUpload = (row?: VnAssetRow) => {
    const target = prepareAssignment(row);
    if (!target || disabled || !worldId) return;
    setImageImport({ snapshot: target });
  };
  const chooseLibrary = (row?: VnAssetRow) => {
    const target = prepareAssignment(row);
    if (target && !disabled && worldId) setPicker(target);
  };
  const sortDisabled = disabled || orderConfiguration.error || visibleRows.length < 2;
  const reorder = ({ active, over }: DragEndEvent) => {
    if (sortDisabled || !over || active.id === over.id) return;
    const state = useEditorStore.getState();
    const currentRoot = state.worldDraft.rootComponent;
    if (state.editingLocked || state.readOnlyInspect || state.guestMode || state.worldDraft.id !== draftId || !root || !currentRoot || currentRoot.id !== root.id || interfaceKey(currentRoot) !== interfaceKey(root) || (currentRoot.files[file] ?? (kind === "sprites" ? spriteTemplate : sceneTemplate)) !== source || currentRoot.files[VN_ASSET_ORDER_FILE] !== orderSource) { setError(t("visualNovel.settingsChanged")); return; }
    const moved = reorderVnAssetRows(rows, visibleRows, String(active.id), String(over.id));
    if (moved === rows) return;
    const orders = { ...orderConfiguration.orders, [orderScope]: moved.map(vnAssetRowId) };
    updateRootComponent({ files: { ...currentRoot.files, [VN_ASSET_ORDER_FILE]: JSON.stringify(orders, null, 2) + "\n" } });
    setError("");
  };
  const defaultsDisabled = readOnly || busy || !!imageImport || defaultConfiguration.error;
  const updateDefaults = (patch: Partial<VnNpcDefaults>) => {
    if (defaultsDisabled || !defaultsSupported) return;
    const state = useEditorStore.getState();
    const currentRoot = state.worldDraft.rootComponent;
    if (state.editingLocked || state.readOnlyInspect || state.guestMode || state.worldDraft.id !== draftId || !root || !currentRoot || currentRoot.id !== root.id || interfaceKey(currentRoot) !== interfaceKey(root) || currentRoot.files[file] !== source) { setError(t("visualNovel.assignmentChanged")); return; }
    try {
      const settings = { ...readVnNpcDefaults(source), ...patch };
      updateRootComponent({ files: { ...currentRoot.files, [file]: writeVnNpcDefaults(source, settings) } });
      setError("");
    } catch { setError(t("visualNovel.codeManaged")); }
  };
  const ready = !disabled && !accountPending && !!ownerId && !!worldId && (!!npcGender || (!!name.trim() && !!variant.trim()));
  const title = t(kind === "sprites" ? "visualNovel.spritesTitle" : "visualNovel.backgroundsTitle");

  return <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 border-b border-border bg-card px-4 py-4 sm:px-6">
      <h1 className="text-[22px] font-bold tracking-tight text-foreground">{title}</h1>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(kind === "sprites" ? "visualNovel.spritesHint" : "visualNovel.backgroundsHint")}</p>
    </div>
    <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6">
      {kind === "sprites" && <div role="group" aria-label={t("visualNovel.spriteTarget")} className="flex flex-wrap gap-2">
        {(["character", "male", "female"] as const).map(target => <button key={target} type="button" aria-pressed={spriteTarget === target} disabled={busy || !!imageImport || !!picker} onClick={() => { setSpriteTarget(target); setError(""); }}
          className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${spriteTarget === target ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}>{t(target === "character" ? "visualNovel.characters" : `visualNovel.${target}Npcs`)}</button>)}
      </div>}
      {kind === "sprites" && !npcGender ? <SpriteManager /> : <>
      {configurationError && <p role="alert" className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">{t("visualNovel.codeManaged")}</p>}
      {npcGender && !npcSupported && <p role="alert" className="text-sm text-muted-foreground">{t("visualNovel.npcUnsupported")}</p>}
      {npcGender && defaultsSupported && <section aria-label={t("visualNovel.npcDefaults")} className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">{t("visualNovel.npcDefaults")}</h2>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <Checkbox  role="switch" checked={defaultConfiguration.settings.disabled} disabled={defaultsDisabled} onCheckedChange={checked => updateDefaults({ disabled: (checked === true) })} className="h-4 w-4 accent-primary" />
            {t("visualNovel.disableNpcDefaults")}
          </label>
        </div>
        <RadioGroup aria-label={t("visualNovel.npcDefaultChoice")} value={defaultConfiguration.settings.mode} disabled={defaultsDisabled || defaultConfiguration.settings.disabled}
          onValueChange={mode => updateDefaults({ mode: mode as "a" | "b" })} className="grid gap-2 sm:grid-cols-2">
          {(["a", "b"] as const).map(mode => <label key={mode} className={`rounded-lg border p-3 text-left focus-within:ring-2 focus-within:ring-primary ${defaultsDisabled || defaultConfiguration.settings.disabled ? "opacity-40" : "cursor-pointer"} ${defaultConfiguration.settings.mode === mode ? "border-primary/40 bg-primary/10" : "border-border hover:bg-accent"}`}>
            <span className="flex items-center gap-2 text-sm font-medium text-foreground">
              <RadioGroupItem value={mode} aria-label={t(mode === "a" ? "visualNovel.npcDefaultA" : "visualNovel.npcDefaultB")} />
              {t(mode === "a" ? "visualNovel.npcDefaultA" : "visualNovel.npcDefaultB")}
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t(mode === "a" ? "visualNovel.npcDefaultAHint" : "visualNovel.npcDefaultBHint")}</span>
          </label>)}
        </RadioGroup>
        <p className="text-xs leading-relaxed text-muted-foreground">{t("visualNovel.npcDefaultsHint")}</p>
        {defaultConfiguration.error && <p role="alert" className="text-sm text-muted-foreground">{t("visualNovel.codeManaged")}</p>}
        {!!defaultRows.length && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {defaultRows.map(([id, ref], index) => <article key={id} data-npc-pool="default" className="overflow-hidden rounded-lg border border-border bg-background">
            <div className="flex h-48 items-end justify-center p-3">
              <img src={resolveImageUrl(ref)} alt={`${t(defaultConfiguration.settings.mode === "a" ? "visualNovel.npcDefaultA" : "visualNovel.npcDefaultB")} — ${t(`visualNovel.${npcGender}Npcs`)} — ${index + 1}`}
                className="h-full max-w-full object-contain" />
            </div>
            <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{t(`visualNovel.${npcGender}Npcs`)} · {t("visualNovel.npcSpriteNumber", { number: index + 1 })}</p>
          </article>)}
        </div>}
      </section>}
      {npcGender && defaultsSupported && <h2 className="text-sm font-semibold text-foreground">{t("visualNovel.customNpcSprites")}</h2>}
      {kind === "backgrounds" && <div className="space-y-2">
        <label className="block space-y-1.5 text-xs text-muted-foreground">
          <span>{t("visualNovel.backgroundCollection")}</span>
          <Select browseOnly compact value={openingId} disabled={busy || !!imageImport || !!picker} onValueChange={selectedValue => { setBackgroundScope(selectedValue); setError(""); }} className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40">
            <option value="">{t("visualNovel.globalBackgrounds")}</option>
            {openings.map((entry, index) => <option key={entry.id} value={entry.id}>{t("visualNovel.openingBackgrounds", { name: entry.name.trim() || t("visualNovel.openingNumber", { number: index + 1 }) })}</option>)}
          </Select>
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground">{t(openingId ? "visualNovel.openingBackgroundsHint" : "visualNovel.globalBackgroundsHint")}</p>
      </div>}
      {kind === "backgrounds" && !!rows.length && <button type="button" aria-expanded={backgroundFormOpen} onClick={() => setBackgroundFormOpen(value => !value)} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><ImagePlus className="h-4 w-4" />{t("visualNovel.addBackground")}</button>}
      {(kind !== "backgrounds" || backgroundFormOpen || !rows.length) && <div className={`space-y-4 rounded-xl border border-dashed p-4 ${dragging ? "border-primary bg-primary/10" : "border-border bg-card"}`}
        onDragOver={event => { if (!Array.from(event.dataTransfer.types).includes("Files")) return; event.preventDefault(); event.stopPropagation(); if (ready) setDragging(true); }}
        onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); if (!ready) return; const files = Array.from(event.dataTransfer.files); if (files.length > 1) { setError(t("visualNovel.singleBackground")); return; } const snapshot = prepareAssignment(); if (files[0] && snapshot) setImageImport({ snapshot, files }); }}>
        {kind === "backgrounds" && <div><h2 className="text-sm font-semibold text-foreground">{t("visualNovel.addBackground")}</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("visualNovel.backgroundDropHint")}</p></div>}
        {npcGender ? <p className="text-sm leading-relaxed text-muted-foreground">{t("visualNovel.npcPoolHint")}</p> : <div className="grid gap-3 sm:grid-cols-2">
          <AssetSuggestionInput label={t(kind === "sprites" ? "visualNovel.character" : "visualNovel.scene")} maxLength={80} value={name} onValueChange={setName} disabled={disabled}
            options={kind === "sprites" ? characters : Object.keys(configuration.map).filter(key => key !== "default")} />
          <AssetSuggestionInput label={t(kind === "sprites" ? "visualNovel.expression" : "visualNovel.period")} maxLength={60} value={variant} onValueChange={setVariant} disabled={disabled}
            options={kind === "sprites" ? ["normal", "happy", "sad", "angry", "shy", "smug"] : ["day", "evening", "night"]} />
        </div>}
        {kind === "backgrounds" && <label htmlFor={makeDefaultId} className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox id={makeDefaultId} checked={makeDefault} disabled={disabled} onCheckedChange={checked => setMakeDefault(checked === true)} />
          {t("visualNovel.useDefault")}
        </label>}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!ready} onClick={() => chooseUpload()} className="flex min-h-11 items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{busy ? t("visualNovel.uploading", { percent: progress }) : t(kind === "sprites" ? "visualNovel.uploadSprite" : "visualNovel.uploadBackground")}
          </button>
          <button type="button" disabled={!ready || !worldId} onClick={() => chooseLibrary()} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-foreground disabled:opacity-40"><ImagePlus className="h-4 w-4" />{t("visualNovel.chooseExisting")}</button>
        </div>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        <p className="text-xs text-muted-foreground">{t(worldId ? npcGender ? "visualNovel.npcSaveHint" : "visualNovel.saveHint" : "visualNovel.saveFirst")}</p>
      </div>}
      {error && kind === "backgrounds" && !backgroundFormOpen && !!rows.length && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
      {kind === "sprites" && !npcGender && !!spriteCharacters.length && <div role="group" aria-label={t("visualNovel.filterByCharacter")} className="flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={activeCharacterFilter === null} onClick={() => setCharacterFilter(null)}
          className={`min-h-[44px] rounded-full border px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${activeCharacterFilter === null ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"}`}>{t("visualNovel.allCharacters")}</button>
        {spriteCharacters.map(character => <button key={character.name} type="button" aria-pressed={activeCharacterFilter === character.name} onClick={() => setCharacterFilter(character.name)}
          className={`flex min-h-[44px] min-w-0 max-w-full items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${activeCharacterFilter === character.name ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
          <SpriteCharacterAvatar key={JSON.stringify([character.assetRef, character.portraitRef])} name={character.name} assetRef={character.assetRef} portraitRef={character.portraitRef} />
          <span className="min-w-0 truncate">{character.name}</span>
        </button>)}
      </div>}
      {kind === "backgrounds" && !!rows.length && <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t("visualNovel.backgroundCount", { count: rows.length })}</h2>
        <label className="flex min-h-11 min-w-0 flex-1 basis-48 items-center gap-2 rounded-lg border border-border bg-background px-3 focus-within:ring-2 focus-within:ring-primary sm:max-w-sm"><Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" /><input type="search" aria-label={t("visualNovel.searchBackgrounds")} placeholder={t("visualNovel.searchBackgrounds")} value={sceneQuery} onChange={event => setSceneQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-sm text-foreground outline-none" /></label>
      </div>}
      {!!rows.length && !visibleRows.length && <p className="py-6 text-center text-sm text-muted-foreground">{t("spriteManager.noMatches")}</p>}
      {!rows.length && !configurationError && <div className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted-foreground">{t(npcGender ? defaultsSupported ? "visualNovel.noCustomNpcSprites" : "visualNovel.noNpcSprites" : kind === "sprites" ? "visualNovel.noSprites" : "visualNovel.noBackgrounds")}</div>}
      {!sortDisabled && <p className="text-xs text-muted-foreground">{t("visualNovel.dragHint")}</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
        <SortableContext items={visibleRows.map(vnAssetRowId)} strategy={rectSortingStrategy}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visibleRows.map((row, index) => <SortableVnAssetCard key={vnAssetRowId(row)} row={row} kind={kind} npcGender={npcGender} index={index} disabled={disabled || !worldId} sortDisabled={sortDisabled}
              onUpload={() => chooseUpload(row)} onLibrary={() => chooseLibrary(row)}
              isDefault={configuration.map.default === row.assetRef} onPreview={setPreviewImage} onRemove={() => remove(row)} onDefault={() => commit({ ...configuration.map, default: row.assetRef })} />)}
          </div>
        </SortableContext>
      </DndContext>
      </>}
    </div>
    {picker && worldId && <AssetPicker worldId={worldId} filterType="image" onClose={() => setPicker(null)} onSelect={assetRef => { assign(assetRef, picker); setPicker(null); }} />}
    <ImageLightbox image={previewImage} onClose={() => setPreviewImage(null)} />
    {imageImport && <ImageImportDialog multiple={false} initialFiles={imageImport.files} onClose={() => { controller.current?.abort(); setImageImport(null); }} onImport={async (images, context) => { context.signal.throwIfAborted(); if (!assignmentIsCurrent(imageImport.snapshot)) throw Error(t("visualNovel.assignmentChanged")); await upload(images[0]!, imageImport.snapshot, context); }} />}
  </div>;
}

export function VnSpritesSection() {
  const draft = useEditorStore(s => s.worldDraft);
  return <VnAssetSection kind="sprites" key={`${draft.id}:${draft.rootComponent?.interfaceId}`} />;
}
export function VnBackgroundsSection() {
  const draft = useEditorStore(s => s.worldDraft);
  return <VnAssetSection kind="backgrounds" key={`${draft.id}:${draft.rootComponent?.interfaceId}`} />;
}
