import { compareVersionDraft, type VersionComparisonInput } from "./version-comparison-data";

self.onmessage = (event: MessageEvent<VersionComparisonInput>) => {
  try {
    self.postMessage({ diff: compareVersionDraft(event.data) });
  } catch {
    self.postMessage({ error: true });
  }
};
