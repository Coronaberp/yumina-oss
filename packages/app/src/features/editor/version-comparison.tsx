import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WorldChange, WorldDiff } from "@yumina/engine";
import type { WorldVersion } from "@yumina/shared";
import { useEditorStore } from "@/stores/editor";
import { startVersionComparison } from "./version-comparison-client";
import type { VersionComparisonInput } from "./version-comparison-data";

const apiBase = import.meta.env.VITE_API_URL || "";
const PAGE_SIZE = 20;
const TEXT_PAGE_SIZE = 4000;

type Snapshot = Pick<VersionComparisonInput, "saved" | "currentAgeRating">;
interface Props {
  worldId: string;
  version: WorldVersion;
  versions: WorldVersion[];
  onSelect: (version: WorldVersion) => void;
  onBack: () => void;
}

export function VersionComparison({ worldId, version, versions, onSelect, onBack }: Props) {
  const { t, i18n } = useTranslation("editor");
  const draft = useEditorStore(s => s.worldDraft);
  const currentWorldId = useEditorStore(s => s.serverWorldId);
  const isDirty = useEditorStore(s => s.isDirty);
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<{ key: string; snapshot?: Snapshot; error?: boolean } | null>(null);
  const [comparison, setComparison] = useState<{ snapshot: Snapshot; draft: typeof draft; diff: WorldDiff | null; revision: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const key = `${worldId}:${version.id}:${attempt}`;
  const snapshot = response?.key === key ? response.snapshot : undefined;
  const available = currentWorldId === worldId && !!draft;
  const result = comparison?.snapshot === snapshot && comparison?.draft === draft ? comparison : null;
  const failed = (response?.key === key && response.error) || (result && !result.diff);

  useEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onBack(); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onBack]);

  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/api/worlds/${encodeURIComponent(worldId)}/versions/${encodeURIComponent(version.id)}`, {
          credentials: "include", cache: "no-store", signal: controller.signal,
        });
        if (!res.ok) throw new Error("Snapshot unavailable");
        const json = await res.json();
        const data = json.data;
        if (!data || data.id !== version.id || data.worldId !== worldId || !data.schema || typeof data.schema !== "object" || Array.isArray(data.schema)
          || !(data.thumbnailUrl === null || typeof data.thumbnailUrl === "string") || typeof data.ageRating !== "string" || typeof json.currentAgeRating !== "string") throw new Error("Invalid snapshot");
        if (!controller.signal.aborted) setResponse({ key, snapshot: { saved: data, currentAgeRating: json.currentAgeRating } });
      } catch {
        if (!controller.signal.aborted) setResponse({ key, error: true });
      }
    })();
    return () => controller.abort();
  }, [worldId, version.id, key, available]);

  useEffect(() => {
    if (!snapshot || !available) return;
    let stop: (() => void) | undefined;
    // Coalesce typing/Studio updates before starting disposable CPU work.
    const timer = window.setTimeout(() => {
      stop = startVersionComparison({ ...snapshot, draft }, diff => setComparison(previous => ({ snapshot, draft, diff, revision: (previous?.revision ?? 0) + 1 })));
    }, 120);
    return () => { window.clearTimeout(timer); stop?.(); };
  }, [snapshot, draft, available]);

  const selectedName = version.source && version.source !== "manual" ? t(`versionHistory.source.${version.source}`) : version.name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-2 backdrop-blur-sm sm:p-4" onClick={e => { if (e.target === e.currentTarget) onBack(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={t("versionHistory.compare.title")} aria-describedby="version-comparison-scope"
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-xl"
        onKeyDown={e => {
          if (e.key !== "Tab") return;
          const focusable = panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), select, summary");
          if (!focusable?.length) return;
          const first = focusable[0]; const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }}>
        <header className="shrink-0 border-b border-border p-4 sm:px-6">
          <button onClick={onBack} className="mb-3 flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />{t("versionHistory.compare.back")}
          </button>
          <h3 className="text-lg font-semibold">{t("versionHistory.compare.title")}</h3>
          <p id="version-comparison-scope" className="mt-1 text-xs text-muted-foreground">{t("versionHistory.compare.scope")}</p>
          <label className="mt-3 block text-xs font-medium text-muted-foreground">
            {t("versionHistory.compare.saved")}
            <select aria-label={t("versionHistory.compare.saved")} value={version.id} onChange={e => { const selected = versions.find(v => v.id === e.target.value); if (selected) onSelect(selected); }}
              className="mt-1 block w-full min-w-0 rounded-lg border border-border bg-input p-2 text-sm text-foreground">
              {versions.map(v => <option key={v.id} value={v.id}>{v.source && v.source !== "manual" ? t(`versionHistory.source.${v.source}`) : v.name} · {new Date(v.createdAt).toLocaleString(i18n.language)}</option>)}
            </select>
          </label>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div className="min-w-0 rounded-lg border border-border p-2"><span className="font-semibold">{t("versionHistory.compare.saved")}</span><p className="break-words">{selectedName} · {new Date(version.createdAt).toLocaleString(i18n.language)}</p></div>
            <div className="min-w-0 rounded-lg border border-primary/30 bg-primary/5 p-2"><span className="font-semibold">{t("versionHistory.compare.current")}</span><p>{t(isDirty ? "versionHistory.compare.unsaved" : "versionHistory.compare.fresh")}</p></div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:px-6" aria-busy={available && !failed && !result}>
          {!available ? <p role="alert">{t("versionHistory.compare.noDraft")}</p> : failed ? (
            <div role="alert" className="py-6 text-center"><p>{t("versionHistory.compare.failed")}</p><button onClick={() => setAttempt(n => n + 1)} className="mt-3 rounded-lg border border-border px-4 py-2">{t("versionHistory.retry")}</button></div>
          ) : !result?.diff ? (
            <p role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("versionHistory.compare.loading")}</p>
          ) : <ComparisonChanges key={result.revision} diff={result.diff} />}
        </div>
      </div>
    </div>
  );
}

function ComparisonChanges({ diff }: { diff: WorldDiff }) {
  const { t } = useTranslation("editor");
  const [page, setPage] = useState(0);
  if (!diff.changes.length) return <p role="status" className="py-10 text-center text-sm text-muted-foreground">{t("versionHistory.compare.empty")}</p>;
  const pages = Math.ceil(diff.changes.length / PAGE_SIZE);
  return <div>
    <p role="status" className="mb-4 text-sm">{t("versionHistory.compare.counts", diff.counts)}</p>
    <div className="space-y-3">{diff.changes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((change, index) => <Change key={`${page}:${index}`} change={change} />)}</div>
    {pages > 1 && <nav aria-label={t("versionHistory.compare.pages")} className="mt-4 flex items-center justify-between gap-2 text-sm">
      <button disabled={page === 0} onClick={() => setPage(n => n - 1)} className="min-h-10 rounded-lg border border-border px-3 disabled:opacity-40">{t("versionHistory.compare.previous")}</button>
      <span>{t("versionHistory.compare.page", { page: page + 1, total: pages })}</span>
      <button disabled={page === pages - 1} onClick={() => setPage(n => n + 1)} className="min-h-10 rounded-lg border border-border px-3 disabled:opacity-40">{t("versionHistory.compare.next")}</button>
    </nav>}
  </div>;
}

function Change({ change }: { change: WorldChange }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const [fieldPage, setFieldPage] = useState(0);
  const fields = change.fields ?? [];
  const tone = change.op === "added" ? "text-emerald-400" : change.op === "removed" ? "text-destructive" : "text-amber-400";
  const label = change.id === "snapshot.thumbnailUrl" ? t("versionHistory.compare.cover") : change.id === "snapshot.ageRating" ? t("versionHistory.compare.rating") : change.name ?? change.id;
  return <details className="rounded-xl border border-border bg-background/30" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer break-words px-3 py-3 text-sm"><span className={`mr-2 font-semibold ${tone}`}>{t(`versionHistory.compare.${change.op}`)}</span><span className="font-mono text-xs text-muted-foreground">{t(`versionHistory.compare.kind.${change.kind}`)} · </span>{label}</summary>
    {open && <div className="space-y-3 border-t border-border p-3">{fields.slice(fieldPage * PAGE_SIZE, (fieldPage + 1) * PAGE_SIZE).map(field => <div key={field.field}>
      <p className="mb-2 break-words font-mono text-xs text-muted-foreground">{field.field}</p>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <TextValue key="before" text={field.before} type={field.beforeType} label={t("versionHistory.compare.saved")} />
        <TextValue key="after" text={field.after} type={field.afterType} label={t("versionHistory.compare.current")} />
      </div>
    </div>)}
      {fields.length > PAGE_SIZE && <div className="flex items-center justify-between gap-2 text-xs"><button disabled={fieldPage === 0} onClick={() => setFieldPage(n => n - 1)} className="min-h-9 rounded border border-border p-2 disabled:opacity-40">{t("versionHistory.compare.previous")}</button><span>{t("versionHistory.compare.page", { page: fieldPage + 1, total: Math.ceil(fields.length / PAGE_SIZE) })}</span><button disabled={(fieldPage + 1) * PAGE_SIZE >= fields.length} onClick={() => setFieldPage(n => n + 1)} className="min-h-9 rounded border border-border p-2 disabled:opacity-40">{t("versionHistory.compare.next")}</button></div>}
    </div>}
  </details>;
}

function TextValue({ text, type, label }: { text: string; type?: string; label: string }) {
  const { t } = useTranslation("editor");
  const [page, setPage] = useState(0);
  const pages = Math.ceil(text.length / TEXT_PAGE_SIZE);
  return <div className="min-w-0 rounded-lg border border-border bg-background/60 p-2">
    <p className="mb-2 text-xs font-semibold">{label} <span className="font-normal text-muted-foreground">{type && t(`versionHistory.compare.type.${type}`, { defaultValue: type })}</span></p>
    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs [overflow-wrap:anywhere]">{type === "missing" ? t("versionHistory.compare.missing") : text === "" ? t("versionHistory.compare.emptyValue") : text.slice(page * TEXT_PAGE_SIZE, (page + 1) * TEXT_PAGE_SIZE)}</pre>
    {pages > 1 && <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><button disabled={page === 0} onClick={() => setPage(n => n - 1)} className="min-h-9 rounded border border-border px-2 disabled:opacity-40">{t("versionHistory.compare.previous")}</button><span>{t("versionHistory.compare.textPage", { page: page + 1, total: pages })}</span><button disabled={page === pages - 1} onClick={() => setPage(n => n + 1)} className="min-h-9 rounded border border-border px-2 disabled:opacity-40">{t("versionHistory.compare.moreText")}</button></div>}
  </div>;
}
