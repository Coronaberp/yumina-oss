import { recoverStudioTrace, type StudioTraceItem } from "@yumina/shared";

export function readStudioToolTrace(context: Record<string, unknown> | null, messages: unknown): StudioTraceItem[] {
  const stored = context?.studioToolTrace;
  if (Array.isArray(stored)) return stored.filter((item): item is StudioTraceItem => item && typeof item.id === "string"
    && typeof item.title === "string" && typeof item.detail === "string" && ["working", "done", "failed"].includes(item.status)
    && ["read", "search", "image", "write", "check", "action"].includes(item.kind)).slice(-200).map(item => ({
      id: item.id, kind: item.kind, title: item.title.slice(0, 120), detail: item.detail.slice(0, 240), status: item.status,
      ...(typeof item.assetRef === "string" && /^@asset:[A-Za-z0-9_-]+$/.test(item.assetRef) ? { assetRef: item.assetRef } : {}),
      ...(Array.isArray(item.generatedNames) ? { generatedNames: item.generatedNames.filter(name => typeof name === "string").slice(0, 100)
        .map(name => name.replace(/[\u0000-\u001f]/g, " ").slice(0, 120)).filter(Boolean) } : {}),
    }));
  return recoverStudioTrace(messages, context?.studioUserMessage);
}
