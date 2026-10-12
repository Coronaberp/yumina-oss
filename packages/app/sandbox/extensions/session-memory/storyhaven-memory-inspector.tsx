import { useEffect, useId, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { MemorySelect } from "./memory-select";
import type {
  StoryhavenFact,
  StoryhavenMemoryStatus,
} from "../../../../shared/src/storyhaven-memory.js";

export interface StoryhavenMemoryInspectorProps {
  api: (action: string, payload?: Record<string, unknown>) => Promise<unknown>;
  language?: string;
}
type Settings = StoryhavenMemoryStatus["settings"];
type Tab = "facts" | "clusters" | "lore" | "preview";
interface Preview {
  block: string;
  usedIds: string[];
  droppedIds: string[];
}
const DEFAULT_SETTINGS: Settings = {
  model: "",
  language: "English",
  memoryBudgetTokens: 1000,
  batchSize: 5,
  settleMarginExchanges: 1,
  sessionNeighborK: 8,
  sessionCandidateK: 32,
  maxPinnedLoreChunks: 12,
  maxFactsPerBatch: 10,
  loreNeighborK: 3,
  loreCandidateK: 32,
  clusterBudgetTokens: 150,
  reservedFraction: 0.6,
  clusterTriggerCount: 8,
  clusterMultiThread: false,
  clusterMaxSummaries: 2,
};
const NUMBER_SETTINGS: Array<{
  key: string;
  en: string;
  zh: string;
  min: number;
  max: number;
  step?: number;
}> = [
  {
    key: "memoryBudgetTokens",
    en: "Recall budget (tokens)",
    zh: "回忆预算（词元）",
    min: 1,
    max: 100000,
  },
  {
    key: "batchSize",
    en: "Exchanges per memory update",
    zh: "每次记忆更新的对话轮数",
    min: 1,
    max: 20,
  },
  {
    key: "settleMarginExchanges",
    en: "Recent exchanges to leave unsettled",
    zh: "暂不处理的最近对话轮数",
    min: 0,
    max: 10,
  },
  {
    key: "sessionNeighborK",
    en: "Facts compared during updates",
    zh: "更新时比较的事实数",
    min: 1,
    max: 50,
  },
  {
    key: "sessionCandidateK",
    en: "Facts considered for recall",
    zh: "回忆时考虑的事实数",
    min: 1,
    max: 100,
  },
  {
    key: "maxPinnedLoreChunks",
    en: "Reserved lore passages",
    zh: "优先保留的设定段落数",
    min: 1,
    max: 50,
  },
  {
    key: "maxFactsPerBatch",
    en: "New facts per memory update",
    zh: "每次记忆更新的新事实数",
    min: 1,
    max: 50,
  },
  {
    key: "loreNeighborK",
    en: "Lore compared during updates",
    zh: "更新时比较的设定数",
    min: 1,
    max: 20,
  },
  {
    key: "loreCandidateK",
    en: "Lore passages considered for recall",
    zh: "回忆时考虑的设定段落数",
    min: 1,
    max: 100,
  },
  {
    key: "clusterBudgetTokens",
    en: "Budget for each story summary (tokens)",
    zh: "每条故事摘要的预算（词元）",
    min: 10,
    max: 2000,
  },
  {
    key: "reservedFraction",
    en: "Recall budget reserved for ongoing facts",
    zh: "持续事实保留的回忆预算比例",
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: "clusterTriggerCount",
    en: "Facts before a story summary",
    zh: "生成故事摘要前的事实数",
    min: 1,
    max: 50,
  },
  {
    key: "clusterMaxSummaries",
    en: "Story summaries included in recall",
    zh: "回忆中包含的故事摘要数",
    min: 1,
    max: 10,
  },
];
const FACT_LABELS: Record<string, [string, string]> = {
  event: ["Event", "事件"],
  state: ["Ongoing state", "持续状态"],
  relationship: ["Relationship", "关系"],
  world: ["World detail", "世界细节"],
  profile: ["Character trait", "人物特征"],
  promise: ["Promise or plan", "承诺或计划"],
  conflict: ["Conflict", "冲突"],
  injury: ["Injury", "伤势"],
  illness: ["Illness", "疾病"],
  inventory: ["Inventory", "物品"],
  equipment: ["Equipment", "装备"],
  mood: ["Mood", "情绪"],
  lore: ["Lore", "设定"],
};
const TABS: Tab[] = ["facts", "clusters", "lore", "preview"];
const inputClass =
  "w-full min-w-0 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-xs text-white outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/40 disabled:opacity-40";
const buttonClass =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-white/80 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-not-allowed disabled:opacity-40";
const primaryButton = `${buttonClass} border-primary/30 bg-primary/10 text-primary hover:bg-primary/15`;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function isStatus(value: unknown): value is StoryhavenMemoryStatus {
  const data = object(value);
  return (
    (data.backend === "legacy" || data.backend === "storyhaven") &&
    Array.isArray(data.facts) &&
    Array.isArray(data.lore) &&
    typeof data.settings === "object"
  );
}

/** Session controls hosted by the existing memory modal; networking stays in its bridge. */
export function StoryhavenMemoryInspector({
  api,
  language,
}: StoryhavenMemoryInspectorProps) {
  const zh = language?.toLowerCase().startsWith("zh") ?? false;
  const tt = (en: string, cn: string) => (zh ? cn : en);
  const id = useId();
  const apiRef = useRef(api);
  apiRef.current = api;
  const mounted = useRef(false),
    loadVersion = useRef(0),
    dirty = useRef(false),
    recallBudgetEdited = useRef(false),
    hydrated = useRef(false),
    busyRef = useRef(false);
  const [status, setStatus] = useState<StoryhavenMemoryStatus | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("facts");
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS });
  const [backend, setBackend] =
    useState<StoryhavenMemoryStatus["backend"]>("legacy");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [search, setSearch] = useState(""),
    [typeFilter, setTypeFilter] = useState(""),
    [factState, setFactState] = useState("current");
  const [editId, setEditId] = useState<string | null>(null),
    [editText, setEditText] = useState(""),
    [editPinned, setEditPinned] = useState(false);
  const [lineageId, setLineageId] = useState<string | null>(null);
  const [lineage, setLineage] = useState<Partial<StoryhavenFact>[] | null>(
    null,
  );
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [query, setQuery] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null);

  async function refresh() {
    const version = ++loadVersion.current;
    try {
      const result = await apiRef.current("status");
      if (!isStatus(result)) throw new Error();
      if (!mounted.current || version !== loadVersion.current) return;
      setStatus(result);
      if (!hydrated.current || !dirty.current) {
        setSettings({ ...DEFAULT_SETTINGS, ...result.settings });
        recallBudgetEdited.current = false;
        setBackend(result.backend);
        hydrated.current = true;
      }
      setError(false);
    } catch {
      if (mounted.current && version === loadVersion.current) setError(true);
    } finally {
      if (mounted.current && version === loadVersion.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      stopped = true;
      mounted.current = false;
      loadVersion.current++;
      if (timer) clearTimeout(timer);
    };
  }, []);

  async function perform(
    action: string,
    payload?: Record<string, unknown>,
    accept?: (result: unknown) => void,
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(action);
    setError(false);
    try {
      const result = await apiRef.current(action, payload);
      if (!mounted.current) return;
      accept?.(result);
      await refresh();
    } catch {
      if (mounted.current) setError(true);
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy("");
        setConfirm(null);
      }
    }
  }
  function changeSetting(key: string, value: string | number | boolean) {
    if (key === "memoryBudgetTokens") recallBudgetEdited.current = true;
    dirty.current = true;
    setSettingsDirty(true);
    setSettings((previous) => ({ ...previous, [key]: value }));
  }
  function startEdit(fact: StoryhavenFact) {
    setEditId(fact.id);
    setEditText(fact.text);
    setEditPinned(fact.pinned);
    setLineage(null);
    setLineageId(null);
    setConfirm(null);
  }
  const activeProfile = status?.profile?.status === "ready";
  const facts = status?.facts ?? [],
    loreEntries = status?.lore ?? [];
  const factTypes = [...new Set(facts.map((fact) => fact.fact_type))].sort();
  const visibleFacts = facts.filter(
    (fact) =>
      (!typeFilter || fact.fact_type === typeFilter) &&
      (factState === "all" ||
        (factState === "expired"
          ? fact.expired_ts !== null
          : fact.expired_ts === null)) &&
      `${fact.text} ${fact.participants.join(" ")} ${fact.location ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const savedOverrides = new Map(
    (status?.overrides ?? []).map((row) => [
      text(row.lore_id ?? row.loreId),
      text(row.override_content ?? row.content),
    ]),
  );
  const revealedIds = new Set(
    (status?.reveals ?? []).map((row) => text(row.secret_id ?? row.secretId)),
  );
  const settingsValid = NUMBER_SETTINGS.every((field) => {
    const value = Number(settings[field.key]);
    return (
      Number.isFinite(value) &&
      value >= field.min &&
      value <= field.max &&
      (field.step !== undefined || Number.isInteger(value))
    );
  });
  const humanStatus = status?.backend === "legacy"
    ? tt("Legacy memory selected", "已选择传统记忆")
    : !status?.profile
    ? tt("Embedding setup needed", "需要配置嵌入模型")
    : status.profile.status === "pending"
      ? tt("Preparing memory…", "正在准备记忆…")
      : status.profile.status === "failed"
        ? tt("Embedding setup needs attention", "嵌入模型配置需要处理")
        : status.errorCode
          ? tt("Memory needs attention", "记忆需要处理")
          : ["pending", "running", "queued", "reindexing"].includes(
                status.status,
              )
            ? tt("Updating memory…", "正在更新记忆…")
            : status.status === "failed"
              ? tt("Memory update failed", "记忆更新失败")
              : tt("Memory ready", "记忆已就绪");
  const switchBackend = (value: StoryhavenMemoryStatus["backend"]) => {
    setBackend(value);
    dirty.current = true;
    setSettingsDirty(true);
  };

  const renderNumberSetting = (field: typeof NUMBER_SETTINGS[number]) => (
    <label key={field.key} className="space-y-1.5 text-xs">
      <span>{tt(field.en, field.zh)}</span>
      <input disabled={!!busy} type="number" className={inputClass} value={settings[field.key] === undefined ? "" : String(settings[field.key])} min={field.min} max={field.max} step={field.step ?? 1} onChange={event => changeSetting(field.key, event.target.value === "" ? "" : Number(event.target.value))} />
    </label>
  );
  const maintenanceControls = (
    <>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass}
          disabled={!!busy || !activeProfile}
          onClick={() => setConfirm("rebuild")}
        >
          {tt("Rebuild from history", "从历史重建")}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!!busy || !activeProfile}
          onClick={() => void perform("retry")}
        >
          {tt("Retry update", "重试更新")}
        </button>
        <button
          type="button"
          className={`${buttonClass} text-red-200`}
          disabled={!!busy || !activeProfile}
          onClick={() => setConfirm("clear")}
        >
          {tt("Clear automatic memory", "清空自动记忆")}
        </button>
        {!!busy && (
          <span
            role="status"
            className="flex items-center gap-2 text-xs text-white/50"
          >
            <Loader2 className="size-3.5 animate-spin" />
            {tt("Working…", "处理中…")}
          </span>
        )}
      </div>
      {(confirm === "clear" || confirm === "rebuild") && (
        <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <p className="text-xs leading-relaxed">
            {confirm === "clear"
              ? tt(
                  "Clear this story’s automatic facts, lore changes and summaries? Your personal pinned notes are preserved.",
                  "清空此故事的自动事实、设定变更和摘要？个人固定笔记将保留。",
                )
              : tt(
                  "Rebuild this story’s memory from its surviving history? This may take a few minutes.",
                  "从保留的历史重建此故事的记忆？此操作可能需要几分钟。",
                )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={primaryButton}
              disabled={!!busy}
              onClick={() => void perform(confirm)}
            >
              {tt("Confirm", "确认")}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={!!busy}
              onClick={() => setConfirm(null)}
            >
              {tt("Cancel", "取消")}
            </button>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="min-w-0 space-y-4 text-white/80">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/15 p-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-white">
            {tt("Story memory", "故事记忆")}
          </h3>
          <p className="mt-1 text-xs" role="status">
            {loading ? tt("Loading memory…", "正在加载记忆…") : humanStatus}
          </p>
          {status?.profile?.configurationSource === "admin" && <p className="mt-2 text-xs text-white/50">{status.backend === "legacy"
            ? tt("Admin default embeddings available", "管理员默认嵌入配置已就绪")
            : tt("Using admin default embeddings", "使用管理员默认嵌入配置")}</p>}
          {status?.backend === "legacy" && <p className="mt-2 max-w-lg text-xs leading-relaxed text-white/50">{tt(
            "Choose StoryHaven facts and lore under Memory settings → Advanced settings to enable automatic fact recall.",
            "在记忆设置 → 高级设置中选择 StoryHaven 事实与设定，即可启用自动事实召回。",
          )}</p>}
          {!status?.profile && !loading && (
            <p className="mt-2 max-w-lg text-xs leading-relaxed text-white/50">
              {tt(
                "No embedding connection is available. Ask the administrator to configure the default, or activate a personal profile in account settings.",
                "暂无可用的嵌入连接。请管理员配置默认连接，或在账户设置中启用个人配置。",
              )}
            </p>
          )}
        </div>
        <button
          type="button"
          className={buttonClass}
          disabled={!!busy || loading}
          onClick={() => void refresh()}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {tt("Refresh", "刷新")}
        </button>
      </div>
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs text-red-200"
        >
          {tt(
            "Memory could not be updated. Check your configuration and try again.",
            "无法更新记忆。请检查配置后重试。",
          )}
        </div>
      )}
      <details className="rounded-xl border border-white/10 bg-black/15 p-3">
        <summary className="cursor-pointer text-xs font-semibold text-white/80">
          {tt("Memory settings", "记忆设置")}
          {settingsDirty && <span className="ml-2 font-normal text-primary">{tt("Unsaved", "未保存")}</span>}
        </summary>
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2" data-memory-basic-settings="true">
            <label className="space-y-1.5 text-xs">
              <span>{tt("Memory language", "记忆语言")}</span>
              <input className={inputClass} disabled={!!busy} value={text(settings.language)} onChange={event => changeSetting("language", event.target.value)} placeholder={tt("English, Chinese…", "英语、中文…")} />
            </label>
            {NUMBER_SETTINGS.filter(field => ["memoryBudgetTokens", "batchSize"].includes(field.key)).map(renderNumberSetting)}
          </div>
          {status?.memoryBudgetTokensInherited !== undefined && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-white/60">
              <span>{status.memoryBudgetTokensInherited ? tt("Recall budget uses your account default.", "回忆预算使用账户默认值。") : tt("This chat has its own recall budget.", "此对话使用独立回忆预算。")}</span>
              {!status.memoryBudgetTokensInherited && <button type="button" className={buttonClass} disabled={!!busy || settingsDirty} onClick={() => void perform("settings", { settings: { memoryBudgetTokens: null } })}>{tt("Use account default", "使用账户默认值")}</button>}
            </div>
          )}
          <details className="rounded-lg border border-white/10 p-3" data-memory-advanced-settings="true">
            <summary className="cursor-pointer text-xs font-semibold text-white/80">{tt("Advanced", "高级")}</summary>
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5 text-xs">
                  <span>{tt("Memory system", "记忆系统")}</span>
                  <MemorySelect value={backend} disabled={!!busy || !status} onValueChange={value => switchBackend(value as StoryhavenMemoryStatus["backend"])} label={tt("Memory system", "记忆系统")} options={[{ value: "legacy", label: tt("Legacy memory", "传统记忆") }, { value: "storyhaven", label: tt("StoryHaven facts and lore", "StoryHaven 事实与设定"), disabled: !activeProfile }]} />
                </label>
                <label className="space-y-1.5 text-xs">
                  <span>{tt("Extraction model", "提取模型")}</span>
                  <input className={inputClass} disabled={!!busy} value={text(settings.model)} onChange={event => changeSetting("model", event.target.value)} placeholder={tt("Use the current story model", "使用当前故事模型")} />
                </label>
                {NUMBER_SETTINGS.filter(field => !["memoryBudgetTokens", "batchSize"].includes(field.key)).map(renderNumberSetting)}
              </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              disabled={!!busy}
              checked={settings.clusterMultiThread === true}
              onChange={(event) =>
                changeSetting("clusterMultiThread", event.target.checked)
              }
            />
            {tt(
              "Keep separate summaries for different story threads",
              "为不同故事线保留独立摘要",
            )}
          </label>
              {status?.profile && <p className="text-[11px] text-white/40">{status.profile.configurationSource === "admin" && <>{tt("Admin default", "管理员默认配置")} · </>}{status.profile.model} · {status.profile.dimensions} {tt("dimensions", "维度")}</p>}
              {maintenanceControls}
              <p className="text-[11px] leading-relaxed text-white/40">{tt("Changing the memory system preserves your existing notes. Rebuild to learn from the surviving story history.", "切换记忆系统会保留现有笔记。重建记忆可从保留的故事历史中重新学习。")}</p>
            </div>
          </details>
          {!settingsValid && (
            <p role="alert" className="text-xs text-red-200">
              {tt(
                "Enter valid values within the shown limits.",
                "请填写所示范围内的有效数值。",
              )}
            </p>
          )}
          <button
            type="button"
            className={primaryButton}
            disabled={!!busy || !status || !settingsDirty || !settingsValid}
            onClick={() =>
              void perform(
                "settings",
                {
                  backend,
                  settings: {
                    ...Object.fromEntries(
                      NUMBER_SETTINGS.filter(field => field.key !== "memoryBudgetTokens" || status?.memoryBudgetTokensInherited !== true || recallBudgetEdited.current).map((field) => [
                        field.key,
                        settings[field.key],
                      ]),
                    ),
                    language: settings.language,
                    clusterMultiThread: settings.clusterMultiThread,
                    ...(text(settings.model).trim()
                      ? { model: text(settings.model).trim() }
                      : Object.hasOwn(status?.settings ?? {}, "model")
                        ? { model: null }
                        : {}),
                  },
                },
                () => {
                  dirty.current = false;
                  recallBudgetEdited.current = false;
                  setSettingsDirty(false);
                },
              )
            }
          >
            {tt("Save settings", "保存设置")}
          </button>
        </div>
      </details>
      <div
        className="flex flex-wrap gap-1 border-b border-white/10 pb-2"
        role="tablist"
        aria-label={tt("Memory views", "记忆视图")}
      >
        {(
          [
            ["facts", "Facts", "事实"],
            ["clusters", "Story threads", "故事线"],
            ["lore", "Lore and secrets", "设定与秘密"],
            ["preview", "Recall preview", "回忆预览"],
          ] as const
        ).map(([value, en, cn]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${id}-tab-${value}`}
            aria-controls={`${id}-panel-${value}`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? TABS[0]!
                  : event.key === "End"
                    ? TABS[TABS.length - 1]!
                    : TABS[
                        (TABS.indexOf(value) +
                          (event.key === "ArrowRight" ? 1 : -1) +
                          TABS.length) %
                          TABS.length
                      ]!;
              setTab(next);
              document.getElementById(`${id}-tab-${next}`)?.focus();
            }}
            className={`${buttonClass} ${tab === value ? "border-primary/30 bg-primary/10 text-primary" : "border-transparent"}`}
            onClick={() => setTab(value)}
          >
            {tt(en, cn)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-${tab}`}
        aria-labelledby={`${id}-tab-${tab}`}
        className="min-w-0 space-y-3"
      >
        {tab === "facts" && (
          <>
            <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <input
                type="search"
                className={inputClass}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={tt(
                  "Search facts or participants…",
                  "搜索事实或人物…",
                )}
                aria-label={tt("Search memory facts", "搜索记忆事实")}
              />
              <MemorySelect
                value={typeFilter}
                onValueChange={setTypeFilter}
                label={tt("Fact type", "事实类型")}
                options={[{ value: "", label: tt("All types", "所有类型") }, ...factTypes.map(type => ({ value: type, label: FACT_LABELS[type] ? tt(...FACT_LABELS[type]) : type }))]}
              />
              <MemorySelect
                value={factState}
                onValueChange={setFactState}
                label={tt("Fact status", "事实状态")}
                options={[{ value: "current", label: tt("Remembered", "已记住") }, { value: "expired", label: tt("Expired", "已失效") }, { value: "all", label: tt("All facts", "所有事实") }]}
              />
            </div>
            <p className="text-[11px] text-white/40">
              {visibleFacts.length} {tt("facts", "条事实")}
            </p>
            {visibleFacts.map((fact) => (
              <article
                key={fact.id}
                className="min-w-0 space-y-3 rounded-xl border border-white/10 bg-black/15 p-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-[10px] text-white/40">
                  <span className="rounded bg-white/5 px-1.5 py-0.5">
                    {FACT_LABELS[fact.fact_type]
                      ? tt(...FACT_LABELS[fact.fact_type])
                      : fact.fact_type}
                  </span>
                  {fact.pinned && (
                    <span className="text-primary">
                      {tt("Pinned", "已固定")}
                    </span>
                  )}
                  <span>
                    {tt("Turn", "轮次")} {fact.last_turn}
                  </span>
                  <span>
                    {tt("Importance", "重要度")} {fact.importance}/5
                  </span>
                  {fact.valid_until_turn !== null && (
                    <span>{tt("Later changed", "后来已改变")}</span>
                  )}
                  {fact.expired_ts !== null && (
                    <span>{tt("Expired", "已失效")}</span>
                  )}
                </div>
                {editId === fact.id ? (
                  <>
                    <textarea
                      className={`${inputClass} min-h-24 leading-relaxed`}
                      rows={4}
                      disabled={!!busy}
                      value={editText}
                      onChange={(event) => setEditText(event.target.value)}
                      aria-label={tt("Edit fact", "编辑事实")}
                    />
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        disabled={!!busy}
                        checked={editPinned}
                        onChange={(event) =>
                          setEditPinned(event.target.checked)
                        }
                      />
                      {tt(
                        "Prioritize this fact in recall",
                        "回忆时优先使用此事实",
                      )}
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={primaryButton}
                        disabled={!!busy || !editText.trim()}
                        onClick={() =>
                          void perform(
                            "fact",
                            { id: fact.id, text: editText, pinned: editPinned },
                            () => setEditId(null),
                          )
                        }
                      >
                        {tt("Save fact", "保存事实")}
                      </button>
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={!!busy}
                        onClick={() => setEditId(null)}
                      >
                        {tt("Cancel", "取消")}
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="break-words whitespace-pre-wrap text-xs leading-relaxed text-white/75">
                    {fact.text}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={!!busy}
                    onClick={() => startEdit(fact)}
                  >
                    {tt("Edit", "编辑")}
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={!!busy}
                    onClick={() =>
                      void perform("fact", {
                        id: fact.id,
                        pinned: !fact.pinned,
                      })
                    }
                  >
                    {fact.pinned ? tt("Unpin", "取消固定") : tt("Pin", "固定")}
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={!!busy}
                    onClick={() => {
                      setLineageId(fact.id);
                      setLineage(null);
                      void perform("lineage", { id: fact.id }, (result) =>
                        setLineage(
                          Array.isArray(result)
                            ? (result as Partial<StoryhavenFact>[])
                            : Array.isArray(object(result).facts)
                              ? (object(result)
                                  .facts as Partial<StoryhavenFact>[])
                              : [],
                        ),
                      );
                    }}
                  >
                    {tt("History", "变更历史")}
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={!!busy}
                    onClick={() =>
                      void perform("fact", {
                        id: fact.id,
                        expired: fact.expired_ts === null,
                      })
                    }
                  >
                    {fact.expired_ts === null
                      ? tt("Expire", "标记失效")
                      : tt("Restore", "恢复")}
                  </button>
                  <button
                    type="button"
                    className={`${buttonClass} text-red-200`}
                    disabled={!!busy}
                    onClick={() => setConfirm(`forget:${fact.id}`)}
                  >
                    {tt("Forget", "遗忘")}
                  </button>
                </div>
                {confirm === `forget:${fact.id}` && (
                  <div className="space-y-2 border-t border-white/10 pt-2">
                    <p className="text-xs">
                      {tt(
                        "Forget this fact and prevent the same source from adding it again?",
                        "遗忘此事实，并阻止相同来源再次添加它？",
                      )}
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={primaryButton}
                        disabled={!!busy}
                        onClick={() =>
                          void perform("forget", { id: fact.id }, () =>
                            setEditId(null),
                          )
                        }
                      >
                        {tt("Forget fact", "遗忘事实")}
                      </button>
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={!!busy}
                        onClick={() => setConfirm(null)}
                      >
                        {tt("Cancel", "取消")}
                      </button>
                    </div>
                  </div>
                )}
                {lineageId === fact.id && lineage !== null && (
                  <div className="space-y-2 border-t border-white/10 pt-2">
                    <h4 className="text-xs font-medium">
                      {tt("Earlier versions", "早期版本")}
                    </h4>
                    {lineage.length ? (
                      lineage.map((row, index) => (
                        <p
                          key={row.id ?? index}
                          className="break-words whitespace-pre-wrap text-xs leading-relaxed text-white/60"
                        >
                          {row.text}
                        </p>
                      ))
                    ) : (
                      <p className="text-xs text-white/40">
                        {tt("No earlier versions.", "没有早期版本。")}
                      </p>
                    )}
                  </div>
                )}
              </article>
            ))}
            {!visibleFacts.length && !loading && (
              <p className="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-white/40">
                {search || typeFilter
                  ? tt("No matching facts.", "没有匹配的事实。")
                  : tt(
                      "Facts will appear as the story progresses.",
                      "故事推进后，事实将显示在这里。",
                    )}
              </p>
            )}
          </>
        )}
        {tab === "clusters" && (
          <>
            {(status?.clusters ?? []).map((cluster, index) => (
              <article
                key={text(cluster.id) || index}
                className="space-y-2 rounded-xl border border-white/10 bg-black/15 p-3"
              >
                <h4 className="break-words text-xs font-semibold text-white/85">
                  {text(cluster.title) || tt("Story so far", "目前的故事")}
                </h4>
                <p className="break-words whitespace-pre-wrap text-xs leading-relaxed text-white/65">
                  {text(cluster.summary_text ?? cluster.summary)}
                </p>
                {typeof cluster.created_turn === "number" && (
                  <p className="text-[10px] text-white/35">
                    {tt("Updated at turn", "更新轮次")} {cluster.created_turn}
                  </p>
                )}
              </article>
            ))}
            {!status?.clusters?.length && (
              <p className="text-xs text-white/40">
                {tt(
                  "Story summaries appear once enough facts have been remembered.",
                  "记住足够的事实后，将生成故事摘要。",
                )}
              </p>
            )}
          </>
        )}
        {tab === "lore" && (
          <>
            {loreEntries.map((entry, index) => {
              const loreId = text(entry.id),
                hasOverride = savedOverrides.has(loreId),
                isHidden = entry.hidden === true || entry.hidden === 1,
                content =
                  overrides[loreId] ??
                  savedOverrides.get(loreId) ??
                  text(entry.content),
                secrets = Array.isArray(entry.secrets)
                  ? entry.secrets.map(object)
                  : [];
              return (
                <article
                  key={loreId || index}
                  className="min-w-0 space-y-3 rounded-xl border border-white/10 bg-black/15 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="break-words text-xs font-semibold text-white/85">
                      {isHidden
                        ? tt("Hidden lore", "隐藏设定")
                        : text(entry.name) || tt("Untitled lore", "未命名设定")}
                    </h4>
                    {hasOverride && (
                      <span className="text-[10px] text-primary">
                        {tt("Changed in this story", "此故事中的变更")}
                      </span>
                    )}
                  </div>
                  {isHidden ? (
                    <p className="text-xs text-white/50">
                      {tt(
                        "Hidden lore is shown one revealed detail at a time.",
                        "隐藏设定会随细节的揭示逐条显示。",
                      )}
                    </p>
                  ) : (
                    <>
                      <textarea
                        rows={3}
                        className={`${inputClass} leading-relaxed`}
                        disabled={!!busy}
                        value={content}
                        onChange={(event) =>
                          setOverrides((previous) => ({
                            ...previous,
                            [loreId]: event.target.value,
                          }))
                        }
                        aria-label={tt(
                          "Session lore content",
                          "当前故事的设定内容",
                        )}
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={primaryButton}
                          disabled={!!busy || !loreId || !content.trim()}
                          onClick={() =>
                            void perform("override", { loreId, content }, () =>
                              setOverrides((previous) => {
                                const next = { ...previous };
                                delete next[loreId];
                                return next;
                              }),
                            )
                          }
                        >
                          {tt("Save story override", "保存当前故事的变更")}
                        </button>
                        {hasOverride && (
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={!!busy}
                            onClick={() =>
                              void perform(
                                "override",
                                { loreId, content: null },
                                () =>
                                  setOverrides((previous) => {
                                    const next = { ...previous };
                                    delete next[loreId];
                                    return next;
                                  }),
                              )
                            }
                          >
                            {tt("Restore authored lore", "恢复原始设定")}
                          </button>
                        )}
                      </div>
                    </>
                  )}
                  {secrets.map((secret, secretIndex) => {
                    const secretId = text(secret.id ?? secret.secret_id),
                      revealed =
                        secret.revealed === true || revealedIds.has(secretId);
                    return (
                      secretId && (
                        <div
                          key={secretId}
                          className="flex flex-wrap items-start justify-between gap-2 border-t border-white/10 pt-2"
                        >
                          <p className="min-w-0 flex-1 break-words whitespace-pre-wrap text-xs leading-relaxed text-white/60">
                            {revealed
                              ? text(secret.text) ||
                                tt("Revealed detail", "已揭示的细节")
                              : `${tt("Hidden detail", "隐藏细节")} ${secretIndex + 1}`}
                          </p>
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={!!busy}
                            onClick={() =>
                              void perform("reveal", {
                                secretId,
                                revealed: !revealed,
                              })
                            }
                          >
                            {revealed
                              ? tt("Hide again", "重新隐藏")
                              : tt("Reveal", "揭示")}
                          </button>
                        </div>
                      )
                    );
                  })}
                </article>
              );
            })}
            {!loreEntries.length && (
              <p className="text-xs text-white/40">
                {tt(
                  "No authored lore is available for this story.",
                  "此故事没有可用的设定。",
                )}
              </p>
            )}
            {!!status?.reveals?.length && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold">
                  {tt("Revealed details", "已揭示的细节")}
                </h4>
                {status.reveals.map((reveal, index) => {
                  const secretId = text(reveal.secret_id ?? reveal.secretId);
                  return (
                    <div
                      key={secretId || index}
                      className="flex flex-wrap items-start gap-2 rounded-lg border border-white/10 p-3"
                    >
                      <p className="min-w-0 flex-1 break-words whitespace-pre-wrap text-xs">
                        {text(reveal.text ?? reveal.secret_text) ||
                          `${tt("Revealed detail", "已揭示的细节")} ${index + 1}`}
                      </p>
                      <button
                        type="button"
                        className={buttonClass}
                        disabled={!!busy || !secretId}
                        onClick={() =>
                          void perform("reveal", { secretId, revealed: false })
                        }
                      >
                        {tt("Hide again", "重新隐藏")}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
        {tab === "preview" && (
          <>
            <label htmlFor={`${id}-query`} className="block text-xs">
              {tt("Current story moment", "当前故事情境")}
            </label>
            <textarea
              id={`${id}-query`}
              rows={3}
              className={inputClass}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tt(
                "What should the story remember right now?",
                "此刻故事应当回忆什么？",
              )}
            />
            <button
              type="button"
              className={primaryButton}
              disabled={!!busy || !activeProfile}
              onClick={() =>
                void perform("preview", { query }, (result) => {
                  const data = object(result);
                  setPreview({
                    block: text(data.block),
                    usedIds: Array.isArray(data.usedIds)
                      ? data.usedIds.map(text)
                      : [],
                    droppedIds: Array.isArray(data.droppedIds)
                      ? data.droppedIds.map(text)
                      : [],
                  });
                })
              }
            >
              {tt("Preview recall", "预览回忆")}
            </button>
            {preview && (
              <div className="space-y-3">
                <p className="text-[11px] text-white/40">
                  {preview.usedIds.length} {tt("included", "条已包含")} ·{" "}
                  {preview.droppedIds.length}{" "}
                  {tt("reserved facts omitted", "条优先事实已省略")}
                </p>
                <p className="break-words whitespace-pre-wrap rounded-xl border border-white/10 bg-black/20 p-4 text-xs leading-relaxed text-white/75">
                  {preview.block ||
                    tt("No facts match this moment.", "没有匹配此情境的事实。")}
                </p>
                {!!preview.droppedIds.length && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-white/50">
                      {tt("Omitted facts", "省略的事实")}
                    </summary>
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-white/50">
                      {preview.droppedIds.map((factId) => {
                        const fact = facts.find((row) => row.id === factId),
                          entry = loreEntries.find(
                            (row) => row.id === factId.split("#")[0],
                          );
                        return (
                          <li key={factId} className="break-words">
                            {fact?.text ||
                              text(entry?.name) ||
                              tt("Lore passage", "设定段落")}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
