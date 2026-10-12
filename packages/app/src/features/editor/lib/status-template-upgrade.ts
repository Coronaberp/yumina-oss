import type { RootComponent } from "@yumina/engine";
import { upgradeStatusFiles, upgradeStatusRoot } from "@yumina/engine";

const cache = new WeakMap<Record<string, string>, Record<string, string>>();

/** Compatibility at load time also covers saved/published cards with old compiled code. */
export function currentStatusFiles(files: Record<string, string>): Record<string, string> {
  const cached = cache.get(files);
  if (cached) return cached;
  const upgraded = upgradeStatusFiles(files);
  cache.set(files, upgraded);
  return upgraded;
}

export function currentStatusRoot<T extends RootComponent | undefined>(root: T): T {
  return upgradeStatusRoot(root);
}
