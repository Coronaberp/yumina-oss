import type { WorldDiff } from "@yumina/engine";
import type { VersionComparisonInput } from "./version-comparison-data";

/** Cancellation disposes the worker, including a comparison already in progress. */
export function startVersionComparison(input: VersionComparisonInput, done: (diff: WorldDiff | null) => void): () => void {
  let worker: Worker | undefined;
  let active = true;
  const finish = (diff: WorldDiff | null) => {
    if (!active) return;
    active = false;
    worker?.terminate();
    done(diff);
  };
  try {
    worker = new Worker(new URL("./version-comparison.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ diff?: WorldDiff }>) => finish(event.data.diff ?? null);
    worker.onerror = event => { event.preventDefault(); finish(null); };
    worker.onmessageerror = () => finish(null);
    worker.postMessage(input);
  } catch {
    finish(null);
  }
  return () => { active = false; worker?.terminate(); };
}
