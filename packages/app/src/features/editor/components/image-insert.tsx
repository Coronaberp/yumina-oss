import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen, ImagePlus, Upload } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { useAssetStore } from "@/stores/assets";
import { AssetPicker } from "../asset-picker";
import { ImageImportDialog, type ImageImportContext } from "@/components/image-import-dialog";
import { getImageFilesFromTransfer } from "@/lib/clipboard-image";

/**
 * Put text at the caret of a textarea the way typing would: through the native
 * value setter plus an input event, so the controlled field (and the debounced
 * commit behind it) sees an edit, not a prop change, and the caret lands after
 * what was inserted.
 */
export function insertAtCaret(el: HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  // A picture sits on a line of its own; pad only where a line break is missing.
  const lead = before.length === 0 || before.endsWith("\n") ? "" : "\n";
  const trail = after.length === 0 || after.startsWith("\n") ? "" : "\n";
  const insert = `${lead}${text}${trail}`;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, before + insert + after);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  const caret = start + insert.length;
  el.focus();
  el.setSelectionRange(caret, caret);
}

/** The shared `[image:…]` embed for a library asset or URL. */
export function imageEmbedTag(ref: string, alt?: string): string {
  const clean = (alt ?? "").replace(/[|\]\n]/g, " ").trim();
  return clean ? `[image:${ref}|alt=${clean}]` : `[image:${ref}]`;
}

export interface ImageInsert {
  busy: boolean;
  dragOver: boolean;
  /** Spread onto the textarea: drop a file or paste a picture to add it here. */
  dropProps: {
    onDragOver: (e: DragEvent<HTMLTextAreaElement>) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent<HTMLTextAreaElement>) => void;
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  };
  /** The hidden file input and the library modal — render once near the field. */
  overlays: ReactNode;
  openFiles: () => void;
  openLibrary: () => Promise<void>;
}

/**
 * Everything a text field needs to take pictures like a mail composer does:
 * a toolbar button (upload from the computer, or pick from the world's
 * assets), drag-and-drop, and paste. Files go through the world asset
 * library and land in the text as `[image:@asset:…]` at the caret.
 */
export function useImageInsert(getTextarea: () => HTMLTextAreaElement | null, scopeKey?: string): ImageInsert {
  const { t } = useTranslation("editor");
  const uploadAsset = useAssetStore((s) => s.uploadAsset);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const epoch = useRef(0);
  const inFlight = useRef<Target | null>(null);
  const uploaded = useRef(new Map<File, string>());
  const mounted = useRef(true);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  type Target = { token: number; draftId: string; worldId: string | null; scope?: string; area: HTMLTextAreaElement; files?: File[] };
  const [sources, setSources] = useState<Target | null>(null);
  const [picker, setPicker] = useState<Target | null>(null);
  useEffect(() => {
    mounted.current = true;
    let previous = useEditorStore.getState();
    const unsubscribe = useEditorStore.subscribe(next => {
      if (next.worldDraft.id !== previous.worldDraft.id || (previous.serverWorldId && next.serverWorldId !== previous.serverWorldId)
          || next.readOnlyInspect || next.editingLocked || next.guestMode) {
        epoch.current++; uploaded.current.clear(); setSources(null); setPicker(null); setBusy(false);
      }
      previous = next;
    });
    return () => { mounted.current = false; unsubscribe(); };
  }, []);
  useEffect(() => { epoch.current++; uploaded.current.clear(); setSources(null); setPicker(null); setBusy(false); }, [scopeKey]);
  function current(target: Target, signal?: AbortSignal) {
    const state = useEditorStore.getState();
    return mounted.current && !signal?.aborted && target.token === epoch.current
      && target.draftId === state.worldDraft.id && (!target.worldId || target.worldId === state.serverWorldId)
      && target.scope === currentScope.current && getTextarea() === target.area
      && !state.readOnlyInspect && !state.editingLocked && !state.guestMode;
  }
  function capture(files?: File[]): Target | null {
    const state = useEditorStore.getState(), area = getTextarea();
    if (!area || state.readOnlyInspect || state.editingLocked || state.guestMode) return null;
    uploaded.current.clear();
    return { token: ++epoch.current, draftId: state.worldDraft.id, worldId: state.serverWorldId, scope: currentScope.current, area, files };
  }
  async function ensureWorldId(target: Target) {
    if (!current(target)) return null;
    if (!useEditorStore.getState().serverWorldId) await useEditorStore.getState().saveDraft();
    return current(target) ? useEditorStore.getState().serverWorldId : null;
  }
  function openFiles(files?: File[]) {
    if (busy) return;
    const target = capture(files);
    if (target) { setPicker(null); setSources(target); }
  }
  const insertFiles = async (files: File[], context: ImageImportContext) => {
    if (!sources || inFlight.current?.token === sources.token || !current(sources, context.signal)) return;
    const target = sources;
    inFlight.current = target;
    setBusy(true);
    try {
      const worldId = await ensureWorldId(target);
      if (!worldId || !current(target, context.signal)) return;
      for (const file of files) {
        if (!current(target, context.signal)) return;
        if (!uploaded.current.has(file)) {
          const asset = await uploadAsset(worldId, file, "image", { signal: context.signal, onProgress: context.onProgress, silent: true });
          if (!current(target, context.signal)) return;
          if (!asset) throw Error(t("imageInsert.failed", { name: file.name }));
          uploaded.current.set(file, asset.id);
        }
      }
      if (!current(target, context.signal)) return;
      for (const file of files) insertAtCaret(target.area, imageEmbedTag(`@asset:${uploaded.current.get(file)!}`, file.name.replace(/\.[^.]+$/, "")));
      epoch.current++; uploaded.current.clear();
    } finally {
      if (inFlight.current === target) {
        inFlight.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };
  const openLibrary = async () => {
    const target = capture();
    if (!target) return;
    const worldId = await ensureWorldId(target);
    if (worldId && current(target)) { setSources(null); setPicker({ ...target, worldId }); }
  };
  const dropProps: ImageInsert["dropProps"] = {
    onDragOver: event => { if (Array.from(event.dataTransfer.types).includes("Files")) { event.preventDefault(); setDragOver(true); } },
    onDragLeave: () => setDragOver(false),
    onDrop: event => {
      const files = getImageFilesFromTransfer(event.dataTransfer);
      setDragOver(false);
      if (files.length) { event.preventDefault(); openFiles(files); }
    },
    onPaste: event => {
      const files = getImageFilesFromTransfer(event.clipboardData);
      if (files.length) { event.preventDefault(); openFiles(files); }
    },
  };
  const overlays = <>
    {sources && <ImageImportDialog multiple maxFiles={Infinity} maxBytes={Infinity} accept="image/*" crop="none" preserveOriginal initialFiles={sources.files}
      onImport={insertFiles} onClose={() => { epoch.current++; uploaded.current.clear(); setSources(null); setBusy(false); }} />}
    {picker?.worldId && <AssetPicker worldId={picker.worldId} filterType="image" onSelect={ref => {
      if (!current(picker)) return;
      epoch.current++; insertAtCaret(picker.area, imageEmbedTag(ref)); setPicker(null);
    }} onClose={() => { epoch.current++; setPicker(null); }} />}
  </>;
  return { busy, dragOver, dropProps, overlays, openFiles: () => openFiles(), openLibrary };
}

/** The toolbar button: one click, then upload or pick from assets. */
export function ImageInsertButton({ insert, className }: { insert: ImageInsert; className?: string }) {
  const { t } = useTranslation("editor");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={insert.busy}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50",
            className,
          )}
        >
          <ImagePlus className="h-3.5 w-3.5" />
          {insert.busy ? t("imageInsert.uploading") : t("imageInsert.button")}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onClick={insert.openFiles}>
          <Upload className="mr-2 h-4 w-4" />
          {t("imageInsert.upload")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void insert.openLibrary()}>
          <FolderOpen className="mr-2 h-4 w-4" />
          {t("imageInsert.library")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
