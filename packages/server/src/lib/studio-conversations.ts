import { readStudioSteering, STUDIO_STEERING_KEY } from "./studio-steering.js";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { agentRuns, studioConversations } from "../db/schema.js";
import type { ChatMessage, ContentPart, MessageContent, ToolCall } from "./llm/types.js";
import { readPersistedImageBatchProposal } from "./studio-tools/image-batch-proposal.js";

type StudioConversation = typeof studioConversations.$inferSelect;
type StudioConversationUpdate = Partial<
  Pick<StudioConversation, "title" | "messages" | "updatedAt">
>;
type AgentRun = typeof agentRuns.$inferSelect;
type StudioDisplayMessage = Record<string, unknown>;
type StudioConversationForDisplay = Omit<StudioConversation, "messages"> & {
  messages: StudioDisplayMessage[];
};

interface CommittedDisplayTurn {
  runId: string;
  iteration: number;
  textContent: string;
  createdAt: string;
  commitId: string;
  writeToolCalls?: ToolCall[];
  lane?: "answer" | "step" | "notice";
  questionPrompt?: { question: string; rationale?: string; options: Array<{ label: string; description?: string }> };
}

const STUDIO_USER_MESSAGE_CONTEXT_KEY = "studioUserMessage";

interface ConversationScope {
  userId: string;
  worldId: string;
  conversationId: string;
}

interface UpdateConversationScope extends ConversationScope {
  updates: StudioConversationUpdate;
}

function scopedConversationWhere({ userId, worldId, conversationId }: ConversationScope) {
  return and(
    eq(studioConversations.id, conversationId),
    eq(studioConversations.userId, userId),
    eq(studioConversations.worldId, worldId)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function imageAttachmentUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const urls: string[] = [];
  for (const attachment of value) {
    if (!isRecord(attachment)) continue;

    const url = attachment.url;
    const mimeType = attachment.mimeType;
    if (
      typeof url === "string" &&
      url.trim() !== "" &&
      typeof mimeType === "string" &&
      mimeType.startsWith("image/")
    ) {
      urls.push(url);
    }
  }

  return urls;
}

function isMeaningfulContent(content: MessageContent): boolean {
  if (typeof content === "string") return content.trim() !== "";
  return content.some((part) => part.type === "image_url" || part.text.trim() !== "");
}

function normalizeContentPart(value: unknown): ContentPart | null {
  if (!isRecord(value)) return null;

  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }

  if (value.type === "image_url" && isRecord(value.image_url)) {
    const url = value.image_url.url;
    if (typeof url === "string" && url.trim() !== "") {
      return { type: "image_url", image_url: { url } };
    }
  }

  return null;
}

function normalizeMessageContent(value: unknown): MessageContent | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;

  const parts = value
    .map((part) => normalizeContentPart(part))
    .filter((part): part is ContentPart => part !== null);

  return parts.length > 0 ? parts : null;
}

function normalizeStoredUserMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value) || value.role !== "user") return null;

  const content = normalizeMessageContent(value.content);
  if (content === null || !isMeaningfulContent(content)) return null;

  return { role: "user", content };
}

/** Server-injected guard / nudge text. These are NOT model turns — they are
 *  notices the server wrote (loop guards, validation prompts, "you read X twice").
 *  They must never enter cross-run model history; matched by their fixed prefixes
 *  as a back-compat net for old rows that predate the `lane` field. */
const SERVER_NOTICE = /^Stopped: |^\[System[:\]]/;

/** Prefix of the server-synthesized "what this run changed" summary that
 *  runCommittedAssistantMessages appends to write-run answers (or emits as a
 *  standalone assistant message for write-only runs). The display transcript
 *  never contains it — the client displays committed turns' raw text — so the
 *  display filter must treat it specially (see matchesDisplayMessage). */
const WRITE_SUMMARY_PREFIX = "〔本轮改动：";

type CommittedTurn = NonNullable<AgentRun["committedTurns"]>[number];

/** Lane of a committed turn. Prefers the explicit `lane` (structural fact stamped
 *  at commit time); falls back to the legacy heuristic for rows written before the
 *  field existed. `answer` is the only lane re-fed to the model. */
function committedLane(turn: CommittedTurn): "answer" | "step" | "notice" {
  if (turn.lane === "answer" || turn.lane === "step" || turn.lane === "notice") return turn.lane;
  // Legacy rows (no `lane`): reconstruct from what we have.
  if (SERVER_NOTICE.test(String(turn.textContent ?? ""))) return "notice";
  if (turn.toolNarration === true || (Array.isArray(turn.writeToolCalls) && turn.writeToolCalls.length > 0)) return "step";
  return "answer";
}

function toolCallTarget(call: ToolCall): string | undefined {
  try {
    const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    const direct = args.name ?? args.id ?? args.entryId ?? args.query;
    if (typeof direct === "string" && direct.trim() !== "") return direct;
    if (Array.isArray(args.ids) && args.ids.length > 0) return args.ids.filter((x) => typeof x === "string").join("、");
  } catch { /* unparseable args — no target */ }
  return undefined;
}

/** The set of entities a run wrote, aggregated across its turns. Drawn from
 *  `writeToolCalls` (present on write turns, old and new) and from `actions` write
 *  ops (new rows). This is a faithful, cheap record of what changed — the only
 *  thing about a tool turn worth carrying across runs. */
function runWriteTargets(turns: CommittedTurn[]): string[] {
  const targets = new Set<string>();
  for (const turn of turns) {
    for (const call of turn.writeToolCalls ?? []) {
      const t = toolCallTarget(call);
      if (t) targets.add(t);
    }
    for (const action of turn.actions ?? []) {
      if (/^(write_|edit_|delete_|update_)/.test(action.op) && action.target) targets.add(action.target);
    }
  }
  return [...targets];
}

/** Rebuild a run's contribution to cross-run MODEL history by positive selection:
 *  take the run's real answer(s) plus a compact "what changed" summary of its
 *  writes. Tool preambles, mid-task stalls, and server notices are simply never
 *  selected — we pick the real thing rather than filter out the junk. A run that
 *  produced no answer and no writes (a pure stall) correctly leaves no trace. */
function runCommittedAssistantMessages(run: Pick<AgentRun, "committedTurns">): ChatMessage[] {
  const turns = (Array.isArray(run.committedTurns) ? run.committedTurns : [])
    .filter((turn): turn is CommittedTurn => isRecord(turn) && typeof turn.textContent === "string");

  const answers = turns.filter((turn) => committedLane(turn) === "answer" && turn.textContent.trim() !== "");
  const out: ChatMessage[] = answers.map((turn) => ({ role: "assistant" as const, content: turn.textContent }));

  const writeTargets = runWriteTargets(turns);
  if (writeTargets.length > 0) {
    const summary = `${WRITE_SUMMARY_PREFIX}${writeTargets.join("、")}〕`;
    if (out.length > 0) {
      const last = out[out.length - 1]!;
      last.content = `${typeof last.content === "string" ? last.content : ""}\n${summary}`.trim();
    } else {
      // A run that only wrote (no wrap-up text) still tells the next run what changed.
      out.push({ role: "assistant" as const, content: summary });
    }
  }

  return out;
}

function isToolCall(value: unknown): value is ToolCall {
  if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.function.name === "string" &&
    typeof value.function.arguments === "string"
  );
}

function normalizeToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls = value.filter(isToolCall);
  return calls.length > 0 ? calls : undefined;
}

function normalizeCommittedDisplayTurn(runId: string, value: unknown): CommittedDisplayTurn | null {
  if (!isRecord(value) || typeof value.textContent !== "string"
    || (value.textContent.trim() === "" && value.lane !== "answer")) {
    return null;
  }

  const commitId = typeof value.commitId === "string" ? value.commitId : "";
  if (!commitId) return null;

  const lane = value.lane === "answer" || value.lane === "step" || value.lane === "notice" ? value.lane : undefined;
  const rawQuestion = isRecord(value.questionPrompt) ? value.questionPrompt : undefined;
  const question = typeof rawQuestion?.question === "string" ? rawQuestion.question.slice(0, 1200) : undefined;
  const options = Array.isArray(rawQuestion?.options) ? rawQuestion.options.flatMap(option => {
    if (!isRecord(option) || typeof option.label !== "string" || !option.label.trim()) return [];
    return [{ label: option.label.slice(0, 120), ...(typeof option.description === "string" ? { description: option.description.slice(0, 240) } : {}) }];
  }).slice(0, 4) : [];
  const questionPrompt = question ? { question,
    ...(typeof rawQuestion?.rationale === "string" ? { rationale: rawQuestion.rationale.slice(0, 400) } : {}), options } : undefined;

  return {
    runId,
    iteration: typeof value.iteration === "number" ? value.iteration : 0,
    textContent: value.textContent,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    commitId,
    writeToolCalls: normalizeToolCalls(value.writeToolCalls),
    ...(lane ? { lane } : {}),
    ...(questionPrompt ? { questionPrompt } : {}),
  };
}

function messageHasReviewCalls(message: StudioDisplayMessage): boolean {
  return Array.isArray(message.toolCalls) || Array.isArray(message.mobileReviewToolCalls);
}

function hydrateDisplayMessagesWithCommittedTurns(
  messages: StudioDisplayMessage[],
  turns: CommittedDisplayTurn[],
  appendMissing: boolean
): StudioDisplayMessage[] {
  if (turns.length === 0) return messages;

  const hydrated = messages.map((message) => ({ ...message }));
  const usedTurnIndexes = new Set<number>();

  for (const message of hydrated) {
    if (message.role !== "assistant") continue;

    const commitId = typeof message.commitId === "string" ? message.commitId : "";
    const content = typeof message.content === "string" ? message.content : "";
    let turnIndex = commitId
      ? turns.findIndex((turn, index) => !usedTurnIndexes.has(index) && turn.commitId === commitId)
      : -1;

    if (turnIndex === -1 && content.trim() !== "") {
      turnIndex = turns.findIndex((turn, index) => (
        !usedTurnIndexes.has(index) &&
        turn.textContent === content
      ));
    }

    if (turnIndex === -1) continue;

    usedTurnIndexes.add(turnIndex);
    const turn = turns[turnIndex]!;
    if (!message.commitId) message.commitId = turn.commitId;
    if (!message.agentRunId) message.agentRunId = turn.runId;
    if (turn.lane && !message.lane) message.lane = turn.lane;
    if (turn.questionPrompt && !message.questionPrompt) message.questionPrompt = turn.questionPrompt;
    if (!messageHasReviewCalls(message) && turn.writeToolCalls?.length) {
      message.toolCalls = turn.writeToolCalls;
      message.proposalStatus = message.proposalStatus ?? "approved";
    }
  }

  if (!appendMissing) return hydrated;

  for (let index = 0; index < turns.length; index++) {
    if (usedTurnIndexes.has(index)) continue;
    const turn = turns[index]!;
    hydrated.push({
      id: `server-${turn.commitId}`,
      role: "assistant",
      content: turn.textContent,
      agentRunId: turn.runId,
      commitId: turn.commitId,
      ...(turn.lane ? { lane: turn.lane } : {}),
      ...(turn.questionPrompt ? { questionPrompt: turn.questionPrompt } : {}),
      ...(turn.writeToolCalls?.length ? { toolCalls: turn.writeToolCalls, proposalStatus: "approved" } : {}),
    });
  }

  return hydrated;
}

function displayStudioMessagesToComparableHistory(
  messages: Array<Record<string, unknown>>
): ChatMessage[] {
  const history: ChatMessage[] = [];

  for (const message of messages) {
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;

    const content = typeof message.content === "string" ? message.content : "";
    const imageUrls = role === "user" ? imageAttachmentUrls(message.attachments) : [];
    if (content.trim() === "" && imageUrls.length === 0) continue;

    if (role === "assistant" || imageUrls.length === 0) {
      history.push({ role, content });
      continue;
    }

    const parts: ContentPart[] = [];
    if (content.trim() !== "") {
      parts.push({ type: "text", text: content });
    }
    for (const url of imageUrls) {
      parts.push({ type: "image_url", image_url: { url } });
    }

    history.push({ role, content: parts });
  }

  return history;
}

function contentSignature(content: MessageContent): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function sameChatMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.role !== b.role) return false;
  if (a.role === "tool" || b.role === "tool") return false;
  return contentSignature(a.content) === contentSignature(b.content);
}

/** A standalone write summary: the whole message is server-synthesized (a
 *  write-only run with no wrap-up text). It has no display counterpart by
 *  construction, so the display filter can't match it — its survival is tied
 *  to its run's user message instead. */
function isStandaloneWriteSummary(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    typeof message.content === "string" &&
    message.content.startsWith(WRITE_SUMMARY_PREFIX) &&
    message.content.endsWith("〕")
  );
}

/** Strip the trailing "\n〔本轮改动：…〕" suffix from a write-run answer.
 *  Returns null when no suffix is present. */
function stripWriteSummarySuffix(content: string): string | null {
  if (!content.endsWith("〕")) return null;
  const start = content.lastIndexOf(`\n${WRITE_SUMMARY_PREFIX}`);
  if (start === -1) return null;
  return content.slice(0, start);
}

/** Display equality that tolerates the server-appended write summary. The
 *  display transcript stores a write-run answer's RAW text; the server history
 *  version carries the appended 〔本轮改动〕 suffix. Exact-content matching
 *  therefore dropped every write-run answer from model history — the model saw
 *  its previous request "unanswered" and re-executed it (prod bug 2026-08-06).
 *  The suffix-stripped comparison trims both sides because the summary append
 *  trims the answer, so whitespace can legitimately differ. */
function matchesDisplayMessage(serverMessage: ChatMessage, displayMessage: ChatMessage): boolean {
  if (sameChatMessage(serverMessage, displayMessage)) return true;
  if (serverMessage.role !== "assistant" || displayMessage.role !== "assistant") return false;
  if (typeof serverMessage.content !== "string" || typeof displayMessage.content !== "string") return false;

  const stripped = stripWriteSummarySuffix(serverMessage.content);
  return stripped !== null && stripped.trim() === displayMessage.content.trim();
}

function filterServerOwnedHistoryByDisplayMessages(
  serverHistory: ChatMessage[],
  displayMessages: Array<Record<string, unknown>>, limit = 40
): ChatMessage[] {
  const displayHistory = displayStudioMessagesToComparableHistory(displayMessages);
  if (displayHistory.length === 0) return [];

  const filtered: ChatMessage[] = [];
  let searchFrom = 0;
  let previousKept = false;

  for (const serverMessage of serverHistory) {
    // A standalone summary survives iff the message before it (its run's user
    // message) survived — so a user-deleted / undone exchange still drops its
    // summary, but a live exchange keeps its "what changed" memory.
    if (isStandaloneWriteSummary(serverMessage)) {
      if (previousKept) filtered.push(serverMessage);
      continue;
    }

    const matchIndex = displayHistory.findIndex((displayMessage, index) => (
      index >= searchFrom && matchesDisplayMessage(serverMessage, displayMessage)
    ));
    if (matchIndex === -1) {
      previousKept = false;
      continue;
    }

    filtered.push(serverMessage);
    searchFrom = matchIndex + 1;
    previousKept = true;
  }

  return filtered.slice(-limit);
}

export function withStudioUserMessageContext(
  context: Record<string, unknown> | undefined,
  userMessage: ChatMessage
): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.entries(context ?? {}).filter(([key]) => key !== STUDIO_STEERING_KEY && key !== "studioCompaction" && key !== "studioToolTrace")),
    [STUDIO_USER_MESSAGE_CONTEXT_KEY]: userMessage,
  };
}

export async function loadStudioConversationForWorld(
  scope: ConversationScope
): Promise<StudioConversation | null> {
  const [row] = await db
    .select()
    .from(studioConversations)
    .where(scopedConversationWhere(scope))
    .limit(1);

  return row ?? null;
}

export async function loadStudioConversationForDisplay(
  scope: ConversationScope
): Promise<StudioConversationForDisplay | null> {
  const conversation = await loadStudioConversationForWorld(scope);
  if (!conversation) return null;

  const runs = await db
    .select({
      id: agentRuns.id,
      committedTurns: agentRuns.committedTurns,
      context: agentRuns.context,
      status: agentRuns.status,
      updatedAt: agentRuns.updatedAt,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.worldId, scope.worldId),
        eq(agentRuns.conversationId, scope.conversationId)
      )
    )
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));

  const turns = runs.flatMap((run) => {
    const committedTurns = Array.isArray(run.committedTurns) ? run.committedTurns : [];
    return committedTurns
      .map((turn) => normalizeCommittedDisplayTurn(run.id, turn))
      .filter((turn): turn is CommittedDisplayTurn => turn !== null);
  });
  const latestRunUpdatedAt = runs.reduce<Date | null>((latest, run) => {
    if (!run.updatedAt) return latest;
    return !latest || run.updatedAt > latest ? run.updatedAt : latest;
  }, null);
  const appendMissing = !!latestRunUpdatedAt && (!conversation.updatedAt || conversation.updatedAt <= latestRunUpdatedAt);
  const displayMessages = hydrateDisplayMessagesWithCommittedTurns(conversation.messages, turns, appendMissing);
  for (const run of runs) {
    const visible = appendMissing || displayMessages.some(message => message.agentRunId === run.id);
    for (const item of readStudioSteering(run.context, run.status)) {
      const existing = displayMessages.findIndex(message => message.id === item.id && message.agentRunId === run.id);
      const message = { id: item.id, role: "user", content: item.content, agentRunId: run.id,
        steering: { status: item.status, createdAt: item.createdAt, beforeIteration: item.beforeIteration } };
      if (existing >= 0) displayMessages[existing] = message;
      else if (visible) {
        const nextTurn = (run.committedTurns ?? []).find(turn => turn.iteration >= (item.beforeIteration ?? Infinity));
        const position = nextTurn ? displayMessages.findIndex(message => message.commitId === nextTurn.commitId) : -1;
        if (position >= 0) displayMessages.splice(position, 0, message);
        else displayMessages.push(message);
      }
    }
  }
  // Reattach a persisted proposal even if the browser closed before saving its
  // chat bubble. Only attach to visible history; never resurrect an undone run.
  for (const run of runs) {
    const proposal = readPersistedImageBatchProposal(run.context, run.status);
    if (!proposal || proposal.runId !== run.id) continue;
    const message = [...displayMessages].reverse().find(item => item.role === "assistant" && item.agentRunId === run.id);
    if (message) message.imageBatchProposal = { ...proposal,
      ...(isRecord(message.imageBatchProposal) && isRecord(message.imageBatchProposal.batch) ? { batch: message.imageBatchProposal.batch } : {}),
    };
  }

  return {
    ...conversation,
    messages: displayMessages,
  };
}

export async function updateStudioConversationForWorld({
  updates,
  ...scope
}: UpdateConversationScope): Promise<boolean> {
  const rows = await db
    .update(studioConversations)
    .set({ ...updates, updatedAt: updates.updatedAt ?? new Date() })
    .where(scopedConversationWhere(scope))
    .returning();

  return rows.length > 0;
}

export async function deleteStudioConversationForWorld(
  scope: ConversationScope
): Promise<boolean> {
  const rows = await db
    .delete(studioConversations)
    .where(scopedConversationWhere(scope))
    .returning();

  return rows.length > 0;
}

export function serverOwnedStudioRunsToAgentHistory(
  runs: Pick<AgentRun, "context" | "committedTurns">[], limit = 40
): ChatMessage[] {
  const history: ChatMessage[] = [];

  for (const run of runs) {
    const context = isRecord(run.context) ? run.context : {};
    const userMessage = normalizeStoredUserMessage(context[STUDIO_USER_MESSAGE_CONTEXT_KEY]);
    if (userMessage) {
      history.push(userMessage);
    }
    const steering = readStudioSteering(context).filter(item => item.status === "applied")
      .sort((a, b) => (a.beforeIteration ?? 0) - (b.beforeIteration ?? 0));
    let previousIteration = -1;
    for (const item of steering) {
      history.push(...runCommittedAssistantMessages({ committedTurns: (run.committedTurns ?? [])
        .filter(turn => turn.iteration > previousIteration && turn.iteration < (item.beforeIteration ?? 0)) }));
      if (item.content.trim() !== "/summarize") history.push({ role: "user", content: item.content });
      previousIteration = (item.beforeIteration ?? 0) - 1;
    }
    history.push(...runCommittedAssistantMessages({ committedTurns: (run.committedTurns ?? []).filter(turn => turn.iteration > previousIteration) }));
  }

  return history.slice(-limit);
}

/** A summary replaces only an unchanged server-owned prefix. Removing or
 * editing covered conversation messages invalidates it instead of resurrecting
 * facts from an undone task. Client transcripts never supply summary content. */
export function applyStudioCompactionHistory(history: ChatMessage[], runs: Pick<AgentRun, "context" | "committedTurns">[]): ChatMessage[] {
  const marker = (message: ChatMessage) => {
    const content = typeof message.content === "string"
      ? message.content.split(WRITE_SUMMARY_PREFIX)[0]!.trim() : JSON.stringify(message.content);
    return content ? JSON.stringify([message.role, content]) : "";
  };
  for (const run of [...runs].reverse()) {
    const saved = run.context?.studioCompaction as Record<string, unknown> | undefined;
    if (!saved || saved.success !== true || !Array.isArray(saved.coverage) || !saved.coverage.length || !Array.isArray(saved.messages)) continue;
    const coverage = (saved.coverage as ChatMessage[]).map(marker).filter(Boolean);
    if (!coverage.length) continue;
    let next = 0;
    for (let index = 0; index < history.length; index++) {
      const current = marker(history[index]!);
      if (!current) continue;
      if (current !== coverage[next]) break;
      next++;
      if (next === coverage.length) {
        return [...saved.messages as ChatMessage[], ...history.slice(index + 1)];
      }
    }
  }
  return history;
}

export async function loadAgentHistoryForConversation(
  scope: ConversationScope, options?: { forCompactionCoverage?: boolean }
): Promise<ChatMessage[] | null> {
  const conversation = await loadStudioConversationForWorld(scope);
  if (!conversation) return null;

  const runs = await db
    .select({
      id: agentRuns.id,
      context: agentRuns.context,
      committedTurns: agentRuns.committedTurns,
      updatedAt: agentRuns.updatedAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.worldId, scope.worldId),
        eq(agentRuns.conversationId, scope.conversationId)
      )
    )
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));

  const serverHistory = serverOwnedStudioRunsToAgentHistory(runs, Number.MAX_SAFE_INTEGER);
  const latestRunUpdatedAt = runs.reduce<Date | null>((latest, run) => {
    if (!run.updatedAt) return latest;
    return !latest || run.updatedAt > latest ? run.updatedAt : latest;
  }, null);

  const visibleHistory = !latestRunUpdatedAt || !conversation.updatedAt || conversation.updatedAt <= latestRunUpdatedAt
    ? serverHistory : filterServerOwnedHistoryByDisplayMessages(serverHistory, conversation.messages, Number.MAX_SAFE_INTEGER);
  if (options?.forCompactionCoverage) return visibleHistory;
  const compactedHistory = applyStudioCompactionHistory(visibleHistory, runs);
  return compactedHistory === visibleHistory ? visibleHistory.slice(-40) : compactedHistory;
}
