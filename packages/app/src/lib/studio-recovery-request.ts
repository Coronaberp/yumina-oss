export interface StudioRecoveryScope {
  worldId: string;
  conversationId: string | null;
  runId?: string;
}

interface RecoveryRequestOptions {
  apiBase: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Returns the cancellation function for a scheduled deadline. */
  scheduleTimeout?: (callback: () => void, delayMs: number) => () => void;
}

interface PendingRequest {
  promise: Promise<unknown>;
  controller: AbortController | null;
  retryRequested: boolean;
  cancelled: boolean;
}

/** Share one coordinator across polling and reload recovery in the Studio store.
 * It only reads saved status; cancelling a read never stops the server worker.
 */
export function createStudioRecoveryRequestCoordinator(options: RecoveryRequestOptions) {
  const fetchStatus = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const scheduleTimeout = options.scheduleTimeout ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  });
  const pending = new Map<string, PendingRequest>();
  const keyFor = (scope: StudioRecoveryScope) => JSON.stringify([scope.worldId, scope.conversationId, scope.runId ?? null]);
  const urlFor = (scope: StudioRecoveryScope) => {
    const query = scope.runId ? `runId=${encodeURIComponent(scope.runId)}`
      : `conversationId=${encodeURIComponent(scope.conversationId ?? "")}`;
    return `${options.apiBase}/api/studio/${encodeURIComponent(scope.worldId)}/agent/status?${query}`;
  };

  async function read(scope: StudioRecoveryScope, entry: PendingRequest): Promise<unknown> {
    for (;;) {
      const controller = new AbortController();
      entry.controller = controller;
      let rejectAbort!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => rejectAbort(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const clearDeadline = scheduleTimeout(() => controller.abort(
        new DOMException("The Studio status request timed out.", "TimeoutError"),
      ), 12_000);
      try {
        // Race the complete read, including JSON decoding. Abort alone cannot
        // bound a non-cooperative fetch/body or prevent its stale result winning.
        const response = (async () => {
          const result = await fetchStatus(urlFor(scope), {
            method: "GET", credentials: "include", signal: controller.signal,
          });
          if (!result.ok) throw new Error(`HTTP ${result.status}`);
          return result.json() as Promise<unknown>;
        })();
        return await Promise.race([response, aborted]);
      } catch (error) {
        if (!entry.retryRequested || entry.cancelled) throw error;
        entry.retryRequested = false;
      } finally {
        clearDeadline();
        controller.signal.removeEventListener("abort", onAbort);
        entry.controller = null;
      }
    }
  }

  return {
    request<T = unknown>(scope: StudioRecoveryScope): Promise<T> {
      const key = keyFor(scope);
      const existing = pending.get(key);
      if (existing) return existing.promise as Promise<T>;
      const entry: PendingRequest = { promise: undefined as unknown as Promise<unknown>, controller: null,
        retryRequested: false, cancelled: false };
      pending.set(key, entry);
      entry.promise = read({ ...scope }, entry).finally(() => {
        if (pending.get(key) === entry) pending.delete(key);
      });
      return entry.promise as Promise<T>;
    },
    /** A nudge replaces the in-flight GET within its existing shared Promise.
     * False means the caller can wake its polling sleep instead.
     */
    nudge(scope: StudioRecoveryScope): boolean {
      const entry = pending.get(keyFor(scope));
      if (!entry || entry.cancelled) return false;
      entry.retryRequested = true;
      entry.controller?.abort(new DOMException("Retrying the Studio status request.", "AbortError"));
      return true;
    },
    cancel(scope: StudioRecoveryScope): void {
      const entry = pending.get(keyFor(scope));
      if (!entry) return;
      entry.cancelled = true;
      entry.controller?.abort(new DOMException("Studio status recovery cancelled.", "AbortError"));
    },
    isBusy(scope: StudioRecoveryScope): boolean {
      return pending.has(keyFor(scope));
    },
  };
}
