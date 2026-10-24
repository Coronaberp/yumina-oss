import type { GenerateParams } from "./llm/types.js";

/** Server-only, process-local diagnostics. Never attach these to message JSON. */
const ATTEMPT_BYTES = 32 * 1024;
const MAX_ATTEMPTS = 4;
const parameterKeys = new Set([
  "model", "stream", "temperature", "top_p", "top_k", "min_p", "max_tokens",
  "max_completion_tokens", "frequency_penalty", "presence_penalty", "repetition_penalty",
  "reasoning_effort", "reasoning", "thinking", "think", "response_format", "format",
  "generationConfig", "options", "num_ctx", "tool_choice", "cache_control", "provider",
  "chat_template_kwargs", "stream_options",
]);
const secretKey = /authorization|headers?|cookie|secret|password|credential|api.?key|access.?token|refresh.?token|signature/i;
const promptKeys = ["system", "systemInstruction", "messages", "contents", "input", "tools"];

export interface WireRequest {
  provider: string;
  body: Record<string, unknown>;
  /** For protocols such as Google that select the model in the URL. */
  model?: string;
  secrets?: string[];
}
export type { RequestSnapshot, RequestReceipt, ReportedRequestUsage } from "@yumina/shared";
import type { RequestSnapshot, RequestReceipt, ReportedRequestUsage } from "@yumina/shared";

export function snapshotRequest(provider: string, body: Record<string, unknown>, secrets: string[] = [], wireModel?: string): RequestSnapshot {
  let budget = 24000, nodes = 0, truncated = false, textChars = 0;
  const redact = (text: string): string => {
    // Redact before cutting so a credential crossing the cut cannot leave a prefix.
    for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
    text = text.replace(/\b(?:sk-|sk_|AIza)[a-zA-Z0-9_-]{16,}/g, "[redacted]")
      .replace(/((?:authorization|proxy-authorization|x-api-key|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
      .replace(/\b(?:Bearer|Basic)\s+[\w.\-+/=]+/gi, "[authentication redacted]")
      .replace(/((?:api[_-]?key|password|secret|token|authorization)["']?\s*[=:]\s*)(["'])(?:\\[\s\S]|(?!\2)[^\\])*\2/gi, "$1$2[redacted]$2")
      .replace(/((?:api[_-]?key|password|secret|token|authorization)["']?\s*[=:]\s*)([^\s"'\r\n][^\r\n]*)/gi, "$1[redacted]")
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[private key redacted]")
      .replace(/data:(?:image|audio)\/[^\s"']+/gi, "[media data omitted]")
      .replace(/https?:\/\/[^\s<>"')]+/gi, "[URL omitted]");
    const max = Math.max(0, Math.floor(budget / 6));
    if (text.length > max) { text = text.slice(0, max); truncated = true; }
    budget -= Buffer.byteLength(JSON.stringify(text));
    return text;
  };
  const clean = (value: unknown, depth = 0): unknown => {
    if (budget <= 0 || ++nodes > 2048 || depth > 12) { truncated = true; return "[omitted]"; }
    if (typeof value === "string") { textChars += value.length; return redact(value); }
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean" || value === null) return value;
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        if (budget <= 0 || nodes > 2048) { truncated = true; break; }
        result.push(clean(item, depth + 1));
      }
      return result;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (obj.type === "image_url" || obj.type === "image" || obj.inlineData || obj.fileData) return "[image omitted]";
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key in obj) {
        if (!Object.hasOwn(obj, key)) continue;
        if (budget <= 0 || nodes > 2048) { truncated = true; break; }
        nodes++;
        budget -= 8;
        const redactedKey = redact(key);
        if (redactedKey.length > 100) truncated = true;
        const safeKey = redactedKey.slice(0, 100);
        if (secretKey.test(key) || key === "images") result[safeKey] = "[redacted or image omitted]";
        else result[safeKey] = clean(obj[key], depth + 1);
      }
      return result;
    }
    return undefined;
  };
  const parameters: Record<string, unknown> = {};
  for (const key of parameterKeys) if (body[key] !== undefined) parameters[key] = clean(body[key]);
  textChars = 0;
  const sections: RequestSnapshot["sections"] = [];
  for (const key of promptKeys) {
    const value = body[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (budget <= 0 || nodes > 2048) { truncated = true; break; }
        sections.push({ name: `${key}[${i}]`, text: JSON.stringify(clean(value[i])) ?? "" });
      }
    } else sections.push({ name: key, text: JSON.stringify(clean(value)) ?? "" });
  }
  const result: RequestSnapshot = { provider, model: typeof parameters.model === "string" ? parameters.model : wireModel ? redact(wireModel) : "provider-selected", parameters, sections, estimatedTextTokens: Math.ceil(textChars / 4), truncated };
  // A hard serialized byte cap also covers object/section/key overhead.
  while (Buffer.byteLength(JSON.stringify(result)) > ATTEMPT_BYTES && result.sections.length) {
    result.sections.pop(); result.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > ATTEMPT_BYTES) { result.parameters = {}; result.truncated = true; }
  return result;
}

/** Observational only: hook exceptions must never change a generation. */
export function inspectWireRequest(params: GenerateParams, provider: string, body: Record<string, unknown>, secrets?: string[], model?: string): void {
  if (!params.onRequest) return;
  try { params.onRequest({ provider, body, secrets, ...(model && { model }) }); } catch { /* private diagnostics are best-effort */ }
}

export function inspectWireUsage(params: GenerateParams, usage: ReportedRequestUsage): void {
  if (!params.onRequestUsage) return;
  try { params.onRequestUsage(usage); } catch { /* diagnostics never change dispatch */ }
}

export function createRequestCapture() {
  const attempts: RequestSnapshot[] = [];
  let omittedAttempts = 0;
  let reportedUsage: ReportedRequestUsage | undefined;
  return {
    onRequest(request: WireRequest) {
      // This is a job sent to a browser; that browser still shapes the runtime
      // HTTP body. It cannot truthfully stand in for the final model request.
      if (request.provider === "local-bridge") return;
      reportedUsage = undefined;
      attempts.push(snapshotRequest(request.provider, request.body, request.secrets, request.model));
      if (attempts.length > MAX_ATTEMPTS) { attempts.shift(); omittedAttempts++; }
    },
    onUsage(usage: ReportedRequestUsage) {
      for (const key of ["promptTokens", "completionTokens", "totalTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
        const value = usage[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) (reportedUsage ??= {})[key] = value;
      }
    },
    finish(kind: RequestReceipt["kind"]): RequestReceipt {
      return { id: crypto.randomUUID(), kind, capturedAt: new Date().toISOString(), attempts: [...attempts], omittedAttempts, ...(reportedUsage && { usage: { ...reportedUsage } }) };
    },
  };
}

export interface ReceiptScope { userId: string; worldId: string; sessionId: string; messageId: string; swipeIndex: number }
export class RequestReceiptCache {
  private entries = new Map<string, { receipts: Array<{ receipt: RequestReceipt; expires: number }>; bytes: number }>();
  private bytes = 0;
  private limits: { now: () => number; ttlMs: number; maxEntries: number; maxBytes: number };
  constructor(limits: Partial<RequestReceiptCache["limits"]> = {}) {
    this.limits = { now: Date.now, ttlMs: 30 * 60_000, maxEntries: 100, maxBytes: 4 * 1024 * 1024, ...limits };
    const timer = setInterval(() => this.prune(), 60_000); timer.unref();
  }
  private key(scope: ReceiptScope) { return JSON.stringify([scope.userId, scope.worldId, scope.sessionId, scope.messageId, scope.swipeIndex]); }
  private remove(key: string) { const old = this.entries.get(key); if (old) this.bytes -= old.bytes; this.entries.delete(key); }
  private prune() {
    for (const [key, entry] of this.entries) {
      const receipts = entry.receipts.filter(item => item.expires > this.limits.now());
      if (!receipts.length) this.remove(key);
      else if (receipts.length !== entry.receipts.length) {
        const bytes = Buffer.byteLength(JSON.stringify(receipts));
        this.bytes += bytes - entry.bytes;
        this.entries.set(key, { receipts, bytes });
      }
    }
  }
  put(scope: ReceiptScope, receipt: RequestReceipt) {
    if (!receipt.attempts.length) return;
    this.prune();
    const key = this.key(scope);
    const receipts = [...(this.entries.get(key)?.receipts ?? []), { receipt, expires: this.limits.now() + this.limits.ttlMs }].slice(-4);
    this.remove(key);
    const bytes = Buffer.byteLength(JSON.stringify(receipts));
    if (bytes > this.limits.maxBytes) return;
    this.entries.set(key, { receipts, bytes }); this.bytes += bytes;
    while (this.entries.size > this.limits.maxEntries || this.bytes > this.limits.maxBytes) this.remove(this.entries.keys().next().value!);
  }
  get(scope: ReceiptScope) { this.prune(); return this.entries.get(this.key(scope))?.receipts.map(item => item.receipt); }
  stats() { this.prune(); return { entries: this.entries.size, bytes: this.bytes }; }
}
export const requestReceipts = new RequestReceiptCache();

export function createOwnedRequestCapture(viewerId: string, sessionOwnerId: string, cardOwnerId: string) {
  return !!viewerId && viewerId === sessionOwnerId && viewerId === cardOwnerId ? createRequestCapture() : undefined;
}

export function retainRequestCapture(capture: ReturnType<typeof createRequestCapture> | undefined, scope: ReceiptScope, kind: RequestReceipt["kind"]): void {
  if (!capture) return;
  try { requestReceipts.put(scope, capture.finish(kind)); } catch { /* never fail a saved generation for diagnostics */ }
}
