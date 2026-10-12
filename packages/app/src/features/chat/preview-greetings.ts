import type { WorldDefinition } from "@yumina/engine";

/** Keep the stable entry ID attached to the body after filtering and sorting. */
export function collectPreviewGreetings(worldDef: Pick<WorldDefinition, "entries" | "settings"> | undefined): Array<{ id: string | null; content: string }> {
  if (!worldDef) return [];
  const fromEntries = (worldDef.entries ?? [])
    .filter(entry => entry.role === "greeting" && entry.enabled !== false)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map(entry => ({ id: entry.id, content: (entry.content ?? "").trim() }))
    .filter(entry => Boolean(entry.content));
  if (fromEntries.length > 0) return fromEntries;
  const fallback = (worldDef.settings as { greeting?: string } | undefined)?.greeting?.trim();
  return fallback ? [{ id: null, content: fallback }] : [];
}
