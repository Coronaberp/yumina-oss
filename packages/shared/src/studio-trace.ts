import { normalizeStudioVisualAuditPage } from "./studio-visual-audit.js";

export type StudioTraceItem = {
  id: string; kind: "read" | "search" | "image" | "write" | "check" | "action";
  title: string; detail: string; status: "working" | "done" | "failed" | "unconfirmed"; assetRef?: string; generatedNames?: string[];
};
type Call = { id: string; function: { name: string; arguments: string } };
type Result = { status: string; result?: unknown; error?: unknown };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, 240) : "";
const names = (value: unknown) => Array.isArray(value) ? value.filter(item => typeof item === "string").slice(0, 8).join(", ").slice(0, 240) : text(value);
const READ_LABELS: Record<string, string> = { list_assets: "Asset library", list_vn_assets: "Visual Novel images", get_image_sources: "Image connections", get_image_job: "Image job" };

/** Only public display fields are copied; never serialize arbitrary arguments/results. */
export function describeStudioTrace(call: Call, result?: Result): StudioTraceItem {
  let args: Record<string, unknown> = {};
  try { args = record(JSON.parse(call.function.arguments)); } catch { /* Invalid request still has a factual action row. */ }
  const name = call.function.name, output = record(result?.result);
  const skipped = output.status === "skipped" || (typeof result?.result === "string" && result.result.startsWith("Skipped because"));
  const item: StudioTraceItem = { id: call.id, kind: "action", title: "Used agent tool", detail: "", status: result ? result.status === "success" ? "done" : "failed" : "working" };
  if (name === "view_image") {
    item.kind = "image";item.title = result?.status === "success" ? "Opened image" : "Open image";
    item.detail = text(output.name) || text(args.assetRef);
    if (result?.status === "success" && typeof output.ref === "string" && /^@asset:[A-Za-z0-9_-]+$/.test(output.ref)) item.assetRef = output.ref;
  } else if (name === "grep_world" || name.startsWith("search_")) {
    item.kind = "search";item.title = result ? "Searched" : "Search";
    item.detail = [text(args.query) || text(args.tags), text(args.scope)].filter(Boolean).join(" · ").slice(0, 240);
  } else if (name === "generate_image") {
    item.kind = "image";item.title = result?.status === "success" ? "Queued image" : "Request image";item.detail = text(args.purpose) || "Image generation";
  } else if (name === "get_visual_audit_inputs") {
    item.kind = "read";item.title = result ? "Read" : "Read files";
    const { offset, limit } = normalizeStudioVisualAuditPage(output.offset ?? args.offset, output.limit ?? args.limit);
    const total = typeof output.total === "number" ? output.total : undefined;
    const label = args.kind === "backgrounds" ? "Background visual references" : "Character visual references";
    const range = total === undefined ? `${offset + 1}–${offset + limit}` : offset >= total ? `0 of ${total}` : `${offset + 1}–${Math.min(offset + limit, total)} of ${total}`;
    item.detail = `${label} · ${range}`;
  } else if (name.startsWith("read_") || name.startsWith("list_") || name.startsWith("get_") || name === "load_skill" || name === "browse_assets") {
    item.kind = "read";item.title = result ? "Read" : "Read files";
    item.detail = names(args.ids) || text(args.id) || text(args.name) || text(args.kind) || READ_LABELS[name] || "Card information";
  } else if (name.startsWith("validate_") || name.startsWith("compile_") || name.startsWith("analyze_")) {
    item.kind = "check";item.title = result ? "Checked" : "Check";item.detail = name === "validate_world" ? "Card validation" : "Interface and settings";
  } else if (/^(write|edit|delete|create|apply)_?/.test(name)) {
    item.kind = "write";item.title = result ? "Changed" : "Change requested";
    item.detail = text(output.name) || text(args.name) || text(args.id) || names(args.ids) || text(args.kind) || "Card content";
  } else if (name === "import_danbooru_image") {
    item.kind = "image";item.title = result ? "Imported image" : "Import image";item.detail = "Artwork library";
  } else if (name === "generate_names") {
    const generatedNames = Array.isArray(output.names)
      ? output.names.filter((value): value is string => typeof value === "string").slice(0, 100)
        .map(value => text(value).slice(0, 120)).filter(Boolean)
      : [];
    item.title = result?.status === "success" ? "Generated names" : "Generate names";
    item.detail = result?.status === "success" ? `${generatedNames.length} ${generatedNames.length === 1 ? "name" : "names"}` : "";
    if (result) item.generatedNames = result.status === "success" ? generatedNames : [];
  }
  if (item.status === "failed") item.title = name === "generate_names" ? "Name generation failed"
    : ({ read: "Read failed", search: "Search failed", image: "Image action failed", write: "Change failed", check: "Check failed", action: "Action failed" })[item.kind];
  if (item.kind === "write" && output.status === "partial" && Number.isInteger(output.completed) && Number.isInteger(output.total)) {
    item.status = "working";item.title = "Changes in progress";item.detail = `${output.completed} of ${output.total} changes saved`;
  } else if (item.kind === "write" && output.status === "partial_failure" && Number.isInteger(output.completed) && Number.isInteger(output.failed)) {
    item.status = "failed";item.title = "Some changes failed";item.detail = `${output.completed} changes saved, ${output.failed} failed`;
  }
  if (skipped) { item.status = "failed";item.title = "Not executed"; }
  return item;
}

/** Old runs can recover completed activity from their compact actual tool outputs. */
export function recoverStudioTrace(messages: unknown, sinceRequest?: unknown): StudioTraceItem[] {
  if (!Array.isArray(messages)) return [];
  const marker = sinceRequest ? JSON.stringify(sinceRequest) : undefined;
  let at = -1;
  if (marker) for (let index = messages.length - 1; index >= 0; index--) {
    if (JSON.stringify(messages[index]) === marker) { at = index;break; }
  }
  if (marker && at < 0) return [];
  const calls = new Map<string, Call>(), items = new Map<string, StudioTraceItem>();
  for (const message of messages.slice(at < 0 ? 0 : at)) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) if (typeof call?.id === "string" && typeof call.function?.name === "string" && typeof call.function?.arguments === "string") calls.set(call.id, call);
    } else if (message?.role === "tool" && calls.has(message.tool_call_id)) {
      try {
        const payload: unknown = JSON.parse(message.content), entries = Array.isArray(payload) ? payload : [payload];
        const failed = entries.some(value => { const result = record(value);return !!result.error || result.status === "error"; });
        items.set(message.tool_call_id, describeStudioTrace(calls.get(message.tool_call_id)!, { status: failed ? "error" : "success", result: payload }));
      } catch { /* Missing/invalid output is never reported as completed. */ }
    }
  }
  return [...items.values()].slice(-200);
}
