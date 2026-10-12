import type { StudioTraceItem } from "@yumina/shared";
import type { StudioChatMessage } from "./types";

export function startStudioToolTrace(messages: StudioChatMessage[], runId: string, model: string, startedAt = Date.now()): StudioChatMessage[] {
  const index = messages.findIndex(message => message.activityTrace?.runId === runId);
  if (index < 0) return [...messages, { id: `trace-${runId}`, role: "assistant", content: "", agentRunId: runId,
    activityTrace: { runId, model, items: [], startedAt } }];
  return messages.map((message, at) => at === index ? { ...message, activityTrace: {
    ...message.activityTrace!, startedAt: message.activityTrace!.startedAt ?? startedAt,
  } } : message);
}

export function mergeStudioToolTrace(messages: StudioChatMessage[], data: unknown, restore = false): StudioChatMessage[] {
  const trace = data as { runId?: unknown; model?: unknown; items?: unknown[] } | null;
  if (!trace || typeof trace.runId !== "string" || typeof trace.model !== "string" || !Array.isArray(trace.items)) return messages;
  const items = trace.items.filter((value): value is StudioTraceItem => {
    const item = value as Partial<StudioTraceItem> | null;
    return !!item && typeof item.id === "string" && typeof item.title === "string" && typeof item.detail === "string"
      && ["read", "search", "image", "write", "check", "action"].includes(item.kind ?? "") && ["working", "done", "failed", "unconfirmed"].includes(item.status ?? "");
  });
  if (!items.length) return messages;
  const index = messages.findIndex(message => message.activityTrace?.runId === trace.runId);
  if (index < 0 && !restore) return messages;
  const merged = new Map((index < 0 ? [] : messages[index]!.activityTrace!.items).map(item => [item.id, item]));
  for (const item of items) {
    if (item.status === "working" && merged.get(item.id)?.status !== undefined && merged.get(item.id)?.status !== "working") continue;
    merged.set(item.id, Array.isArray(item.generatedNames) ? { ...item, generatedNames: item.generatedNames
      .filter((name): name is string => typeof name === "string").slice(0, 100)
      .map(name => name.replace(/[\u0000-\u001f]/g, " ").slice(0, 120)).filter(Boolean) } : item);
  }
  const previousTrace = index < 0 ? undefined : messages[index]!.activityTrace;
  const activityTrace = { runId: trace.runId, model: trace.model, items: [...merged.values()].slice(-200),
    ...(typeof previousTrace?.startedAt === "number" ? { startedAt: previousTrace.startedAt } : {}),
    ...(typeof previousTrace?.completedAt === "number" ? { completedAt: previousTrace.completedAt } : {}) };
  return index < 0 ? [...messages, { id: `trace-${trace.runId}`, role: "assistant", content: "", agentRunId: trace.runId, activityTrace }]
    : messages.map((message, at) => at === index ? { ...message, activityTrace } : message);
}

/** End only unconfirmed requests; completed activity keeps its actual outcome. */
export function endStudioToolTrace(messages: StudioChatMessage[], runId: string | null | undefined): StudioChatMessage[] {
  if (!runId) return messages;
  return messages.map(message => {
    const trace = message.activityTrace;
    return trace?.runId === runId ? { ...message, activityTrace: {
    ...trace, completedAt: trace.completedAt ?? Date.now(), items: trace.items.map(item => item.status === "working"
      ? { ...item, status: "unconfirmed" as const, title: "Outcome not received" } : item),
    } } : message;
  });
}
