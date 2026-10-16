import { Checkbox } from "@/components/ui/checkbox";
import { Select } from "@/components/ui/select";
import { useEffect, useState } from "react";
import { ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { resolveImageUrl } from "@/lib/asset-url";
import { getSmartImageCapabilities, getSmartImageModel } from "@yumina/shared";
import type { StudioImageProposal } from "../lib/types";
import { ImageLightbox, type PreviewImage } from "@/components/image-lightbox";
import { useStudioStore } from "@/stores/studio";
import { useEditorStore } from "@/stores/editor";
import { feedback } from "@/lib/feedback";

interface ImageProposalCardProps {
  proposal: StudioImageProposal;
  /** Only the newest pending card gets buttons; older ones are records. */
  interactive: boolean;
  onConfirm: (edits: { prompt: string; aspectRatio: string; batchSize: number }) => void;
  onDecline: () => void;
}

/** Configured images run in the background; paid platform cards ask to start. */
export function ImageProposalCard(props: ImageProposalCardProps) {
  const { proposal } = props;
  // A replaced proposal starts a fresh draft. Progress updates keep typed edits.
  const key = JSON.stringify([proposal.runId, proposal.toolCallId, proposal.prompt, proposal.aspectRatio, proposal.batchSize]);
  return <ImageProposalForm key={key} {...props} />;
}

function ImageProposalForm({ proposal, interactive, onConfirm, onDecline }: ImageProposalCardProps) {
  const { t, i18n } = useTranslation("editor");
  const [prompt, setPrompt] = useState(proposal.prompt);
  const [aspectRatio, setAspectRatio] = useState(proposal.aspectRatio);
  const [batchSize, setBatchSize] = useState(proposal.batchSize);
  const [animaModels, setAnimaModels] = useState<Array<{ name: string; nsfwCapable: boolean }>>([]);
  const [recommendedAnimaModel, setRecommendedAnimaModel] = useState("");
  const [loadingAnimaModels, setLoadingAnimaModels] = useState(false);
  const [workflow, setWorkflow] = useState(proposal.imageWorkflow ?? (proposal.source === "codex" ? "codex" : "anima"));
  const [contentRating, setContentRating] = useState(proposal.contentRating ?? "sfw");
  const [transparent, setTransparent] = useState(proposal.transparent === true);
  const [animaModel, setAnimaModel] = useState(proposal.animaModel ?? "");
  const [seedMode, setSeedMode] = useState(proposal.seedMode ?? "random");
  const [seed, setSeed] = useState(proposal.seed === undefined ? "" : String(proposal.seed));
  const [cfg, setCfg] = useState(proposal.cfg ?? 1);
  const [steps, setSteps] = useState(proposal.steps ?? 8);
  const [savingOptions, setSavingOptions] = useState(false);
  const [optionsError, setOptionsError] = useState("");
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [removingReference, setRemovingReference] = useState("");
  const eligibleAnimaModels = contentRating === "nsfw" ? animaModels.filter(model => model.nsfwCapable) : animaModels;
  const effectiveAnimaModel = eligibleAnimaModels.find(model => model.name === animaModel)?.name
    ?? (contentRating === "nsfw" ? eligibleAnimaModels[0]?.name ?? "" : animaModel || recommendedAnimaModel);
  const worldId = useEditorStore(s => s.serverWorldId);
  const apiBase = import.meta.env.VITE_API_URL || "";
  const backgroundJob = !!proposal.source && !!proposal.jobId && /^[0-9a-f-]{36}$/i.test(proposal.jobId);
  const updateJob = (job: { status: string; jobId: string; elapsed?: number; assetIds?: string[]; errorCode?: string; errorMessage?: string;
    source?: StudioImageProposal["source"]; model?: string;
    referenceImages?: StudioImageProposal["referenceImages"]; referenceEditable?: boolean; assetStatus?: StudioImageProposal["assetStatus"];
    assetReason?: string; retryCount?: number; taskSummary?: StudioImageProposal["taskSummary"]; taskPreflight?: StudioImageProposal["taskPreflight"];
    animaEnabled?: boolean; animaModel?: string; animaModelEditable?: boolean; imageWorkflow?: StudioImageProposal["imageWorkflow"];
    contentRating?: StudioImageProposal["contentRating"]; transparent?: boolean; workflowOptions?: StudioImageProposal["workflowOptions"];
    workflowEditable?: boolean; generationOptionsEditable?: boolean; seedMode?: StudioImageProposal["seedMode"];
    seed?: number; cfg?: number; steps?: number; progressPhase?: string; progressPercent?: number }, syncOptions = false) => {
    const status = job.status === "succeeded" ? "done" : job.status === "failed" ? "failed" : job.status === "cancelled" ? "cancelled" : "generating";
    useStudioStore.setState(s => ({ chatMessages: s.chatMessages.map(message =>
      message.imageProposal?.runId === proposal.runId && message.imageProposal.toolCallId === proposal.toolCallId
        ? { ...message, imageProposal: { ...message.imageProposal, ...(job.source ? { source: job.source } : {}), ...(job.model ? { model: job.model } : {}),
          status, jobStatus: job.status, jobId: job.jobId, elapsed: job.elapsed,
          assetIds: job.assetIds, errorCode: job.errorCode, error: job.errorMessage ?? job.errorCode, ...(job.referenceImages ? { referenceImages: job.referenceImages } : {}),
          referenceEditable: job.referenceEditable, assetStatus: job.assetStatus, assetReason: job.assetReason, retryCount: job.retryCount,
          taskSummary: job.taskSummary, taskPreflight: job.taskPreflight, animaEnabled: job.animaEnabled,
          animaModel: job.animaModel, animaModelEditable: job.animaModelEditable,
          imageWorkflow: job.imageWorkflow, contentRating: job.contentRating, transparent: job.transparent, workflowOptions: job.workflowOptions,
          workflowEditable: job.workflowEditable, generationOptionsEditable: job.generationOptionsEditable,
          seedMode: job.seedMode, seed: job.seed, cfg: job.cfg, steps: job.steps,
          progressPhase: job.progressPhase, progressPercent: job.progressPercent } } : message) }));
    if (syncOptions) {
      if (job.imageWorkflow) setWorkflow(job.imageWorkflow);
      if (job.contentRating) setContentRating(job.contentRating);
      if (job.transparent !== undefined) setTransparent(job.transparent);
      if (job.animaModel) setAnimaModel(job.animaModel);
      if (job.seedMode) setSeedMode(job.seedMode);
      if (job.seed !== undefined) setSeed(String(job.seed));
      if (job.cfg !== undefined) setCfg(job.cfg);
      if (job.steps !== undefined) setSteps(job.steps);
    }
  };
  useEffect(() => {
    if (!proposal.animaEnabled && !proposal.workflowOptions?.anima) return;
    const controller = new AbortController();
    setLoadingAnimaModels(true);
    fetch(`${apiBase}/api/image-sources/generation/anima-models`, { credentials: "include", signal: controller.signal })
      .then(async response => { const data = await response.json();if (!response.ok) throw new Error(data?.error || "Local Anima checkpoints are unavailable.");return data; })
      .then(data => {
        if (controller.signal.aborted) return;
        const modelOptions = Array.isArray(data.modelOptions) ? data.modelOptions.filter((model: unknown): model is { name: string; nsfwCapable: boolean } => {
          if (!model || typeof model !== "object") return false;
          const option = model as Record<string, unknown>;
          return typeof option.name === "string" && typeof option.nsfwCapable === "boolean";
        }) : [];
        const models = modelOptions.length ? modelOptions : Array.isArray(data.models)
          ? data.models.filter((model: unknown): model is string => typeof model === "string").map((name: string) => ({ name, nsfwCapable: false })) : [];
        setAnimaModels(models);
        const recommended = typeof data.recommendedModel === "string" ? data.recommendedModel : models[0]?.name ?? "";
        setRecommendedAnimaModel(recommended);
        setAnimaModel(current => current || proposal.animaModel || recommended);
      })
      .catch(() => { if (!controller.signal.aborted) setAnimaModels([]); })
      .finally(() => { if (!controller.signal.aborted) setLoadingAnimaModels(false); });
    return () => controller.abort();
  }, [apiBase, proposal.animaEnabled, proposal.workflowOptions?.anima, proposal.animaModel]);
  useEffect(() => {
    if (!backgroundJob || !worldId || !["generating", "stillGenerating"].includes(proposal.status)) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`${apiBase}/api/studio/${worldId}/agent/image-jobs/${proposal.jobId}`, { credentials: "include", signal: controller.signal });
        if (!response.ok) return;
        const { data } = await response.json();
        if (!controller.signal.aborted && data) updateJob(data);
      } catch { /* Temporary disconnection: retain the card and retry. */ }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 3000);
    return () => { controller.abort();clearInterval(timer); };
    // The stable job identity controls polling; status updates must not restart it each tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, backgroundJob, worldId, proposal.jobId, proposal.runId, proposal.toolCallId, proposal.status]);
  const cancelImage = async () => {
    if (!worldId || !backgroundJob || cancelling) return;
    setCancelling(true);
    try {
      const response = await fetch(`${apiBase}/api/studio/${worldId}/agent/image-jobs/${proposal.jobId}/cancel`, { method: "POST", credentials: "include" });
      if (response.ok) { const { data } = await response.json();if (data) updateJob(data); }
    } catch { feedback.error(t("studio.aiChat.imageProposal.cancelFailed", { defaultValue: "Could not cancel the image yet. Try again." })); }
    finally { setCancelling(false); }
  };
  const removeReference = async (ref: NonNullable<StudioImageProposal["referenceImages"]>[number]) => {
    if (!worldId || !backgroundJob || !proposal.referenceEditable || removingReference) return;
    const key = ref.assetRef ?? ref.key;
    setRemovingReference(key);
    try {
      const response = await fetch(`${apiBase}/api/studio/${worldId}/agent/image-jobs/${proposal.jobId}/references/remove`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ key }),
      });
      if (response.ok) { const { data } = await response.json();if (data) updateJob(data); }
      else feedback.error(t("studio.aiChat.imageProposal.referenceRemoveFailed", { defaultValue: "This reference can no longer be changed." }));
    } catch { feedback.error(t("studio.aiChat.imageProposal.referenceRemoveFailed", { defaultValue: "This reference can no longer be changed." })); }
    finally { setRemovingReference(""); }
  };
  const saveGenerationOptions = async () => {
    if (!worldId || !backgroundJob || !proposal.generationOptionsEditable || savingOptions) return;
    const parsedSeed = seedMode === "fixed" ? Number(seed) : undefined;
    if (seedMode === "fixed" && (!Number.isSafeInteger(parsedSeed) || parsedSeed! < 0)) {
      setOptionsError("Enter a whole-number seed between 0 and 9,007,199,254,740,991."); return;
    }
    setSavingOptions(true); setOptionsError("");
    try {
      const response = await fetch(`${apiBase}/api/studio/${worldId}/agent/image-jobs/${proposal.jobId}/generation-options`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ workflow, contentRating, ...(workflow === "anima" && effectiveAnimaModel ? { animaModel: effectiveAnimaModel } : {}),
          seedMode, ...(seedMode === "fixed" ? { seed: parsedSeed } : {}), cfg, steps, transparent }),
      });
      const result = await response.json();
      if (result?.data) updateJob(result.data, true);
      if (!response.ok) {
        const message = typeof result?.error === "string" ? result.error : "Generation options could not be saved.";
        setOptionsError(message); feedback.error(message);
      }
    } catch { setOptionsError("Could not save generation options. Try again while the job is queued."); }
    finally { setSavingOptions(false); }
  };
  // The assistant chooses the generator, and they differ by about four times in
  // price and in which shapes they can draw — so name it, and offer exactly the
  // ratios THAT model accepts. A hardcoded list here used to show seven while
  // the generator had grown to fourteen, which left the assistant's own pick
  // rendering as a blank dropdown.
  const configuredProvider = proposal.source === "codex" || proposal.source === "comfyui" || proposal.source === "forgeneo" || proposal.source === "openai";
  const providerName = proposal.source === "codex" ? "Codex account" : proposal.source === "comfyui" ? "ComfyUI" : "Forge Neo";
  const model = configuredProvider ? undefined : getSmartImageModel(proposal.model);
  const aspectOptions = configuredProvider ? [] : getSmartImageCapabilities(proposal.model).aspectRatios;
  const format = (value: number) => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value);
  const estimate = Math.ceil(proposal.unitMushies * batchSize * 10) / 10;
  const pending = proposal.status === "pending";
  const queued = backgroundJob && proposal.status === "generating" && proposal.jobStatus === "queued";
  const nsfwAnimaModels = animaModels.filter(model => model.nsfwCapable);
  const nsfwAvailable = proposal.workflowOptions?.krea || (proposal.workflowOptions?.anima && nsfwAnimaModels.length > 0);
  const updateWorkflow = (value: "anima" | "krea" | "codex") => {
    if (contentRating === "nsfw" && (value === "codex" || (value === "anima" && !nsfwAnimaModels.length))) return;
    setWorkflow(value);
    if (value === "anima" && contentRating === "nsfw") setAnimaModel(effectiveAnimaModel);
  };
  const updateContentRating = (value: "sfw" | "nsfw") => {
    if (value === "nsfw" && !nsfwAvailable) return;
    setContentRating(value);
    if (value === "sfw") {
      if (proposal.workflowOptions?.codex) setWorkflow("codex");
    } else if (workflow === "anima" && nsfwAnimaModels.length) {
      setAnimaModel(nsfwAnimaModels.find(model => model.name === animaModel)?.name ?? nsfwAnimaModels[0]!.name);
    } else if (proposal.workflowOptions?.krea) {
      setWorkflow("krea");
    } else {
      setWorkflow("anima"); setAnimaModel(nsfwAnimaModels[0]!.name);
    }
  };
  const canConfirm = interactive && pending && prompt.trim().length > 0;
  const buttonClass = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11";
  const title = queued ? t("studio.aiChat.imageProposal.queued", { defaultValue: "Image queued" })
    : proposal.status === "generating" ? t("studio.aiChat.imageProposal.generating")
    : proposal.status === "done" ? t("studio.aiChat.imageProposal.done", { count: proposal.assetIds?.length ?? 0 })
      : proposal.status === "failed" ? t("studio.aiChat.imageProposal.failed")
        : proposal.status === "declined" ? t("studio.aiChat.imageProposal.declined")
          : proposal.status === "cancelled" ? t("studio.aiChat.imageProposal.cancelled", { defaultValue: "Image generation cancelled" })
          : proposal.status === "stillGenerating" ? t("studio.aiChat.imageProposal.stillGenerating")
            : t("studio.aiChat.imageProposal.title");

  return (
    <section
      className={cn("mt-2 min-w-0 rounded-xl border border-primary/25 bg-primary/5 p-3 text-xs", proposal.status === "done" && "border-emerald-500/20 bg-emerald-500/5", proposal.status === "failed" && "border-destructive/30 bg-destructive/5")}
      aria-live="polite"
      data-image-proposal-run={proposal.runId}
    >
      <div className="flex items-center gap-2 font-medium text-foreground" role="status">
        {proposal.status === "generating" ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
          : <ImagePlus className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
        <span>{title}</span>
      </div>
      {proposal.purpose && <p className="mt-1 break-words text-muted-foreground">{proposal.purpose}</p>}
      {proposal.assetStatus === "verified" && <p className="mt-1 text-[10px] text-emerald-300" role="status">
        {t("studio.aiChat.imageProposal.assignmentVerified", { defaultValue: "Added to its scene or character and verified." })}
      </p>}
      {proposal.assetStatus === "unassigned" && <p className="mt-1 break-words text-[10px] text-amber-300" role="status">
        {t("studio.aiChat.imageProposal.assignmentUnassigned", { defaultValue: "Saved in your library. {{reason}}", reason: proposal.assetReason ?? "No safe target slot was available." })}
      </p>}
      {!!proposal.referenceImages?.length && (
        <div className="mt-2">
          <p className="text-muted-foreground">{t("studio.aiChat.imageProposal.references", { defaultValue: "Reference images ({{count}})", count: proposal.referenceImages.length })}</p>
          {proposal.contentRating === "nsfw" && <p className="mt-1 text-[10px] text-muted-foreground">
            {t("studio.aiChat.imageProposal.textOnlyReferences", { defaultValue: "Text-to-image only. The vision model describes these references for the prompt." })}
          </p>}
          <div className="mt-1 flex flex-wrap gap-2">
            {proposal.referenceImages.map((ref, index) => <div key={ref.key} className="flex w-20 flex-col items-center gap-1">
              <button type="button" className="rounded-md cursor-zoom-in focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("studio.aiChat.previewAttachment", { defaultValue: "Preview image {{name}}", name: ref.name })}
                onClick={() => { const src = resolveImageUrl(ref.url);if (src) setPreviewImage({ src, alt: ref.name }); }}>
                <img src={resolveImageUrl(ref.url)} alt={t("studio.aiChat.imageProposal.referenceAlt", { defaultValue: "Reference image {{number}}", number: index + 1 })}
                  className="h-16 w-16 rounded-md border border-border bg-background object-contain" loading="lazy" />
              </button>
              <div className="flex max-w-full items-center gap-1">
                <span className="max-w-[60px] truncate text-[9px] text-muted-foreground" title={ref.name}>
                  {t(`studio.aiChat.imageProposal.referenceRole.${ref.role ?? "creator"}`, { defaultValue: ({ identity: "Identity", environment: "Environment", style: "Style", creator: "Your image" } as Record<string, string>)[ref.role ?? "creator"] })}
                </span>
                {backgroundJob && proposal.referenceEditable && queued && <button type="button" disabled={removingReference === (ref.assetRef ?? ref.key)}
                  aria-label={t("studio.aiChat.imageProposal.removeReference", { defaultValue: "Remove {{name}} reference", name: ref.name })}
                  onClick={() => { void removeReference(ref); }}
                  className="rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
                  {removingReference === (ref.assetRef ?? ref.key) ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <X className="h-2.5 w-2.5" />}
                </button>}
              </div>
            </div>)}
          </div>
        </div>
      )}
      {configuredProvider && (
        <div className="mt-2 space-y-1 break-words text-muted-foreground">
          <p className="font-medium text-foreground">{proposal.imageWorkflow === "codex" ? "Codex image generation · GPT-6.1 Sol · xhigh"
            : proposal.imageWorkflow === "krea" ? "Local Krea2-Anime v2.0 INT4"
              : `${providerName}${proposal.source !== "openai" && proposal.model !== providerName ? ` · ${proposal.model}` : ""}`}</p>
          <p>{proposal.source === "codex" ? "Uses the shared Codex account and its included image allowance." : t("studio.aiChat.imageProposal.configuredProviderNote", {
            defaultValue: "Uses your configured image server.",
          })}</p>
          {proposal.imageWorkflow === "codex" && <p>Codex selects its native image model automatically.</p>}
          {proposal.contentRating === "nsfw" && <p>NSFW generation is enabled for this local model.</p>}
          {proposal.imageWorkflow !== "codex" && proposal.status !== "pending" && <p>
            {proposal.seedMode === "fixed" ? `Fixed seed · ${proposal.seed ?? seed}` : "Random seed"} · {proposal.steps ?? steps} steps · CFG {proposal.cfg ?? cfg}
          </p>}
          {proposal.imageKind === "sprite" && <p>{proposal.transparent
            ? proposal.imageWorkflow === "anima" ? "Local Anima sprite · adaptive chroma and BiRefNet transparency extraction · PNG."
              : proposal.imageWorkflow === "krea" ? "Local Krea sprite · BiRefNet transparency extraction · PNG."
                : proposal.source === "codex" ? "Requests a transparent PNG sprite."
                  : proposal.source === "comfyui"
                    ? t("studio.aiChat.imageProposal.comfySpriteNote", { defaultValue: "Green background is removed after generation; saved as transparent PNG." })
                    : t("studio.aiChat.imageProposal.forgeNeoSpriteNote", { defaultValue: "Green background is removed after generation; saved as transparent PNG." })
            : "Opaque sprite output · generated background is preserved."}</p>}
          {proposal.imageKind === "background" && proposal.imageWorkflow === "krea" && <p>Local Krea background · opaque scene output; no background removal. Krea can generate NSFW backgrounds when NSFW is selected.</p>}
        </div>
      )}

      {backgroundJob && queued && proposal.imageWorkflow && proposal.generationOptionsEditable && proposal.workflowOptions && (
        <div className="mt-3 space-y-2 rounded-lg border border-border/70 bg-background/60 p-2.5">
          <p className="font-medium text-foreground">Generation options</p>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            <span>Content rating</span>
            <Select compact aria-label="Image content rating" value={contentRating} onValueChange={selectedValue => updateContentRating(selectedValue as "sfw" | "nsfw")}
              disabled={savingOptions} className="min-h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground">
              <option value="sfw">SFW</option><option value="nsfw" disabled={!nsfwAvailable}>NSFW</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            <span>Image generator</span>
            <Select compact aria-label="Image generation workflow" value={workflow} onValueChange={selectedValue => updateWorkflow(selectedValue as "anima" | "krea" | "codex")}
              disabled={savingOptions} className="min-h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground">
              {(proposal.workflowOptions.anima || proposal.workflowOptions.krea) && <optgroup label="NSFW-capable">
                {proposal.workflowOptions.anima && <option value="anima" disabled={contentRating === "nsfw" && !nsfwAnimaModels.length}>Anima</option>}
                {proposal.workflowOptions.krea && <option value="krea">Krea</option>}
              </optgroup>}
              {proposal.workflowOptions.codex && contentRating !== "nsfw" && <optgroup label="SFW">
                <option value="codex">Codex</option>
              </optgroup>}
            </Select>
          </label>
          {contentRating === "nsfw" && <p className="text-[11px] text-muted-foreground">SFW-only generators are excluded. References are described by the vision model for text-to-image generation.</p>}
          {workflow === "anima" && <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
            <span>Local Anima checkpoint</span>
            <Select compact aria-label="Local Anima checkpoint" value={effectiveAnimaModel}
              disabled={savingOptions || loadingAnimaModels || eligibleAnimaModels.length === 0}
              onValueChange={selectedValue => setAnimaModel(selectedValue)}
              className="min-h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground disabled:opacity-60">
              {loadingAnimaModels && <option value="">Loading installed checkpoints…</option>}
              {!loadingAnimaModels && eligibleAnimaModels.map(option => <option key={option.name} value={option.name}>
                {option.name}{option.nsfwCapable ? " · NSFW-capable" : " · SFW"}
              </option>)}
            </Select>
            <span>{contentRating === "nsfw" ? "Only NSFW-capable checkpoints are available." : "Choose any installed Anima checkpoint."}</span>
          </label>}
          {proposal.imageKind === "sprite" && <label className="flex items-start gap-2 text-[11px] text-muted-foreground">
            <Checkbox  checked={transparent} disabled={savingOptions}
              onCheckedChange={checked => setTransparent((checked === true))} className="mt-0.5 accent-primary" />
            <span><span className="font-medium text-foreground">Transparent background</span><br />Extract a cutout only when you need alpha transparency. Leave off to preserve the generated background.</span>
          </label>}
          {workflow === "anima" || workflow === "krea" ? <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              CFG
              <input type="number" min={0.5} max={8} step={0.1} value={cfg} disabled={savingOptions}
                onChange={event => setCfg(Number(event.target.value))} className="min-h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Steps
              <input type="number" min={1} max={20} step={1} value={steps} disabled={savingOptions}
                onChange={event => setSteps(Number(event.target.value))} className="min-h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Seed
              <Select compact value={seedMode} disabled={savingOptions} onValueChange={selectedValue => setSeedMode(selectedValue as "random" | "fixed")}
                className="min-h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground">
                <option value="random">Random seed</option><option value="fixed">Fixed seed</option>
              </Select>
            </label>
            {seedMode === "fixed" && <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              Seed value
              <input type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={seed} disabled={savingOptions}
                onChange={event => setSeed(event.target.value)} className="min-h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground" />
            </label>}
          </div> : <p className="text-[11px] text-muted-foreground">Uses Codex native image generation; fixed seed and CFG controls are not exposed by this path.</p>}
          {optionsError && <p className="text-[11px] text-destructive" role="alert">{optionsError}</p>}
          <button type="button" disabled={savingOptions || !proposal.generationOptionsEditable}
            onClick={() => { void saveGenerationOptions(); }} className={cn(buttonClass, "w-full border-transparent bg-primary text-primary-foreground hover:brightness-110")}>
            {savingOptions ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
            Apply before generation starts
          </button>
        </div>
      )}

      {pending ? (
        <>
          <label className="mt-3 block text-[11px] font-medium text-muted-foreground" htmlFor={`image-proposal-prompt-${proposal.toolCallId}`}>
            {t("studio.aiChat.imageProposal.promptLabel")}
          </label>
          <textarea
            id={`image-proposal-prompt-${proposal.toolCallId}`}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={!interactive}
            rows={3}
            className="mt-1 w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
          />
          {!configuredProvider && <div className="mt-2 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              {t("studio.aiChat.imageProposal.aspect")}
              <Select compact value={aspectRatio} onValueChange={(selectedValue) => setAspectRatio(selectedValue)} disabled={!interactive}
                className="min-h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground">
                {aspectOptions.map((a) => <option key={a} value={a}>{a}</option>)}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              {t("studio.aiChat.imageProposal.count")}
              <Select compact value={batchSize} onValueChange={(selectedValue) => setBatchSize(Number(selectedValue))} disabled={!interactive}
                className="min-h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground">
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
            </label>
            <span className="ml-auto flex flex-col items-end gap-0.5 text-right">
              <span className="tabular-nums text-foreground">
                {t("studio.aiChat.imageProposal.estimate", { amount: format(estimate) })}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {model?.name ?? proposal.model}
                {proposal.resolution ? ` · ${proposal.resolution === "512" ? "0.5K" : proposal.resolution}` : ""}
              </span>
            </span>
          </div>}
          {!configuredProvider && proposal.modelReason && (
            // Fixed disclosure: which generator, and why, every time — the
            // prices differ by more than ten times, and a creator agreeing to
            // spend should not have to dig it out of the assistant's prose.
            <p className="mt-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">{model?.name ?? proposal.model}</span>
              {" · "}
              {proposal.modelReason}
            </p>
          )}
          {!configuredProvider && <p className="mt-1 text-muted-foreground">{t("studio.aiChat.imageProposal.estimateNote")}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" disabled={!canConfirm} onClick={() => onConfirm({ prompt: prompt.trim(), aspectRatio, batchSize: configuredProvider ? 1 : batchSize })}
              className={cn(buttonClass, "border-transparent bg-primary text-primary-foreground hover:brightness-110")}>
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {t("studio.aiChat.imageProposal.confirm")}
            </button>
            <button type="button" disabled={!interactive} onClick={onDecline}
              className={cn(buttonClass, "border-border bg-background text-foreground hover:bg-muted")}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              {t("studio.aiChat.imageProposal.decline")}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-2 break-words text-muted-foreground">{proposal.prompt}</p>
      )}

      {proposal.status === "generating" && (
        <p className="mt-2 text-muted-foreground">
          {queued ? t("studio.aiChat.imageProposal.queuedDetail", { defaultValue: "Waiting for an image slot. The agent can continue other work." })
            : backgroundJob ? t("studio.aiChat.imageProposal.backgroundDetail", { defaultValue: "Drawing in the background · {{seconds}}s. The agent can continue other work.", seconds: proposal.elapsed ?? 0 })
            : t("studio.aiChat.imageProposal.generatingDetail", { seconds: proposal.elapsed ?? 0 })}
        </p>
      )}
      {(proposal.imageWorkflow === "anima" || proposal.imageWorkflow === "krea") && backgroundJob && proposal.progressPhase && proposal.status === "generating" && !queued && (
        <p className="mt-1 text-[10px] text-muted-foreground" role="status">
          {({ preparing: "Preparing references", queued: "Queued in ComfyUI", generating: "Generating sprite", segmenting: "Segmenting character", processing: "Extracting transparency", saving: "Saving PNG", complete: "Complete" } as Record<string, string>)[proposal.progressPhase] ?? "Working"}
          {typeof proposal.progressPercent === "number" ? ` · ${proposal.progressPercent}%` : ""}
        </p>
      )}
      {backgroundJob && ["generating", "stillGenerating"].includes(proposal.status) && <button type="button" disabled={cancelling} onClick={() => { void cancelImage(); }}
        className={cn(buttonClass, "mt-2 border-border bg-background text-foreground hover:bg-muted")}>
        <X className="h-3.5 w-3.5" aria-hidden="true" />{t("studio.aiChat.imageProposal.cancel", { defaultValue: "Cancel image generation" })}
      </button>}
      {proposal.status === "done" && proposal.assetIds && proposal.assetIds.length > 0 && (
        <>
          <div className={cn("mt-3 grid gap-2", proposal.assetIds.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
            {proposal.assetIds.map((assetId) => (
              <button key={assetId} type="button" onClick={() => { const src = resolveImageUrl(assetId);if (src) setPreviewImage({ src, alt: proposal.purpose ?? "Generated image" }); }}
                aria-label={t("studio.aiChat.previewAttachment", { defaultValue: "Preview image {{name}}", name: proposal.purpose ?? "Generated image" })}
                className="block overflow-hidden rounded-lg border border-border/60 bg-background cursor-zoom-in focus-visible:ring-2 focus-visible:ring-ring"
                >
                {/* The plain /cdn path: the creator is inspecting the delivery, and it
                    works without the edge resizer (local dev, transform switched off). */}
                <img src={resolveImageUrl(assetId)} alt="" loading="lazy" decoding="async" className={cn("block w-full", configuredProvider ? "max-h-96 object-contain" : "object-cover")} />
              </button>
            ))}
          </div>
          <p className="mt-2 tabular-nums text-muted-foreground">
            {!configuredProvider && typeof proposal.costMushies === "number"
              ? t("studio.aiChat.imageProposal.charged", { amount: format(proposal.costMushies) })
              : t("studio.aiChat.imageProposal.savedNote")}
          </p>
        </>
      )}
      {proposal.status === "failed" && (
        <p className="mt-2 break-words text-destructive" role="alert">
          {proposal.errorCode === "NSFW_IMAGE_REQUEST" ? "Image generation is disabled for NSFW requests. No image was generated."
            : t("studio.aiChat.imageProposal.failedDetail", { code: proposal.error ?? "" })}
        </p>
      )}
      {proposal.status === "stillGenerating" && (
        <p className="mt-2 text-muted-foreground">{t("studio.aiChat.imageProposal.stillGeneratingDetail")}</p>
      )}
      <ImageLightbox image={previewImage} onClose={() => setPreviewImage(null)} />
    </section>
  );
}
