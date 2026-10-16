import { describeStudioTrace, recoverStudioTrace, type StudioTraceItem } from "@yumina/shared";

export function readStudioToolTrace(context: Record<string, unknown> | null, messages: unknown): StudioTraceItem[] {
  const stored = context?.studioToolTrace;
  const auditPages = new Map<string, string>();
  if (Array.isArray(messages)) for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (typeof call?.id === "string" && call.function?.name === "get_visual_audit_inputs" && typeof call.function.arguments === "string") {
        auditPages.set(call.id, describeStudioTrace(call).detail);
      }
    }
  }
  if (Array.isArray(stored)) return stored.filter((item): item is StudioTraceItem => item && typeof item.id === "string"
    && typeof item.title === "string" && typeof item.detail === "string" && ["working", "done", "failed"].includes(item.status)
    && ["read", "search", "image", "write", "check", "action"].includes(item.kind)).slice(-200).map(item => ({
      id: item.id, kind: item.kind, title: item.title.slice(0, 120), detail: (auditPages.get(item.id) ?? item.detail).slice(0, 240), status: item.status,
      ...(typeof item.assetRef === "string" && /^@asset:[A-Za-z0-9_-]+$/.test(item.assetRef) ? { assetRef: item.assetRef } : {}),
      ...(Array.isArray(item.generatedNames) ? { generatedNames: item.generatedNames.filter(name => typeof name === "string").slice(0, 100)
        .map(name => name.replace(/[\u0000-\u001f]/g, " ").slice(0, 120)).filter(Boolean) } : {}),
    }));
  return recoverStudioTrace(messages, context?.studioUserMessage);
}
