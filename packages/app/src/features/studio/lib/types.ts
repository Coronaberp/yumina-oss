import type { ImageBatchProposal, ImageBatchSnapshot, StudioTraceItem } from "@yumina/shared";

/** A tool call returned by the LLM */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

/** Result of executing a tool on the client */
export interface ToolResult {
  tool_call_id: string;
  name: string;
  status: "success" | "error";
  result: unknown;
  error?: string;
}

export type ProposalStatus = "pending" | "approved" | "rejected";

/** A saved server task awaiting an explicit resume action. */
export interface StudioCreditPause {
  runId: string;
  worldId: string;
  conversationId: string | null;
  phase: "preflight" | "generated";
  requiredCredits: number;
  iteration: number;
  hasSavedResult: boolean;
  billingUnavailable: boolean;
  cost?: number;
  settled?: boolean;
  balance?: number;
  availableCredits?: number;
  reservedCredits?: number;
  reason?: string;
  resumable?: boolean;
}

export type StudioImageProposalStatus = "pending" | "generating" | "done" | "failed" | "declined" | "stillGenerating" | "cancelled";
export interface StudioQuestionPrompt {
  question: string;
  rationale?: string;
  options: Array<{ label: string; description?: string }>;
}
export interface StudioImageTarget {
  kind: "background" | "sprite" | "portrait" | "cg" | "library";
  sceneId?: string;
  period?: string;
  openingId?: string;
  characterId?: string;
  expression?: string;
}

/** Configured pictures start automatically; each card can be cancelled. */
export interface StudioImageProposal {
  runId: string;
  toolCallId: string;
  /** Present for generation through the creator's configured provider. */
  /** `openai` is retained only for rendering persisted pre-migration chat cards. */
  source?: "codex" | "comfyui" | "forgeneo" | "openai";
  imageWorkflow?: "anima" | "krea" | "codex";
  contentRating?: "sfw" | "nsfw";
  transparent?: boolean;
  workflowOptions?: { anima: boolean; krea: boolean; codex: boolean };
  workflowEditable?: boolean;
  imageKind?: "sprite" | "background" | "image";
  animaEnabled?: boolean;
  animaModel?: string;
  animaModels?: Array<{ name: string; nsfwCapable: boolean }>;
  animaModelEditable?: boolean;
  seedMode?: "random" | "fixed";
  seed?: number;
  cfg?: number;
  steps?: number;
  generationOptionsEditable?: boolean;
  progressPhase?: string;
  progressPercent?: number;
  referenceImages?: Array<{ key: string; url: string; name: string; assetRef?: string; role?: "identity" | "environment" | "style" | "creator"; origin?: "upload" | "manual" | "automatic" }>;
  target?: StudioImageTarget;
  styleInstructions?: string;
  unassignedReason?: string;
  prompt: string;
  purpose?: string;
  aspectRatio: string;
  /** Output size tier the assistant asked for. Absent when the chosen model
   *  has no size knob (GPT Image is sized by `quality`). */
  resolution?: string;
  batchSize: number;
  model: string;
  /** Why the assistant picked that generator, in the creator's language. Shown
   *  on the confirmation card in a fixed slot: the disclosure is part of the
   *  card rather than something the assistant has to remember to say. */
  modelReason?: string;
  /** Estimated mushies for one image (server-side estimate, not the charge). */
  unitMushies: number;
  estimatedMushies: number;
  status: StudioImageProposalStatus;
  jobId?: string;
  jobStatus?: string;
  referenceEditable?: boolean;
  referencePrepareUntil?: number;
  assetStatus?: "queued" | "generated" | "assigned" | "verified" | "unassigned" | "failed" | "cancelled" | string;
  assetReason?: string;
  retryCount?: number;
  taskSummary?: { total: number; queued: number; running: number; failed: number; completed: number; assigned: number; verified: number; unassigned?: number; phase: string };
  taskPreflight?: { clean: boolean; analysisComplete: boolean; errors: Array<{ code: string; message: string }>; warnings: Array<{ code: string; message: string }> };
  elapsed?: number;
  assetIds?: string[];
  errorCode?: string;
  costMushies?: number;
  error?: string;
}

export interface StudioImageBatchProposal extends ImageBatchProposal {
  runId: string;
  toolCallId: string;
  unitMushies: number;
  estimatedMushies: number;
  status: "pending" | "declined" | "submitted";
  acceptanceMessage?: string;
  batch?: ImageBatchSnapshot;
}

export interface StudioImageBatchEdits {
  items: Array<{ id: string; prompt: string }>;
  model: string;
  aspectRatio: string;
  resolution?: string;
}

/** Attachment stored on a chat message */
export interface ChatAttachment {
  url: string;
  key: string;
  mimeType: string;
  name: string;
}

/** A chat message in the Studio AI panel */
export interface StudioChatMessage {
  /** Unique message identifier for stable React keys and state matching */
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Follow-up instruction delivered to the same running task. */
  steering?: { status: "sending" | "queued" | "applied" | "failed"; createdAt: string; beforeIteration?: number };
  /** File attachments (images) on this message */
  attachments?: ChatAttachment[];
  /** Tool calls made by the assistant in this turn */
  toolCalls?: ToolCall[];
  /** Auto-applied write tool calls retained for mobile change review */
  mobileReviewToolCalls?: ToolCall[];
  /** Results of executing those tool calls */
  toolResults?: ToolResult[];
  /** Approval state for write tool proposals */
  proposalStatus?: ProposalStatus;
  /** A generate_image card attached to this assistant turn */
  imageProposal?: StudioImageProposal;
  imageBatchProposal?: StudioImageBatchProposal;
  /** Compact tool activity; excluded from model input by its empty content. */
  activityTrace?: { runId: string; model: string; items: StudioTraceItem[]; startedAt?: number; completedAt?: number };
  /** Links assistant messages to the agent run that produced them (for undo/rollback) */
  agentRunId?: string;
  /** Server-assigned ID for a committed text turn (`assistant_turn_commit` event).
   *  Used to dedup live commits vs recovery hydration — one bubble per commitId. */
  commitId?: string;
  /** Structured clarification payload on ask_user turns. */
  questionPrompt?: StudioQuestionPrompt;
  /** Message was cut short because the user pressed Stop — show a subtle marker. */
  stopped?: boolean;
  /** This bubble is the "connection dropped" card rather than model output. It
   *  carries the run it belongs to so Reconnect can re-attach to THAT run
   *  instead of starting (and charging for) a second one. `dead` means we already
   *  looked and the server has nothing, so only Resend is left.
   *
   *  Deliberately absent from serializeStudioChatMessages: the card is a live
   *  offer, not history. Reloading re-runs the status check on its own, and a
   *  persisted card would sit above the answer that check just recovered. */
  disconnected?: { runId?: string; dead?: boolean };
}

/** Persist only JSON-safe chat fields used to restore Studio conversations. */
export function serializeStudioChatMessages(messages: StudioChatMessage[]): Array<Record<string, unknown>> {
  return messages.map(({
    id,
    role,
    content,
    attachments,
    toolCalls,
    mobileReviewToolCalls,
    toolResults,
    proposalStatus,
    imageProposal,
    imageBatchProposal,
    activityTrace,
    agentRunId,
    commitId,
    stopped,
    steering,
    questionPrompt,
  }) => ({
    id,
    role,
    content,
    ...(attachments && { attachments }),
    ...(toolCalls && { toolCalls }),
    ...(mobileReviewToolCalls && { mobileReviewToolCalls }),
    ...(toolResults && { toolResults }),
    ...(proposalStatus && { proposalStatus }),
    ...(imageProposal && { imageProposal }),
    ...(imageBatchProposal && { imageBatchProposal }),
    ...(activityTrace && { activityTrace }),
    ...(agentRunId && { agentRunId }),
    ...(commitId && { commitId }),
    ...(stopped && { stopped }),
    ...(steering && { steering }),
    ...(questionPrompt && { questionPrompt }),
  }));
}

/** Match each question to its first reply without changing the saved agent history. */
export function getStudioQuestionReplies(messages: readonly StudioChatMessage[]): Map<string, StudioChatMessage> {
  const replies = new Map<string, StudioChatMessage>();
  let pendingQuestionId: string | undefined;
  for (const message of messages) {
    if (message.role === "assistant" && message.questionPrompt) {
      pendingQuestionId = message.id;
    } else if (message.role === "user" && pendingQuestionId !== undefined) {
      if (!message.steering && message.content.trim()) replies.set(pendingQuestionId, message);
      pendingQuestionId = undefined;
    }
  }
  return replies;
}

export interface StudioChatContext {
  activePanel?: string;
  selectedElementId?: string | null;
  selectedElementType?: string | null;
}

/** Content part for multimodal messages */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** Messages sent to the LLM via the server */
export type LLMMessage =
  | { role: "user" | "system"; content: string | ContentPart[] }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** Names of read tools that auto-execute without approval */
export const READ_TOOL_NAMES = new Set([
  "read_entity",
  "compile_tsx",
  "validate_ui_blueprint",
  "list_templates",
  "browse_assets",
  "load_skill",
  // V2 tools
  "read_entities",
  "generate_names",
  "list_name_profiles",
]);

export function isReadTool(name: string): boolean {
  return READ_TOOL_NAMES.has(name);
}
