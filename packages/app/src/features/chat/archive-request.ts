/** A proxy error page is an HTTP failure, never an archive JSON payload. */
export async function archiveResponseData<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown;
  if (!text.trimStart().startsWith("<")) {
    try { body = JSON.parse(text); } catch { /* Report HTTP/malformed-response failures below. */ }
  }
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!response.ok) {
    const message = typeof record?.error === "string" ? record.error : response.status === 413
      ? "The server rejected this archive upload because the request is too large."
      : "The archive request could not be completed.";
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  if (!record || !("data" in record)) throw new Error("The server returned an unexpected archive response. The import result could not be confirmed.");
  return record.data as T;
}

/** Bound both response headers and body reads. A timeout stops waiting in this
 * browser; it does not assert that a server-side restore was cancelled. */
export async function archiveRequestData<T>(url: string, init: RequestInit = {}, options: { timeoutMs?: number; timeoutMessage?: string } = {}): Promise<T> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await archiveResponseData<T>(await fetch(url, { ...init, signal }));
  } catch (error) {
    if (timeout.aborted) throw new Error(options.timeoutMessage ?? "The archive request timed out. Try again.");
    throw error;
  }
}
