import type { WorldDefinition } from "@yumina/engine";
import type { StudioTaskCheck } from "@yumina/shared";

const collections = ["entries", "variables", "rules", "reactions", "chapters", "routes", "endings", "worldbooks", "audioTracks"] as const;
const itemLabels = { entries: "lorebook entry", variables: "variable", rules: "rule", reactions: "reaction", chapters: "chapter", routes: "route", endings: "ending", worldbooks: "knowledge base", audioTracks: "audio track" };
const fields: Record<string, string> = {
  content: "text", type: "value type", defaultValue: "starting value", initialValue: "starting value",
  tsxCode: "code", jsCode: "code", rootComponent: "interface", firstMessage: "opening message",
  systemPrompt: "instructions", authorNote: "author's note", isPublished: "publication setting",
};
const humanize = (text: string) => text.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[-_.]+/g, " ").trim();
const isOpaque = (text: string) => /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i.test(text);
const quote = (text: string) => `“${text.length > 100 ? text.slice(0, 97) + "…" : text}”`;

function entityName(world: WorldDefinition, id: string, collection: typeof collections[number]) {
  const item = (world[collection] as Array<{ id: string; name?: string; title?: string; label?: string }> | undefined)?.find(item => item.id === id);
  return item?.name || item?.title || item?.label || (!isOpaque(id) ? humanize(id) : `this ${itemLabels[collection]}`);
}

function expectedValue(world: WorldDefinition, value: unknown): string {
  if (typeof value === "string") {
    for (const collection of collections) {
      if ((world[collection] as Array<{ id: string }> | undefined)?.some(item => item.id === value)) return quote(entityName(world, value, collection));
    }
    return isOpaque(value) ? "the selected item" : quote(value);
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (value === null) return "empty";
  return Array.isArray(value) ? "the expected list" : "the expected saved data";
}

/** Presentation only: the server's saved checks and evidence remain authoritative. */
export function describeTaskCheck(check: StudioTaskCheck, world: WorldDefinition): string {
  if (check.kind === "validation") return check.mode === "full" ? "Check the card for broken references and invalid settings." : "Check the card’s structure.";
  const field = check.kind === "file" ? "code" : check.field;
  const fieldLabel = field ? fields[field] || humanize(field) : "";
  const name = check.kind === "entity" ? quote(entityName(world, check.id, check.collection))
    : check.kind === "file" ? `${quote(check.id)} file` : "The card";
  const subject = `${name}${fieldLabel ? ` · ${fieldLabel}` : ""}`;
  const value = expectedValue(world, check.value);
  switch (check.operator) {
    case "exists": return `${subject} should be present.`;
    case "absent": return `${subject} should be removed.`;
    case "eq": return `${subject} should be ${value}.`;
    case "contains": return `${subject} should include ${value}.`;
    case "not_contains": return `${subject} should no longer include ${value}.`;
    case "gte": return `${subject} should be at least ${value}.`;
    case "length_gte": {
      const count = typeof check.value === "number" ? check.value : value;
      const plural = count === 1 ? "" : "s";
      const units: Record<string, string> = { events: "event", entries: "entry", variables: "variable", rules: "rule", reactions: "reaction", chapters: "chapter", routes: "route", endings: "ending", files: "file" };
      const unit = field && units[field];
      if (unit) return `${name} should have at least ${count} ${unit === "entry" && count !== 1 ? "entries" : unit + plural}.`;
      const textField = check.kind === "file" || ["content", "description", "systemPrompt", "authorNote", "firstMessage"].includes(field ?? "");
      return `${subject} should have at least ${count} ${textField ? `character${plural}` : `item${plural}`}.`;
    }
  }
}

export function taskCheckPassed(evidence: string | undefined): boolean | null {
  if (!evidence) return null;
  if (/^Passed:|^(?:structure|full) validation passed\.$/i.test(evidence)) return true;
  if (/^Unmet:|^Validation:/i.test(evidence)) return false;
  return null;
}
