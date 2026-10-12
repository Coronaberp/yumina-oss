import { GenerationError } from "./config.js";
import { kevContentClassifier } from "../kev-content-classifier.js";

type Classifier = { classify(role: "user", prompt: string): Promise<{ status: string; label: string; routingSafe: boolean }> };

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Image request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Use the installed on-device KEV classifier for local providers. An error
 * blocks generation; only an explicitly selected NSFW-capable model can pass
 * a completed NSFW classification. */
export function createLocalImageRequestCheck(classifier: Classifier) {
  return async (prompt: string, signal?: AbortSignal, nsfwCapable = false): Promise<void> => {
    signal?.throwIfAborted();
    let result: Awaited<ReturnType<Classifier["classify"]>>;
    try { result = await withSignal(classifier.classify("user", prompt), signal); }
    catch {
      signal?.throwIfAborted();
      throw new GenerationError("REQUEST_CHECK_UNAVAILABLE", "Local image generation cannot start because its on-device safety check did not complete.", 503);
    }
    signal?.throwIfAborted();
    if (result.status !== "complete") throw new GenerationError("REQUEST_CHECK_UNAVAILABLE", "Local image generation cannot start because its on-device safety check did not complete.", 503);
    if (nsfwCapable) return;
    if (result.label !== "sfw" || !result.routingSafe) throw new GenerationError("NSFW_MODEL_REQUIRED", "This request needs an NSFW-capable local image model. No image was generated.", 400);
  };
}

export const checkLocalImageRequest = createLocalImageRequestCheck(kevContentClassifier);
