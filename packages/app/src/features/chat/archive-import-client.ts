import { archiveRequestData } from "./archive-request";
export interface ArchiveImportResult { sessionId: string; worldId: string }
export interface ArchiveImportClientOptions { requestId?: string; contextSessionId?: string; onProgress?: (text: string) => void }
export const ARCHIVE_CHUNK_BYTES = 4 * 1024 * 1024;
interface UploadState { state: "uploading" | "importing" | "complete"; totalBytes: number; receivedBytes: number; result?: ArchiveImportResult }
const attempts = new WeakMap<Blob, string>();
const requests = new WeakMap<Blob, Map<string, Promise<ArchiveImportResult>>>();
const uploadWait = { timeoutMs: 60_000, timeoutMessage: "The archive upload timed out. Retry resumes the same upload." };
const restoreWait = { timeoutMs: 120_000, timeoutMessage: "The import result could not be confirmed. Retry checks the same import instead of creating a duplicate." };
const statusWait = { timeoutMs: 15_000, timeoutMessage: "The import status could not be confirmed. Retry checks the same import." };
function result(value: ArchiveImportResult): ArchiveImportResult {
  if (!value || typeof value.sessionId !== "string" || !value.sessionId || typeof value.worldId !== "string" || !value.worldId) throw new Error("The archive import result could not be confirmed.");
  return value;
}
export function importArchivePayload(payload: Blob, options: ArchiveImportClientOptions = {}, base = ""): Promise<ArchiveImportResult> {
  let id = options.requestId ?? attempts.get(payload);
  if (!id) { id = crypto.randomUUID(); attempts.set(payload, id); }
  const key = `${base}:${id}:${options.contextSessionId ?? ""}`;
  const cache = requests.get(payload) ?? new Map<string, Promise<ArchiveImportResult>>();
  requests.set(payload, cache);
  const existing = cache.get(key); if (existing) return existing;
  const path = `${base}/api/session-archives/uploads/${encodeURIComponent(id)}`;
  const read = () => archiveRequestData<UploadState>(path, { credentials: "include" }, statusWait);
  const work = async () => {
    try {
      if (payload.size <= ARCHIVE_CHUNK_BYTES) {
        const headers: Record<string, string> = { "Content-Type": "application/json", "X-Yumina-Archive-Request": id! };
        if (options.contextSessionId) headers["X-Yumina-Archive-Session"] = options.contextSessionId;
        return result(await archiveRequestData<ArchiveImportResult>(`${base}/api/session-archives/import`, { method: "POST", credentials: "include", headers, body: payload }, restoreWait));
      }
      let status = await archiveRequestData<UploadState>(path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ totalBytes: payload.size, contextSessionId: options.contextSessionId }) }, uploadWait);
      if (status.state === "complete") return result(status.result!);
      if (status.state === "importing") throw new Error("This archive is still being restored. Retry checks the same import instead of creating another one.");
      while (status.receivedBytes < payload.size) {
        if (!Number.isSafeInteger(status.receivedBytes) || status.receivedBytes < 0 || status.totalBytes !== payload.size) throw new Error("The server returned an invalid archive upload position.");
        const offset = status.receivedBytes;
        status = await archiveRequestData<UploadState>(`${path}/chunks/${offset}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/octet-stream" }, body: payload.slice(offset, offset + ARCHIVE_CHUNK_BYTES) }, uploadWait);
        if (status.receivedBytes <= offset || status.receivedBytes > payload.size) throw new Error("The archive upload did not advance. Retry resumes this upload.");
        options.onProgress?.(`Uploading full save… ${Math.floor(status.receivedBytes / payload.size * 100)}%`);
      }
      options.onProgress?.("Restoring the complete saved card and session…");
      return result(await archiveRequestData<ArchiveImportResult>(`${path}/complete`, { method: "POST", credentials: "include" }, restoreWait));
    } catch (error) {
      // A response can be lost after the transaction commits. Reconcile through
      // a read-only status request; never blindly repeat the import POST.
      options.onProgress?.("Checking whether the saved import completed…");
      try { const status = await read(); if (status.state === "complete") return result(status.result!); } catch { /* Preserve the original explicit failure. */ }
      throw error;
    }
  };
  const pending = work().catch(error => { cache.delete(key); throw error; });
  cache.set(key, pending);
  return pending;
}
