import { createHash } from "node:crypto";

export type CodexRpcMessage = {
  id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } | null;
};

function invalidProtocol(line: string, reason: "malformed JSON" | "an invalid JSON-RPC message", stage?: string): Error {
  // JSON.parse errors can contain source text, including account/turn data.
  // Retain a fingerprint and byte count, never the raw line or parse exception.
  const bytes = Buffer.byteLength(line);
  const fingerprint = createHash("sha256").update(line).digest("hex").slice(0, 12);
  return new Error(`Codex returned ${reason} on stdout${stage ? ` while waiting for ${stage}` : " during the active turn"} (${bytes} bytes; reference ${fingerprint}).`);
}

/** Stdio is JSONL. Ignore empty separators and tolerate a leading UTF-8 BOM,
 * while keeping malformed payloads and non-RPC JSON as explicit failures. */
export function parseCodexRpcLine(line: string, stage?: string): CodexRpcMessage | undefined {
  const text = line.trim();
  if (!text) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw invalidProtocol(line, "malformed JSON", stage); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidProtocol(line, "an invalid JSON-RPC message", stage);
  const message = value as CodexRpcMessage;
  const validId = typeof message.id === "string" || typeof message.id === "number" && Number.isFinite(message.id);
  const validMethod = typeof message.method === "string" && message.method.length > 0;
  if (Object.hasOwn(message, "method") ? !validMethod : !validId || !Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) {
    throw invalidProtocol(line, "an invalid JSON-RPC message", stage);
  }
  if (Object.hasOwn(message, "id") && !validId) throw invalidProtocol(line, "an invalid JSON-RPC message", stage);
  if (message.error != null && (typeof message.error !== "object" || Array.isArray(message.error))) {
    throw invalidProtocol(line, "an invalid JSON-RPC message", stage);
  }
  return message;
}
