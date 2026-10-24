import { useState, useRef, useEffect, useCallback, useMemo, memo } from "react";
import type { ReactNode } from "react";
import {
  Send,
  Loader2,
  User,
  Sparkles,
  Trash2,
  Square,
  Paperclip,
  X,
  FileCode,
  MessageSquare,
  Plus,
  Trash,
  GripHorizontal,
  Undo2,
  RefreshCw,
  PlugZap,
  AlertTriangle,
  ChevronDown,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Select } from "@/components/ui/select";
import { ImageLightbox, type PreviewImage } from "@/components/image-lightbox";
import { ImageImportDialog, type ImageImportContext } from "@/components/image-import-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useComposerSubmit } from "@/lib/composer-submit";
import { getImageFilesFromTransfer } from "@/lib/clipboard-image";
import { useStudioStore, watchStudioImageNotifications } from "@/stores/studio";
import { useEditorStore } from "@/stores/editor";
import { useCreditStore } from "@/edition/slots.state";
import { useFeature } from "@/edition/edition";
import { getPlansHref } from "@/edition/routes";
import { useUserProfileStore } from "@/stores/user-profile";
import { describeStudioTrace, normalizeStudioOutputLanguage, STUDIO_OUTPUT_LANGUAGES, type StudioOutputLanguage, type StudioTraceItem } from "@yumina/shared";
import { renderStudioMarkdown } from "@/lib/studio-markdown";
import { StreamingText } from "../components/streaming-text";
import { StudioProfilePicker } from "../components/studio-profile-picker";
import { ProposalCard } from "../components/proposal-card";
import { TaskStatusCard } from "../components/task-status-card";
import { CreditPauseCard } from "../components/credit-pause-card";
import { ImageProposalCard } from "../components/image-proposal-card";
import { QuestionAnswerCard } from "../components/question-answer-card";
import { ImageBatchProposalCard } from "../components/image-batch-proposal-card";
import { AgentTrace } from "../components/agent-trace";
import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import { classifyUsage, estimateHistoryTokens, getContextBudget, type ContextHealth } from "../lib/context-tokens";
import { getStudioQuestionReplies, isReadTool, serializeStudioChatMessages } from "../lib/types";
import type { StudioChatMessage, StudioImageProposal, ToolCall } from "../lib/types";

const MIN_INPUT_HEIGHT = 48;
const PASTED_IMAGE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function PendingImageAttachment({ file, label, onPreview }: {
  file: File;
  label: string;
  onPreview: (image: PreviewImage) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    if (imageRef.current) imageRef.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        const src = imageRef.current?.src;
        if (src) onPreview({ src, alt: file.name });
      }}
      className="block rounded-lg cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img ref={imageRef} alt={file.name} className="h-12 w-12 rounded-lg object-cover border border-border/50" />
    </button>
  );
}

type ImageTaskSummary = { total: number; queued: number; running: number; failed: number; completed: number;
  assigned: number; verified: number; unassigned: number; phase: string; preflight?: StudioImageProposal["taskPreflight"] };

function ImageTaskOutcome({ summary }: { summary: ImageTaskSummary }) {
  const { t } = useTranslation("editor");
  return <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2 text-[10px]" role="status">
    <span className="inline-flex items-center gap-1 font-semibold text-foreground"><Sparkles className="h-3 w-3 text-primary" aria-hidden="true" />
      {t("studio.aiChat.imageTask.title", { defaultValue: "Image task" })}</span>
    <span className="text-muted-foreground">{summary.total} {t("studio.aiChat.imageTask.assets", { defaultValue: "images" })}</span>
    {!!summary.completed && <span className="text-muted-foreground">{summary.completed} {t("studio.aiChat.imageTask.generated", { defaultValue: "generated" })}</span>}
    {!!summary.assigned && <span className="text-emerald-300">{summary.assigned} {t("studio.aiChat.imageTask.assigned", { defaultValue: "assigned" })}</span>}
    {!!summary.verified && <span className="text-emerald-300">{summary.verified} {t("studio.aiChat.imageTask.verified", { defaultValue: "verified" })}</span>}
    {!!summary.unassigned && <span className="text-amber-300">{summary.unassigned} {t("studio.aiChat.imageTask.library", { defaultValue: "saved in library" })}</span>}
    {!!summary.failed && <span className="text-destructive">{summary.failed} {t("studio.aiChat.imageTask.failed", { defaultValue: "failed" })}</span>}
    {!!summary.running && <span className="text-primary">{summary.running} {t("studio.aiChat.imageTask.generating", { defaultValue: "generating" })}</span>}
    {!!summary.queued && <span className="text-muted-foreground">{summary.queued} {t("studio.aiChat.imageTask.queued", { defaultValue: "queued" })}</span>}
    {summary.preflight && <span className={summary.preflight.clean ? "text-emerald-300" : "text-amber-300"}>
      {summary.preflight.clean ? t("studio.aiChat.imageTask.preflightClear", { defaultValue: "Preflight clear" })
        : t("studio.aiChat.imageTask.preflightIssues", { defaultValue: "Preflight: {{count}} blocking issue(s)", count: summary.preflight.errors.length })}
    </span>}
    <span className="ml-auto text-muted-foreground">{t("studio.aiChat.imageTask.detailsHint", { defaultValue: "Expand activity for details" })}</span>
  </div>;
}

function LittleIdotAvatar({ className }: { className?: string }) {
  return (
    <img
      src="/little-idot.png"
      alt="Little Idot"
      decoding="async"
      className={cn("h-5 w-5 shrink-0 rounded-full object-cover", className)}
    />
  );
}

function isCurrentStudioWorld(worldId: string) {
  return useEditorStore.getState().serverWorldId === worldId;
}

/** Tailwind classes per health band — kept alongside the indicator so the
 *  bar, text, and nudge button stay visually consistent when bands shift.
 *  `label` uses `as const` to preserve literal keys for the typed i18n t() call. */
const HEALTH_STYLES = {
  fresh:       { bar: "bg-emerald-400", text: "text-muted-foreground", label: "studio.aiChat.contextFresh" },
  comfortable: { bar: "bg-emerald-400", text: "text-muted-foreground", label: "studio.aiChat.contextComfortable" },
  filling:     { bar: "bg-amber-400",   text: "text-amber-300",        label: "studio.aiChat.contextFilling" },
  tight:       { bar: "bg-orange-400",  text: "text-orange-300",       label: "studio.aiChat.contextTight" },
  compacting:  { bar: "bg-red-400",     text: "text-red-300",          label: "studio.aiChat.contextCompacting" },
} as const satisfies Record<ContextHealth, { bar: string; text: string; label: string }>;

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return `${n}`;
}
/** Replaces the chat bubble when the stream died mid-run.
 *
 *  The agent normally survives a dropped stream: the server keeps iterating and
 *  writes its result to agent_runs. So the leading action is Reconnect, which is
 *  read-only (a status poll, never a model call) and therefore free. Resend is
 *  demoted and says out loud that it charges again, because it used to be the
 *  only thing on offer and it re-does work the server had already finished. */
function DisconnectedCard({ dead, busy, onReconnect, onResend }: {
  dead: boolean;
  busy: boolean;
  onReconnect: () => void;
  onResend: () => void;
}) {
  const { t } = useTranslation("editor");
  const tone = dead
    ? { border: "border-destructive/25", bg: "bg-destructive/5", title: "text-destructive", body: "text-destructive/75" }
    : { border: "border-amber-500/25", bg: "bg-amber-500/5", title: "text-amber-300", body: "text-amber-200/70" };
  return (
    <div className={cn("rounded-lg border px-3 py-2.5", tone.border, tone.bg)}>
      <div className={cn("flex items-center gap-1.5 text-[11px] font-semibold", tone.title)}>
        <AlertTriangle className="h-3 w-3 shrink-0" />
        {t(dead ? "studio.aiChat.disconnectedDeadTitle" : "studio.aiChat.disconnectedTitle")}
      </div>
      <p className={cn("mt-0.5 text-[10.5px] leading-relaxed", tone.body)}>
        {dead ? t("studio.aiChat.reconnectNoNewWork", { defaultValue: "No newer result is available. Completed work is kept; send a new request to continue." }) : t("studio.aiChat.disconnectedBody")}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!dead && (
          <button
            onClick={onReconnect}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {busy
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <PlugZap className="h-3 w-3" />}
            {t("studio.aiChat.reconnect")}
          </button>
        )}
        <button
          onClick={onResend}
          disabled={busy}
          className={cn(
            "rounded-md px-2.5 py-1 text-[11px] transition-colors disabled:opacity-60",
            dead
              ? "bg-primary font-semibold text-primary-foreground hover:opacity-90"
              : "border border-border text-muted-foreground hover:text-foreground",
          )}
        >
          {t("studio.aiChat.resend")}
        </button>
        {!dead && (
          <span className="text-[9.5px] text-muted-foreground/70">
            {t("studio.aiChat.resendCharges")}
          </span>
        )}
      </div>
    </div>
  );
}

const MAX_INPUT_HEIGHT = 320;

/** Memoized markdown renderer for historical messages.
 *  `content` is immutable once a message is in chatMessages, so memo
 *  prevents re-running Markdown parsing and sanitization on every parent render. */
const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  return (
    <div
      className="studio-markdown text-xs text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      dangerouslySetInnerHTML={{ __html: renderStudioMarkdown(content) }}
    />
  );
});

/** Token-based context meter. Shows a progressive bar + nudges the user to
 *  start a fresh conversation as usage climbs. Server starts summarizing older
 *  messages once usage exceeds the budget (buildWindowedMessages) — the bar
 *  warns before that so the user can branch instead of losing nuance silently. */
function ContextUsageBar({
  messages,
  model,
  onStartFresh,
}: {
  messages: import("@/features/studio/lib/types").StudioChatMessage[];
  model: string;
  onStartFresh: () => void;
}) {
  const { t } = useTranslation("editor");
  const historyTokens = useStudioStore(state => state.agentHistoryTokens);
  const compaction = useStudioStore(state => state.agentCompaction);
  const usage = useMemo(() => {
    const budget = getContextBudget(model);
    const used = historyTokens ?? estimateHistoryTokens(messages);
    return classifyUsage(used, budget);
  }, [messages, model, historyTokens]);

  // Don't show the bar when the chat is basically empty — the meter is noise
  // at 1–2 messages and only becomes useful once there's a real conversation.
  if (messages.length < 3) return null;

  const style = HEALTH_STYLES[usage.health];
  const clampedPct = Math.min(100, usage.percent);
  const showNudge = usage.health === "filling" || usage.health === "tight" || usage.health === "compacting";

  return (
    <div className="border-b border-border/50 px-3 py-1.5 space-y-1">
      {compaction?.status === "summarizing" && <p role="status" className="text-[10px] text-muted-foreground">Summarizing context toward 10k tokens…</p>}
      <div className="flex items-center gap-2">
        <div className="relative h-1 flex-1 rounded-full bg-muted/50 overflow-hidden">
          <div
            className={cn("absolute inset-y-0 left-0 rounded-full transition-all", style.bar)}
            style={{ width: `${clampedPct}%` }}
          />
        </div>
        <span className={cn("text-[10px] tabular-nums", style.text)}>
          {formatTokens(usage.usedTokens)} / {formatTokens(usage.budgetTokens)}
          <span className="text-muted-foreground/60"> · {Math.round(usage.percent)}%</span>
        </span>
        {showNudge && (
          <button
            onClick={onStartFresh}
            className="shrink-0 text-[10px] text-primary hover:underline"
          >
            {t("studio.aiChat.startFresh")}
          </button>
        )}
      </div>
      {showNudge && (
        <p className={cn("text-[10px] leading-tight", style.text)}>
          {t(style.label)}
        </p>
      )}
    </div>
  );
}

// ── Main Panel ──

export function AiChatPanel() {
  const activeTask = useStudioStore(s => s.activeTask);
  const taskStepLimit = useStudioStore(s => s.taskStepLimit);
  const resumeTask = useStudioStore(s => s.resumeTask);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const { t } = useTranslation(["editor", "common"]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const profile = useUserProfileStore(s => s.profile);
  const outputLanguage = normalizeStudioOutputLanguage(profile?.preferences.studioOutputLanguage);
  const [savingLanguage, setSavingLanguage] = useState<StudioOutputLanguage | null>(null);
  const changeOutputLanguage = async (language: StudioOutputLanguage) => {
    if (savingLanguage || language === outputLanguage) return;
    setSavingLanguage(language);
    try {
      const res = await fetch(`${apiBase}/api/users/me`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences: { studioOutputLanguage: language } }),
      });
      if (!res.ok) throw new Error("Language could not be saved");
      const { data } = await res.json();
      useUserProfileStore.getState().acceptProfile(data);
    } catch {
      feedback.error(t("studio.aiChat.languageSaveFailed", { defaultValue: "Could not save the output language. Please try again." }));
    } finally {
      setSavingLanguage(null);
    }
  };
  const savedNsfwProfileId = useUserProfileStore(s => s.profile?.preferences.nsfwApiKeyId);
  const nsfwProfileId = typeof savedNsfwProfileId === "string" ? savedNsfwProfileId : null;
  const resolveStudioProfile = useCallback((selected: string | null, error: string | null) => {
    setModel(selected ?? ""); setEndpointError(error);
  }, []);
  const [inputHeight, setInputHeight] = useState(MIN_INPUT_HEIGHT);
  const [reasoningExpanded, setReasoningExpanded] = useState(false);
  // Inline two-step confirm for the AI-chat undo button. Undo deletes the
  // last message exchange AND rolls back every world.schema mutation the
  // agent applied this turn — irreversible from the client. A misclick cost
  // a user a full day of authoring work, so the first click flips the button
  // into "Confirm?" state; a second click within 4 s actually performs the
  // undo. The 4 s timer auto-cancels so the destructive state can't linger
  // and catch a habitual click later.
  const [confirmingUndo, setConfirmingUndo] = useState(false);
  useEffect(() => {
    if (!confirmingUndo) return;
    const timer = setTimeout(() => setConfirmingUndo(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmingUndo]);
  // Two-step confirm for deleting a conversation (loses its chat history). First
  // click on the trash flips that row into a "Delete?" button; a second click
  // within 3 s confirms. Auto-clears so the armed state can't linger.
  const [pendingDeleteConvId, setPendingDeleteConvId] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingDeleteConvId) return;
    const timer = setTimeout(() => setPendingDeleteConvId(null), 3000);
    return () => clearTimeout(timer);
  }, [pendingDeleteConvId]);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageImportEpoch = useRef(0);
  const imageImportAlive = useRef(true);
  const [imageImport, setImageImport] = useState<{ files?: File[]; worldId: string | null; conversationId: string | null; token: number } | null>(null);
  const inputResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const chatMessages = useStudioStore(s => s.chatMessages);
  const pendingVisualizationTask = useStudioStore(s => s.pendingVisualizationTask);
  const [conversationListReady, setConversationListReady] = useState(false);
  const isChatStreaming = useStudioStore(s => s.isChatStreaming);
  const chatStreamContent = useStudioStore(s => s.chatStreamContent);
  const sendChatMessage = useStudioStore(s => s.sendChatMessage);
  const clearChat = useStudioStore(s => s.clearChat);
  const isAgentWorking = useStudioStore(s => s.isAgentWorking);
  const isRecovering = useStudioStore(s => s.isRecovering);
  const creditPause = useStudioStore(s => s.creditPause);
  const isResumingCredits = useStudioStore(s => s.isResumingCredits);
  const isRefreshingCreditPause = useStudioStore(s => s.isRefreshingCreditPause);
  const creditPauseError = useStudioStore(s => s.creditPauseError);
  const resumeCreditPause = useStudioStore(s => s.resumeCreditPause);
  const refreshCreditPause = useStudioStore(s => s.refreshCreditPause);
  const restartFromPause = useStudioStore(s => s.restartFromPause);
  const agentIteration = useStudioStore(s => s.agentIteration);
  const agentMaxIterations = useStudioStore(s => s.agentMaxIterations);
  const reasoningChars = useStudioStore(s => s.reasoningChars);
  const reasoningContent = useStudioStore(s => s.reasoningContent);
  const appliedCount = useStudioStore(s => s.appliedCount);
  const toolGenChars = useStudioStore(s => s.toolGenChars);
  const toolGenName = useStudioStore(s => s.toolGenName);
  const steerChatMessage = useStudioStore(s => s.steerChatMessage);
  const isSendingSteering = useStudioStore(s => s.isSendingSteering);
  const stopAgent = useStudioStore(s => s.stopAgent);
  const approveProposal = useStudioStore(s => s.approveProposal);
  const rejectProposal = useStudioStore(s => s.rejectProposal);
  const _pendingApproval = useStudioStore(s => s._pendingApproval);
  const _pendingImage = useStudioStore(s => s._pendingImage);
  const _pendingImageBatch = useStudioStore(s => s._pendingImageBatch);
  const updateImageBatchProposal = useStudioStore(s => s.updateImageBatchProposal);
  const chatWorldId = useStudioStore(s => s.chatWorldId);
  const chatConversationId = useStudioStore(s => s.chatConversationId);
  const confirmImageProposal = useStudioStore(s => s.confirmImageProposal);
  const declineImageProposal = useStudioStore(s => s.declineImageProposal);
  const chatAttachments = useStudioStore(s => s.chatAttachments);
  const addChatAttachment = useStudioStore(s => s.addChatAttachment);
  const removeChatAttachment = useStudioStore(s => s.removeChatAttachment);
  const undoLastTurn = useStudioStore(s => s.undoLastTurn);
  const regenerateLastTurn = useStudioStore(s => s.regenerateLastTurn);
  const reconnectAgent = useStudioStore(s => s.reconnectAgent);
  const nudgeRecovery = useStudioStore(s => s.nudgeRecovery);
  const isReconnecting = useStudioStore(s => s.isReconnecting);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const fetchCredits = useCreditStore(s => s.fetchCredits);
  const creditBalance = useCreditStore(s => s.balance);
  const billingEnabled = useFeature("billing");
  const fetchProfile = useUserProfileStore(s => s.fetchProfile);

  useEffect(() => {
    void fetchProfile();
    if (billingEnabled) void fetchCredits();
  }, [fetchProfile, fetchCredits, billingEnabled]);

  // Elapsed time counter for agent working indicator
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // Runs can legitimately last half an hour. Past a minute a raw second count
  // stops reading as progress, so switch to m:ss.
  const elapsedLabel = elapsedSeconds < 60
    ? `${elapsedSeconds}s`
    : `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const agentStartRef = useRef<number>(0);
  useEffect(() => {
    if (!isAgentWorking) {
      setElapsedSeconds(0);
      return;
    }
    agentStartRef.current = Date.now();
    setElapsedSeconds(0);
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - agentStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isAgentWorking]);

  // ── Conversation Persistence ──
  const apiBase = import.meta.env.VITE_API_URL || "";
  const [conversations, setConversations] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [convDropdownOpen, setConvDropdownOpen] = useState(false);
  const convDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    imageImportEpoch.current++; setImageImport(null);
  }, [serverWorldId, activeConversationId]);
  useEffect(() => {
    imageImportAlive.current = true;
    return () => { imageImportAlive.current = false; };
  }, []);
  const conversationLoadRef = useRef(0);
  const conversationLoadingRef = useRef(false);
  const sendPendingRef = useRef<number | null>(null);
  const [isConversationLoading, setIsConversationLoading] = useState(false);

  useEffect(() => {
    if (!serverWorldId || isConversationLoading) return;
    return watchStudioImageNotifications({ worldId: serverWorldId, conversationId: activeConversationId });
  }, [serverWorldId, activeConversationId, isConversationLoading]);

  const visibleCreditPause = creditPause?.worldId === serverWorldId
    && creditPause.conversationId === activeConversationId ? creditPause : null;

  // A top-up may finish in another tab. Refresh only the saved status and
  // balance; restoring a paid task always requires an explicit Continue click.
  useEffect(() => {
    if (!visibleCreditPause || isAgentWorking) return;
    const { worldId, conversationId, runId } = visibleCreditPause;
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshCreditPause(worldId, conversationId, runId);
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = setInterval(refresh, 15_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [visibleCreditPause?.runId, isAgentWorking, creditBalance, refreshCreditPause]); // eslint-disable-line react-hooks/exhaustive-deps

  // A mobile pane change can remount this panel during a send. Adopt the
  // current scoped conversation instead of clearing or loading over that run.
  useEffect(() => {
    if (!serverWorldId) return;
    let cancelled = false;
    setConversationListReady(false);
    const requestedWorldId = serverWorldId;
    const currentChat = useStudioStore.getState();
    const didSwitchWorld = currentChat.chatWorldId !== requestedWorldId;

    // Clear only a different world's chat; same-world remounts share the store.
    if (didSwitchWorld) {
      ++conversationLoadRef.current;
      conversationLoadingRef.current = false;
      setIsConversationLoading(false);
      clearChat();
      useStudioStore.setState({ chatWorldId: requestedWorldId, chatConversationId: null });
      setActiveConversationId(null);
    } else {
      setActiveConversationId(currentChat.chatConversationId);
    }
    const listRequestId = conversationLoadRef.current;

    fetch(`${apiBase}/api/studio/${requestedWorldId}/conversations`, { credentials: "include" })
      .then((r) => r.json())
      .then(({ data }) => {
        if (cancelled || !isCurrentStudioWorld(requestedWorldId) || listRequestId !== conversationLoadRef.current) return;
        setConversations(data ?? []);
        const adopted = useStudioStore.getState();
        // A conversation may have been created while this list was in flight.
        // Loading it again would stop the send and replace its live transcript.
        if (adopted.chatWorldId === requestedWorldId && adopted.chatConversationId) {
          setActiveConversationId(adopted.chatConversationId);
        } else if (data?.length > 0) {
          loadConversation(data[0].id, requestedWorldId);
        } else if (!data?.length) {
          void refreshCreditPause(requestedWorldId, null);
        }
      })
      .catch((err) => { console.warn("[Studio] Failed to load conversations:", err); })
      .finally(() => { if (!cancelled) setConversationListReady(true); });
    return () => { cancelled = true; };
  }, [serverWorldId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save current conversation when messages change.
  //
  // Previously gated on `!isAgentWorking`, which made any turn started during
  // an agent run go unsaved if the user navigated before the agent finished —
  // observed as "sent a message, switched panels, came back, everything gone."
  // The user message is now persisted immediately on send (see studio store's
  // sendChatMessage), and there's no longer any reason to defer subsequent
  // saves: studio_conversations.messages and agent_runs.committedTurns live
  // in separate tables, so a PATCH during streaming can't clobber the agent's
  // committed output.
  useEffect(() => {
    if (!serverWorldId || !activeConversationId || chatMessages.length === 0) return;
    const timer = setTimeout(() => {
      fetch(`${apiBase}/api/studio/${serverWorldId}/conversations/${activeConversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          messages: serializeStudioChatMessages(chatMessages),
        }),
      }).catch((err) => { console.warn("[Studio] Failed to auto-save conversation:", err); });
    }, 2000);
    return () => clearTimeout(timer);
  }, [chatMessages, activeConversationId, serverWorldId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close conv dropdown on outside click
  useEffect(() => {
    if (!convDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (convDropdownRef.current && !convDropdownRef.current.contains(e.target as Node)) {
        setConvDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [convDropdownOpen]);

  async function loadConversation(convId: string, worldId = serverWorldId) {
    if (!worldId) return;
    const requestedWorldId = worldId;
    const loadId = ++conversationLoadRef.current;
    const stillCurrent = () => isCurrentStudioWorld(requestedWorldId) && conversationLoadRef.current === loadId;
    conversationLoadingRef.current = true;
    setIsConversationLoading(true);
    // Detach the old view; its server task keeps running in that conversation.
    const store = useStudioStore.getState();
    if (store.isAgentWorking || store.isResumingCredits || store._pendingApproval || store._pendingImage) {
      store.detachAgent();
    }
    try {
      const res = await fetch(`${apiBase}/api/studio/${requestedWorldId}/conversations/${convId}`, { credentials: "include" });
      // If the user navigated away from this world while the request was in
      // flight, bail silently — no toast, no state mutation.
      if (!stillCurrent()) return;
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.error("[Studio] loadConversation HTTP error:", res.status, errBody);
        feedback.error(t("studio.aiChat.loadConvFailed"), {
          label: t("common:action.retry"),
          onClick: () => void loadConversation(convId, requestedWorldId),
        });
        return;
      }
      const { data } = await res.json();
      if (!stillCurrent()) return;
      if (!data || !Array.isArray(data.messages)) {
        // Old behavior here was a silent no-op via `if (data?.messages)` — meant
        // the user got zero feedback when the response shape was unexpected.
        console.error("[Studio] loadConversation: unexpected response shape", data);
        feedback.error(t("studio.aiChat.loadConvFailed"), {
          label: t("common:action.retry"),
          onClick: () => void loadConversation(convId, requestedWorldId),
        });
        return;
      }
      // Detach a stream that attached while this request was pending.
      const currentStore = useStudioStore.getState();
      if (currentStore.isAgentWorking || currentStore.isResumingCredits || currentStore._pendingApproval || currentStore._pendingImage) currentStore.detachAgent();
      useStudioStore.setState({
        chatMessages: data.messages,
        chatWorldId: requestedWorldId,
        chatConversationId: convId,
        chatStreamContent: "",
        isChatStreaming: false,
        isAgentWorking: false,
        _pendingApproval: null,
        _pendingImage: null,
        _pendingImageBatch: null,
        _currentRunId: null,
        creditPause: null,
        creditPauseError: null,
        isResumingCredits: false,
        isRefreshingCreditPause: false,
      });
      setActiveConversationId(convId);
      void refreshCreditPause(requestedWorldId, convId);
    } catch (err) {
      // Network errors (offline, fetch threw) or JSON parse failures land here.
      // Don't toast if the user already navigated away.
      if (!stillCurrent()) return;
      console.error("[Studio] loadConversation threw:", err);
      feedback.error(t("studio.aiChat.loadConvFailed"), {
        label: t("common:action.retry"),
        onClick: () => void loadConversation(convId, requestedWorldId),
      });
    } finally {
      if (stillCurrent()) {
        conversationLoadingRef.current = false;
        setIsConversationLoading(false);
      }
    }
  }

  async function createNewConversation() {
    if (!serverWorldId) return;
    const loadId = ++conversationLoadRef.current;
    conversationLoadingRef.current = false;
    setIsConversationLoading(false);
    const requestedWorldId = serverWorldId;
    setActiveConversationId(null);
    clearChat();
    try {
      const res = await fetch(`${apiBase}/api/studio/${requestedWorldId}/conversations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title: t("studio.aiChat.newConversation") }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data } = await res.json();
      if (!isCurrentStudioWorld(requestedWorldId) || conversationLoadRef.current !== loadId) return;
      if (data?.id) {
        setActiveConversationId(data.id);
        useStudioStore.setState({
          chatWorldId: requestedWorldId,
          chatConversationId: data.id,
        });
        setConversations((prev) => [{ id: data.id, title: data.title ?? t("studio.aiChat.newConversation"), updatedAt: new Date().toISOString() }, ...prev]);
      }
    } catch {
      if (isCurrentStudioWorld(requestedWorldId) && conversationLoadRef.current === loadId) {
        feedback.error(t("studio.aiChat.createConvFailed"), {
          label: t("common:action.retry"),
          onClick: () => void createNewConversation(),
        });
      }
    }
    if (isCurrentStudioWorld(requestedWorldId) && conversationLoadRef.current === loadId) setConvDropdownOpen(false);
  }

  async function deleteConversation(convId: string) {
    if (!serverWorldId) return;
    const requestedWorldId = serverWorldId;
    try {
      const res = await fetch(`${apiBase}/api/studio/${requestedWorldId}/conversations/${convId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!isCurrentStudioWorld(requestedWorldId)) return;
      setConversations((prev) => prev.filter((c) => c.id !== convId));
      if (useStudioStore.getState().chatConversationId === convId) {
        ++conversationLoadRef.current;
        conversationLoadingRef.current = false;
        setIsConversationLoading(false);
        clearChat();
        setActiveConversationId(null);
      }
    } catch {
      if (isCurrentStudioWorld(requestedWorldId)) {
        feedback.error(t("studio.aiChat.deleteConvFailed"), {
          label: t("common:action.retry"),
          onClick: () => void deleteConversation(convId),
        });
      }
    }
  }

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [chatMessages, isChatStreaming, chatStreamContent, visibleCreditPause?.runId]);

  const handleClearChat = useCallback(() => {
    ++conversationLoadRef.current;
    conversationLoadingRef.current = false;
    setIsConversationLoading(false);
    clearChat();
    setActiveConversationId(null);
  }, [clearChat]);

  const handleInspectChange = useCallback((toolCall: ToolCall, agentRunId?: string) => {
    window.dispatchEvent(new CustomEvent("yumina:studio-mobile-review", {
      detail: { toolCall, agentRunId },
    }));
  }, []);

  const tracePresentationsByMessage = useMemo(() => {
    type ActivityGroup = {
      runId: string;
      model: string;
      items: Map<string, StudioTraceItem>;
      cards: Map<string, ReactNode>;
      messageId: string;
      explicit: boolean;
      hasRunId: boolean;
      startedAt?: number;
      completedAt?: number;
    };
    const groups = new Map<string, ActivityGroup>();
    const ensureGroup = (runId: string, messageId: string, hasRunId: boolean) => {
      const existing = groups.get(runId);
      if (existing) {
        existing.hasRunId ||= hasRunId;
        return existing;
      }
      const group: ActivityGroup = { runId, model: "Agent", items: new Map(), cards: new Map(), messageId, explicit: false, hasRunId };
      groups.set(runId, group);
      return group;
    };

    // Activity rows may be stored separately from the assistant message that
    // owns the associated card, so collect the trace groups first by run ID.
    for (const message of chatMessages) {
      const trace = message.activityTrace;
      if (!trace) continue;
      const group = ensureGroup(trace.runId, message.id, true);
      if (!group.explicit) {
        group.messageId = message.id;
        group.explicit = true;
        group.model = trace.model;
      }
      if (typeof trace.startedAt === "number") group.startedAt = trace.startedAt;
      if (typeof trace.completedAt === "number") group.completedAt = trace.completedAt;
      for (const item of trace.items) group.items.set(item.id, item);
    }

    for (const message of chatMessages) {
      const toolCalls = message.toolCalls ?? message.mobileReviewToolCalls ?? [];
      const hasArtifacts = toolCalls.length > 0 || !!message.imageProposal || !!message.imageBatchProposal;
      if (!hasArtifacts) continue;
      const realRunId = message.activityTrace?.runId ?? message.agentRunId
        ?? message.imageProposal?.runId ?? message.imageBatchProposal?.runId;
      const runId = realRunId ?? `legacy:${message.id}`;
      const group = ensureGroup(runId, message.id, !!realRunId);

      for (const toolCall of toolCalls) {
        const results = message.toolResults?.filter(result => result.tool_call_id === toolCall.id) ?? [];
        const errors = results.filter(result => result.status === "error").length;
        const traceResult = errors > 0 && results.length > 1
          ? { status: "error", result: { status: "partial_failure", completed: results.length - errors, failed: errors } }
          : results[0];
        const described = describeStudioTrace(toolCall, traceResult);
        const existing = group.items.get(toolCall.id);
        if (!existing) group.items.set(toolCall.id, described);
        else if ((existing.status === "working" || existing.status === "unconfirmed") && described.status !== "working") group.items.set(toolCall.id, described);
        else if (existing.generatedNames === undefined && described.generatedNames !== undefined) {
          group.items.set(toolCall.id, { ...existing, detail: described.detail || existing.detail, generatedNames: described.generatedNames });
        }

        if (!isReadTool(toolCall.function.name)) group.cards.set(toolCall.id, <ProposalCard
          key={`${message.id}:${toolCall.id}`}
          toolCalls={[toolCall]}
          toolResults={results.length ? results : undefined}
          status={message.proposalStatus ?? "approved"}
          onApprove={message.proposalStatus === "pending" ? approveProposal : undefined}
          onReject={message.proposalStatus === "pending" ? rejectProposal : undefined}
          onInspectChange={call => handleInspectChange(call, message.agentRunId)}
        />);
      }

      if (message.imageProposal) {
        const proposal = message.imageProposal;
        const status = proposal.status === "failed" ? "failed" : proposal.status === "stillGenerating" ? "unconfirmed"
          : proposal.status === "pending" || proposal.status === "generating" ? "working" : "done";
        const title = proposal.status === "failed" ? "Image generation failed" : proposal.status === "done" ? "Image generation complete"
          : proposal.status === "declined" ? "Image generation declined" : proposal.status === "cancelled" ? "Image generation cancelled"
            : proposal.status === "stillGenerating" ? "Image still generating" : "Generate image";
        if (!group.items.has(proposal.toolCallId)) group.items.set(proposal.toolCallId, {
          id: proposal.toolCallId, kind: "image", title, detail: proposal.purpose ?? "Image generation", status,
        });
        group.cards.set(proposal.toolCallId, <ImageProposalCard
          key={`${message.id}:${proposal.toolCallId}`}
          proposal={proposal}
          interactive={!!_pendingImage && _pendingImage.toolCallId === proposal.toolCallId}
          onConfirm={confirmImageProposal}
          onDecline={declineImageProposal}
        />);
      }

      if (message.imageBatchProposal && serverWorldId && chatWorldId === serverWorldId) {
        const proposal = message.imageBatchProposal;
        const status = proposal.status === "pending" ? "working" : "done";
        const title = proposal.status === "pending" ? "Image batch proposed"
          : proposal.status === "declined" ? "Image batch declined" : "Image batch submitted";
        if (!group.items.has(proposal.toolCallId)) group.items.set(proposal.toolCallId, {
          id: proposal.toolCallId, kind: "image", title, detail: `${proposal.items.length} image prompts`, status,
        });
        group.cards.set(proposal.toolCallId, <ImageBatchProposalCard
          key={`${serverWorldId}:${chatConversationId}:${proposal.runId}:${proposal.toolCallId}`}
          proposal={proposal}
          worldId={serverWorldId}
          conversationId={chatConversationId}
          interactive={_pendingImageBatch?.runId === proposal.runId && _pendingImageBatch?.toolCallId === proposal.toolCallId}
          onUpdate={updated => updateImageBatchProposal(serverWorldId, chatConversationId, updated)}
        />);
      }
    }

    const byMessage = new Map<string, { trace: NonNullable<StudioChatMessage["activityTrace"]>; cards: Map<string, ReactNode>; hasRunId: boolean }>();
    for (const group of groups.values()) {
      const items = [...group.items.values()].slice(-200);
      if (!items.length) continue;
      byMessage.set(group.messageId, { trace: { runId: group.runId, model: group.model, items,
        ...(group.startedAt !== undefined ? { startedAt: group.startedAt } : {}),
        ...(group.completedAt !== undefined ? { completedAt: group.completedAt } : {}) }, cards: group.cards, hasRunId: group.hasRunId });
    }
    return byMessage;
  }, [chatMessages, approveProposal, rejectProposal, handleInspectChange, _pendingImage, _pendingImageBatch,
    confirmImageProposal, declineImageProposal, serverWorldId, chatWorldId, chatConversationId, updateImageBatchProposal]);

  const imageTaskSummaries = useMemo(() => {
    const raw = new Map<string, { total: number; queued: number; running: number; failed: number; completed: number;
      assigned: number; verified: number; unassigned: number; server?: StudioImageProposal["taskSummary"]; preflight?: StudioImageProposal["taskPreflight"] }>();
    for (const message of chatMessages) {
      const proposal = message.imageProposal;
      if (!proposal) continue;
      const group = raw.get(proposal.runId) ?? { total: 0, queued: 0, running: 0, failed: 0, completed: 0, assigned: 0, verified: 0, unassigned: 0 };
      group.total++;
      if (proposal.status === "failed" || proposal.status === "cancelled") group.failed++;
      if (proposal.status === "done") group.completed++;
      if (proposal.status === "generating" && proposal.jobStatus === "queued") group.queued++;
      else if (proposal.status === "generating") group.running++;
      if (proposal.assetStatus === "assigned" || proposal.assetStatus === "verified") group.assigned++;
      if (proposal.assetStatus === "verified") group.verified++;
      if (proposal.assetStatus === "unassigned") group.unassigned++;
      if (proposal.taskSummary) group.server = proposal.taskSummary;
      if (proposal.taskPreflight) group.preflight = proposal.taskPreflight;
      raw.set(proposal.runId, group);
    }
    return new Map([...raw].map(([runId, group]) => {
      const server = group.server;
      const summary = server ? {
        total: Math.max(group.total, server.total), queued: server.queued, running: server.running, failed: server.failed,
        completed: server.completed, assigned: server.assigned, verified: server.verified,
        unassigned: server.unassigned ?? group.unassigned, phase: server.phase, preflight: group.preflight,
      } : { ...group, phase: group.running ? "execute" : group.queued ? "prepare" : group.completed < group.total ? "integrate" : "complete" };
      return [runId, summary] as const;
    }));
  }, [chatMessages]);

  const questionReplies = useMemo(() => getStudioQuestionReplies(chatMessages), [chatMessages]);
  const questionReplyIds = useMemo(() => new Set([...questionReplies.values()].map(reply => reply.id)), [questionReplies]);
  const visibleChatMessages = chatMessages.filter(message =>
    (!questionReplyIds.has(message.id) || !!message.attachments?.length) && (message.role === "user"
    || !!message.disconnected
    || !!message.content.trim()
    || tracePresentationsByMessage.has(message.id)));

  const handleSend = useCallback(async (requestedInput?: string) => {
    const trimmed = (requestedInput ?? input).trim() || (useStudioStore.getState().chatAttachments.length ? "Use this image as my reference." : "");
    if (!trimmed || !serverWorldId || savingLanguage || conversationLoadingRef.current
      || sendPendingRef.current === conversationLoadRef.current) return;
    if (isAgentWorking) {
      const delivered = await steerChatMessage(serverWorldId, trimmed, activeConversationId);
      if (delivered && isCurrentStudioWorld(serverWorldId)) setInput(value => value.trim() === trimmed ? "" : value);
      return;
    }
    const requestedWorldId = serverWorldId;
    const sendId = ++conversationLoadRef.current;
    sendPendingRef.current = sendId;
    const stillCurrent = () => isCurrentStudioWorld(requestedWorldId) && conversationLoadRef.current === sendId;
    setInput("");

    try {
      let conversationIdForSend = activeConversationId;

      // Auto-create conversation if none active. If this fails we must NOT send —
      // the turn would run against a null conversation and never get persisted.
      if (!activeConversationId) {
        try {
          const res = await fetch(`${apiBase}/api/studio/${requestedWorldId}/conversations`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ title: trimmed.slice(0, 50) }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const { data } = await res.json();
          if (!stillCurrent()) return;
          if (!data?.id) throw new Error("missing conversation id");
          conversationIdForSend = data.id;
          setActiveConversationId(data.id);
          // Adopt the new conversation before the store checks the send's scope.
          useStudioStore.setState({
            chatWorldId: requestedWorldId,
            chatConversationId: data.id,
          });
          setConversations((prev) => [{ id: data.id, title: data.title ?? trimmed.slice(0, 50), updatedAt: new Date().toISOString() }, ...prev]);
        } catch {
          if (stillCurrent()) {
            feedback.error(t("studio.aiChat.createConvFailed"));
            setInput(trimmed); // restore the user's text so Send is the retry
          }
          return;
        }
      }

      if (!stillCurrent()) return;
      const sent = await sendChatMessage(requestedWorldId, trimmed, model, conversationIdForSend);
      if (sent === false && stillCurrent()) setInput(value => value || trimmed);
    } finally {
      if (sendPendingRef.current === sendId) sendPendingRef.current = null;
    }
  }, [input, isAgentWorking, serverWorldId, model, sendChatMessage, steerChatMessage, activeConversationId, apiBase, t, savingLanguage]);

  // Wait until the regular conversation list/adoption has settled. Starting from
  // a child editor while that request is in flight would stop/overwrite the run.
  useEffect(() => {
    if (!pendingVisualizationTask || pendingVisualizationTask.worldId !== serverWorldId || !conversationListReady
      || isConversationLoading || isAgentWorking || _pendingApproval || creditPause || sendPendingRef.current !== null) return;
    const task = useStudioStore.getState().pendingVisualizationTask;
    if (task !== pendingVisualizationTask) return;
    useStudioStore.setState({ pendingVisualizationTask: null, activePanel: "visualizations" });
    void handleSend(task.prompt);
  }, [pendingVisualizationTask, serverWorldId, conversationListReady, isConversationLoading, isAgentWorking, _pendingApproval, creditPause, handleSend]);

  // IME-safe Enter-to-send: won't fire while composing a pinyin/CJK candidate,
  // and honors the user's Enter vs Ctrl/⌘+Enter preference.
  const composer = useComposerSubmit({ onSubmit: handleSend });

  const stageImages = useCallback((files?: File[]) => {
    const available = Math.max(0, 5 - useStudioStore.getState().chatAttachments.length);
    if (!available) {
      feedback.error(t("studio.aiChat.attachmentLimit", { defaultValue: "You can attach up to five files. Remove an attachment to add another image." }));
      return;
    }
    if (files && files.length > available) feedback.error(t("studio.aiChat.attachmentLimit", { defaultValue: "You can attach up to five files. Remove an attachment to add another image." }));
    setImageImport({ files: files?.slice(0, available), worldId: serverWorldId, conversationId: activeConversationId, token: ++imageImportEpoch.current });
  }, [serverWorldId, activeConversationId, t]);
  const confirmImages = (files: File[], context: ImageImportContext) => {
    const target = imageImport, studio = useStudioStore.getState();
    if (!imageImportAlive.current || !target || context.signal.aborted || target.token !== imageImportEpoch.current
      || target.worldId !== useEditorStore.getState().serverWorldId || target.conversationId !== studio.chatConversationId) return;
    imageImportEpoch.current++;
    const available = Math.max(0, 5 - studio.chatAttachments.length);
    files.slice(0, available).forEach((file, index) => {
      const extension = PASTED_IMAGE_EXTENSIONS[file.type];
      if (!extension) return;
      const name = /\.(png|jpe?g|webp|gif)$/i.test(file.name) ? file.name : `pasted-image-${Date.now()}-${index + 1}.${extension}`;
      addChatAttachment(name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified }));
    });
  };
  const handleFileSelect = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []); event.target.value = "";
    const images: File[] = [];
    for (const file of files) {
      if (PASTED_IMAGE_EXTENSIONS[file.type]) images.push(file);
      else if (!useStudioStore.getState().isAgentWorking && useStudioStore.getState().chatAttachments.length < 5) addChatAttachment(file);
    }
    if (images.length) stageImages(images);
  }, [addChatAttachment, stageImages]);
  const handleImagePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = getImageFilesFromTransfer(event.clipboardData);
    if (!images.length) return;
    event.preventDefault();
    const supported = images.filter(file => PASTED_IMAGE_EXTENSIONS[file.type]);
    if (supported.length !== images.length) feedback.error(t("studio.aiChat.pasteImageType", { defaultValue: "Paste a PNG, JPEG, WebP or GIF image." }));
    if (supported.length) stageImages(supported);
  }, [stageImages, t]);

  const handleInputResizeMove = useCallback((event: PointerEvent) => {
    const session = inputResizeRef.current;
    if (!session) return;
    const nextHeight = Math.max(
      MIN_INPUT_HEIGHT,
      Math.min(MAX_INPUT_HEIGHT, session.startHeight + (session.startY - event.clientY))
    );
    setInputHeight(nextHeight);
  }, []);

  const stopInputResize = useCallback(() => {
    inputResizeRef.current = null;
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", handleInputResizeMove);
    window.removeEventListener("pointerup", stopInputResize);
  }, [handleInputResizeMove]);

  const startInputResize = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    inputResizeRef.current = {
      startY: event.clientY,
      startHeight: inputHeight,
    };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handleInputResizeMove);
    window.addEventListener("pointerup", stopInputResize);
  }, [handleInputResizeMove, inputHeight, stopInputResize]);

  useEffect(() => () => {
    stopInputResize();
  }, [stopInputResize]);

  const hasPendingApproval = !!_pendingApproval || !!_pendingImage;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Model selector */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <StudioProfilePicker refreshKey={nsfwProfileId} onResolved={resolveStudioProfile} disabled={isAgentWorking || isChatStreaming} />
        {/* Conversation switcher */}
        <div ref={convDropdownRef} className="relative">
          <button
            onClick={() => setConvDropdownOpen(!convDropdownOpen)}
            className="hover-surface flex items-center gap-1 rounded-md p-1 text-muted-foreground"
            title={t("studio.aiChat.conversations")}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {conversations.length > 0 && (
              <span className="text-[9px] font-medium">{conversations.length}</span>
            )}
          </button>
          {convDropdownOpen && (
            <div className="absolute right-0 top-[calc(100%+4px)] z-50 w-[220px] rounded-xl border border-border bg-popover p-1.5 shadow-xl">
              <button
                onClick={createNewConversation}
                className="hover-surface flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left"
              >
                <Plus className="h-3 w-3 text-primary" />
                <span className="text-xs text-muted-foreground">{t("studio.aiChat.newConversation")}</span>
              </button>
              {conversations.length > 0 && <div className="my-1 border-t border-border/50" />}
              <div className="max-h-[200px] overflow-y-auto">
                {conversations.map((conv) => (
                  <div
                    key={conv.id}
                    className={cn(
                      "group flex items-center gap-2 rounded-lg px-3 py-1.5 text-left hover:bg-muted/50 cursor-pointer",
                      activeConversationId === conv.id && "bg-primary/10"
                    )}
                  >
                    <button
                      onClick={() => { loadConversation(conv.id); setConvDropdownOpen(false); }}
                      className="flex-1 min-w-0"
                    >
                      <p className="text-xs text-foreground truncate">{conv.title}</p>
                      <p className="text-[9px] text-muted-foreground/50">
                        {new Date(conv.updatedAt).toLocaleDateString()}
                      </p>
                    </button>
                    {pendingDeleteConvId === conv.id ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); setPendingDeleteConvId(null); deleteConversation(conv.id); }}
                        className="shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                      >
                        {t("studio.aiChat.deleteConvConfirm")}
                      </button>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setPendingDeleteConvId(conv.id); }}
                        className="touch-reveal shrink-0 rounded p-0.5 text-muted-foreground/30 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                        title={t("studio.aiChat.deleteConv")}
                      >
                        <Trash className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {chatMessages.length > 0 && (
          <button
            onClick={handleClearChat}
            className="hover-surface rounded-md p-1 text-muted-foreground"
            title={t("studio.aiChat.clearChat")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-1">
        <label htmlFor="studio-output-language" className="shrink-0 text-xs text-muted-foreground">
          {t("studio.aiChat.outputLanguage", { defaultValue: "Output language" })}
        </label>
        <Select
          id="studio-output-language"
          aria-label="Agent output language"
          title={t("studio.aiChat.outputLanguageHint", { defaultValue: "Language for Little Idot's replies and summaries. Changes apply from the next reply." })}
          value={savingLanguage ?? outputLanguage}
          disabled={!!savingLanguage || !profile}
          onValueChange={value => void changeOutputLanguage(normalizeStudioOutputLanguage(value))}
          options={STUDIO_OUTPUT_LANGUAGES.map(language => ({ value: language.code, label: language.label }))}
          className="h-[44px] min-h-[44px] min-w-0 max-w-[240px] flex-1 rounded-md px-2 py-0 text-xs"
          contentClassName="min-w-0 max-h-[min(320px,var(--radix-dropdown-menu-content-available-height))] overscroll-contain [&_[role=menuitem]]:min-h-[44px]"
        />
        {savingLanguage && <Loader2 aria-label="Saving output language" className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {/* Context usage meter — token-based, mirrors server's getContextBudget logic.
          Replaces the old message-count heuristic which was off by 10x+ on conversations
          with large tool results (a single 50K-char TSX read dwarfs 40 small messages). */}
      <ContextUsageBar
        messages={chatMessages}
        model={model}
        onStartFresh={createNewConversation}
      />

      {/* Messages */}
      <div ref={messagesContainerRef} className="flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
        {visibleChatMessages.length === 0 && !isChatStreaming && !visibleCreditPause && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground/50 gap-2">
            <LittleIdotAvatar className="h-12 w-12" />
            <p className="text-xs text-center max-w-[200px]">
              {t("studio.aiChat.emptyDesc")}
            </p>
          </div>
        )}

        {visibleChatMessages.map((msg, msgIdx) => msg.disconnected ? (
          // Not model output, so it gets no chat bubble: a dropped stream is a
          // state the creator has to act on, and the action that matters
          // (re-attach to the run the server may have already finished) has to
          // outrank the one that silently bills them again.
          <DisconnectedCard
            key={msg.id}
            dead={msg.disconnected.dead === true}
            busy={isReconnecting}
            onReconnect={() => {
              if (serverWorldId) void reconnectAgent(serverWorldId, activeConversationId, msg.disconnected?.runId);
            }}
            onResend={() => { if (serverWorldId) void regenerateLastTurn(serverWorldId, model, activeConversationId); }}
          />
        ) : (
          <div key={msg.id}>
          <div
            className={cn(
              "flex gap-2.5",
              msg.role === "user" ? "justify-end" : "justify-start"
            )}
          >
            {msg.role === "assistant" && (
              <LittleIdotAvatar className="mt-0.5" />
            )}
            <div className="max-w-[85%] min-w-0">
              {msg.role === "user" ? (
                <div>
                  {!questionReplyIds.has(msg.id) && <div className="rounded-2xl rounded-br-md bg-muted px-3 py-2 text-xs text-foreground whitespace-pre-wrap break-words">
                    {msg.content}
                  </div>}
                  {msg.steering && <p className="mt-1 text-right text-[10px] text-muted-foreground" role="status">
                    {t(`studio.aiChat.steeringStatus.${msg.steering.status}`, { defaultValue: {
                      sending: "Sending instruction…", queued: "Queued for next step", applied: "Received by agent", failed: "Instruction not applied",
                    }[msg.steering.status] })}
                  </p>}
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1 justify-end">
                      {msg.attachments.map((att, i) => (
                        <button
                          key={i}
                          type="button"
                          aria-label={t("studio.aiChat.previewAttachment", { defaultValue: "Preview image {{name}}", name: att.name })}
                          onClick={() => setPreviewImage({ src: att.url, alt: att.name })}
                          className="rounded-lg cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <img src={att.url} alt={att.name} className="h-16 w-16 rounded-lg object-cover border border-border/50" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {/* Assistant text with markdown rendering */}
                  {msg.content && <MessageContent content={msg.content} />}
                  {(() => {
                    const runId = msg.activityTrace?.runId ?? msg.agentRunId ?? msg.imageProposal?.runId;
                    const summary = runId ? imageTaskSummaries.get(runId) : undefined;
                    const firstRunMessage = runId && chatMessages.find(message => message.role === "assistant"
                      && (message.activityTrace?.runId ?? message.agentRunId ?? message.imageProposal?.runId) === runId)?.id === msg.id;
                    return summary && summary.total > 1 && firstRunMessage ? <ImageTaskOutcome summary={summary} /> : null;
                  })()}
                  {tracePresentationsByMessage.get(msg.id) && <AgentTrace
                    trace={tracePresentationsByMessage.get(msg.id)!.trace}
                    worldId={tracePresentationsByMessage.get(msg.id)!.hasRunId ? serverWorldId : null}
                    cards={tracePresentationsByMessage.get(msg.id)!.cards}
                  />}
                  {msg.questionPrompt && <QuestionAnswerCard
                    prompt={msg.questionPrompt}
                    answer={questionReplies.get(msg.id)?.content}
                    busy={isAgentWorking || isChatStreaming || isConversationLoading}
                    onAnswer={answer => handleSend(answer)}
                  />}
                </>
              )}
            </div>
            {msg.role === "user" && (
              <div className="shrink-0 mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-muted">
                <User className="h-3 w-3 text-muted-foreground" />
              </div>
            )}
          </div>
          {/* Undo / Regenerate buttons on the last assistant message */}
          {msg.role === "assistant" && msgIdx === visibleChatMessages.length - 1 && !isAgentWorking && !_pendingApproval && !_pendingImage && !visibleCreditPause && (
            <div className="flex gap-1 ml-7 mt-1">
              {confirmingUndo ? (
                <>
                  <button
                    onClick={() => {
                      setConfirmingUndo(false);
                      if (serverWorldId) void undoLastTurn(serverWorldId, activeConversationId);
                    }}
                    className="flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive hover:bg-destructive/25 transition-colors"
                    autoFocus
                  >
                    <Check className="h-3 w-3" />
                    {t("studio.aiChat.undoConfirm")}
                  </button>
                  <button
                    onClick={() => setConfirmingUndo(false)}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    title={t("studio.aiChat.undoCancel")}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setConfirmingUndo(true)}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title={t("studio.aiChat.undo")}
                >
                  <Undo2 className="h-3 w-3" />
                  {t("studio.aiChat.undo")}
                </button>
              )}
              <button
                onClick={() => serverWorldId && regenerateLastTurn(serverWorldId, model, activeConversationId)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title={t("studio.aiChat.regenerate")}
              >
                <RefreshCw className="h-3 w-3" />
                {t("studio.aiChat.regenerate")}
              </button>
            </div>
          )}
          </div>
        ))}

        {/* Reasoning (collapsible thinking section) */}
        {isChatStreaming && reasoningContent && (
          <div className="mx-1">
            <button
              onClick={() => setReasoningExpanded((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
            >
              <ChevronDown className={cn("h-3 w-3 transition-transform", !reasoningExpanded && "-rotate-90")} />
              <span>{t("studio.aiChat.thinking")} ({reasoningChars.toLocaleString()} chars)</span>
            </button>
            {reasoningExpanded && (
              <div className="mt-1 max-h-40 overflow-y-auto rounded-md bg-muted/50 px-2.5 py-2 text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
                {reasoningContent}
              </div>
            )}
          </div>
        )}

        {/* Streaming text (token-by-token) */}
        {isChatStreaming && (
          <div className="flex gap-2.5 justify-start">
            <LittleIdotAvatar className="mt-0.5" />
            <div className="max-w-[85%] min-w-0">
              {chatStreamContent ? (
                <StreamingText content={chatStreamContent} />
              ) : reasoningContent ? null : (
                <div className="flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">{t("studio.aiChat.thinking")}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {visibleCreditPause && (
          <CreditPauseCard
            pause={visibleCreditPause}
            resuming={isResumingCredits}
            refreshing={isRefreshingCreditPause || isConversationLoading}
            error={creditPauseError}
            onTopUp={() => { const href = getPlansHref("packs"); if (href) window.open(href, "_blank", "noopener,noreferrer"); }}
            onResume={() => { if (!conversationLoadingRef.current) void resumeCreditPause(); }}
            onRefresh={() => { void refreshCreditPause(visibleCreditPause.worldId, visibleCreditPause.conversationId, visibleCreditPause.runId); }}
            onRestart={() => { if (serverWorldId && !conversationLoadingRef.current) void restartFromPause(serverWorldId, model, activeConversationId); }}
          />
        )}

        {activeTask && <TaskStatusCard task={activeTask.task} working={isAgentWorking} allowContinue={!creditPause} onContinue={resumeTask} />}
        <div ref={messagesEndRef} />
      </div>

      <details className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">Task limits{taskStepLimit ? ` · ${taskStepLimit} steps` : " · continue while progressing"}</summary>
        <label className="mt-2 flex items-center gap-2">Optional step limit
          <input aria-label="Optional step limit" type="number" min={1} max={100000} value={taskStepLimit ?? ""} disabled={isAgentWorking}
            onChange={event => { const value = event.target.value === "" ? null : Number(event.target.value); useStudioStore.setState({ taskStepLimit: value !== null && Number.isInteger(value) && value >= 1 && value <= 100000 ? value : null }); }}
            placeholder="No step limit" className="min-h-9 w-28 rounded-md border border-border bg-background px-2 text-foreground" />
        </label>
        <p className="mt-1">Leave blank to keep working while making progress. A set limit pauses the task and saves its checklist.</p>
      </details>
      {/* Agent status bar */}
      {isAgentWorking && !hasPendingApproval && (
        isRecovering ? (
          // SSE dropped, but the agent keeps iterating server-side and the recovery
          // poller reads its real progress every 5s. Show that progress. An
          // information-free spinner reads as "hung": creators were hitting Stop on
          // healthy runs sitting at step 7/50, and the run they killed was editing
          // their card at the time. Step counter + clock + a plain sentence about
          // what is actually happening is the whole fix.
          // (Colors match the rest of this panel — the app ships dark-only, and
          // amber-700 on this surface measures ~3.5:1, under the 4.5:1 AA floor
          // for 11px text. amber-300 is ~13:1.)
          <div className="border-t border-amber-500/20 bg-amber-500/5 px-3 py-1.5">
            <div className="flex items-center gap-2">
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-amber-400" />
              <span className="text-[11px] text-amber-300 font-medium">
                {agentIteration > 0
                  ? t("studio.aiChat.thinkingStep", { step: agentIteration, max: agentMaxIterations })
                  : t("studio.aiChat.recovering")}
              </span>
              <span className="text-[10px] text-amber-300/60 tabular-nums">{elapsedLabel}</span>
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {/* Ask now instead of waiting out the 5s poll, and clear the
                    give-up budget. Read-only, so pressing it costs nothing. */}
                <button
                  onClick={nudgeRecovery}
                  disabled={isReconnecting}
                  className="flex items-center gap-1 rounded-md bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary transition-colors hover:bg-primary/25 disabled:opacity-60"
                >
                  {isReconnecting
                    ? <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    : <PlugZap className="h-2.5 w-2.5" />}
                  {t("studio.aiChat.reconnect")}
                </button>
                <button
                  onClick={stopAgent}
                  className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Square className="h-2.5 w-2.5" />
                  {t("studio.aiChat.stop")}
                </button>
              </div>
            </div>
            <p className="mt-0.5 pl-5 text-[10px] leading-snug text-amber-200/70">
              {t("studio.aiChat.checkingSavedTask", { defaultValue: "Checking the saved task and recovering completed work. Reconnect checks again now." })}
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2 border-t border-primary/20 bg-primary/5 px-3 py-1.5">
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
            <span className="text-[11px] text-primary font-medium">
              {agentIteration > 0
                ? t("studio.aiChat.thinkingStep", { step: agentIteration, max: agentMaxIterations })
                : t("studio.aiChat.thinking")}
            </span>
            <span className="text-[10px] text-primary/50 tabular-nums">
              {elapsedSeconds}s
              {reasoningChars > 0 && ` · ${reasoningChars.toLocaleString()} reasoning chars`}
              {chatStreamContent.length > 0 && ` · ${chatStreamContent.length.toLocaleString()} output chars`}
              {appliedCount > 0 && ` · applied ${appliedCount}`}
              {toolGenName && ` · generating ${toolGenName === "apply_changes" ? "changes" : toolGenName}${toolGenChars > 0 ? ` (${(toolGenChars / 1024).toFixed(1)}KB)` : "..."}`}
            </span>
            <button
              onClick={stopAgent}
              className="ml-auto flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <Square className="h-2.5 w-2.5" />
              {t("studio.aiChat.stop")}
            </button>
          </div>
        )
      )}

      {/* Pending approval bar */}
      {hasPendingApproval && (
        <div className="flex items-center gap-2 border-t border-amber-500/20 bg-amber-500/5 px-3 py-1.5">
          <span className="text-[11px] text-amber-400 font-medium">
            {t("studio.aiChat.waitingApproval")}
          </span>
          <button
            onClick={stopAgent}
            className="ml-auto flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            <Square className="h-2.5 w-2.5" />
            {t("studio.aiChat.cancel")}
          </button>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-border p-2">
        {/* Attachment thumbnails */}
        {chatAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2 px-1">
            {chatAttachments.map((file, i) => (
              <div key={i} className="relative group">
                {file.type.startsWith("image/") ? (
                  <PendingImageAttachment
                    file={file}
                    label={t("studio.aiChat.previewAttachment", { defaultValue: "Preview image {{name}}", name: file.name })}
                    onPreview={setPreviewImage}
                  />
                ) : (
                  <div className="h-12 px-2 rounded-lg border border-border/50 bg-muted flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <FileCode className="h-3.5 w-3.5 shrink-0" />
                    <span className="max-w-[80px] truncate">{file.name}</span>
                  </div>
                )}
                <button
                  onClick={() => removeChatAttachment(i)}
                  aria-label={t("studio.aiChat.removeAttachment", { defaultValue: "Remove attachment {{name}}", name: file.name })}
                  className="touch-reveal absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <div className="relative flex-1">
            <button
              type="button"
              onPointerDown={startInputResize}
              className="absolute right-2 top-2 z-10 flex h-5 w-5 cursor-ns-resize items-center justify-center rounded-md text-muted-foreground/45 transition-colors hover:text-foreground"
              style={{ touchAction: "none" }}
              aria-label={t("studio.aiChat.resizeInput")}
              title={t("studio.aiChat.resizeInput")}
            >
              <GripHorizontal className="h-3 w-3" />
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handleImagePaste}
              onKeyDown={composer.onKeyDown}
              onCompositionStart={composer.onCompositionStart}
              onCompositionEnd={composer.onCompositionEnd}
              placeholder={
                hasPendingApproval
                  ? t("studio.aiChat.placeholderReview")
                  : isAgentWorking
                    ? t("studio.aiChat.placeholderWorking", { defaultValue: "Add instructions to this run…" })
                    : t("studio.aiChat.placeholderDefault")
              }
              rows={1}
              className="w-full resize-none overflow-y-auto rounded-lg bg-muted px-3 py-2 pr-10 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/50 disabled:opacity-50"
              style={{ minHeight: `${MIN_INPUT_HEIGHT}px`, height: `${inputHeight}px`, maxHeight: `${MAX_INPUT_HEIGHT}px` }}
            />
          </div>
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".tsx,.jsx,.ts,.js,.json,.md,.txt,.html,.css"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          {imageImport && <ImageImportDialog multiple maxFiles={Math.max(1, 5 - chatAttachments.length)} maxBytes={Infinity} crop="none" preserveOriginal
            initialFiles={imageImport.files} title={t("studio.aiChat.attachImages", { defaultValue: "Attach images" })}
            description={t("studio.aiChat.attachImagesHint", { defaultValue: "Choose, drop or paste images to attach. Up to five files total; attaching does not send a message." })}
            onImport={confirmImages} onClose={() => { imageImportEpoch.current++; setImageImport(null); }} />}
          {/* Images share acquisition; source/code files retain their own chooser. */}
          {isAgentWorking ? <button type="button" onClick={() => stageImages()} disabled={chatAttachments.length >= 5}
            aria-label={t("studio.aiChat.attachImages", { defaultValue: "Attach images" })}
            className="rounded-lg p-2 text-muted-foreground hover:text-foreground disabled:opacity-30"><Paperclip className="h-3.5 w-3.5" /></button> :
            <DropdownMenu><DropdownMenuTrigger asChild><button type="button" disabled={chatAttachments.length >= 5}
              className="rounded-lg p-2 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-30"
              aria-label={t("studio.aiChat.attachFile")} title={t("studio.aiChat.attachFile")}><Paperclip className="h-3.5 w-3.5" /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="start"><DropdownMenuItem onSelect={() => stageImages()}>{t("studio.aiChat.attachImages", { defaultValue: "Attach images" })}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>{t("studio.aiChat.attachDocuments", { defaultValue: "Attach code or documents" })}</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>}
          {isAgentWorking ? (
            <button
              onClick={stopAgent}
              aria-label={t("studio.aiChat.stop")}
              title={t("studio.aiChat.stop")}
              className="rounded-lg bg-destructive p-2 text-destructive-foreground transition-opacity"
            >
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : null}
            <button
              onClick={() => void handleSend()}
              aria-label={isAgentWorking ? t("studio.aiChat.sendSteering", { defaultValue: "Send steering" }) : t("studio.aiChat.send", { defaultValue: "Send" })}
              title={isAgentWorking ? t("studio.aiChat.sendSteering", { defaultValue: "Send steering" }) : t("studio.aiChat.send", { defaultValue: "Send" })}
              disabled={!!savingLanguage || (!input.trim() && chatAttachments.length === 0) || (!isAgentWorking && isChatStreaming) || isSendingSteering || isConversationLoading}
              className="rounded-lg bg-primary p-2 text-primary-foreground transition-opacity disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
        </div>
        {endpointError && <p role="alert" className="mt-1.5 text-[11px] text-amber-300">{endpointError}</p>}
        <p className="mt-1.5 text-[10px] text-muted-foreground/60">{t("studio.aiChat.summarizeHint", { defaultValue: "Type /summarize to compact history toward 10k tokens." })}</p>
      </div>

      <ImageLightbox image={previewImage} onClose={() => setPreviewImage(null)} />
    </div>
  );
}
