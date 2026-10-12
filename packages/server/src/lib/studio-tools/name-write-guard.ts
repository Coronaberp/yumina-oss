import type { WorldDefinition } from "@yumina/engine";
import type { ChatMessage } from "../llm/types.js";
import type { SchemaChange } from "./tool-executor.js";
import { creatorSuppliedLiteral } from "./name-authorship.js";

/** Preserve authored names, but require generated new character names to come
 * from the actual registry rather than accepting an LLM's replacement. */
export function characterNameError(change: SchemaChange, world: WorldDefinition, messages: readonly ChatMessage[], generatedNames: readonly string[]): string | undefined {
  if (change.entityType !== "entry" || typeof change.data?.name !== "string") return;
  const existing = world.entries.find(entry => entry.id === change.id);
  if ((change.data.role ?? existing?.role) !== "character" || existing?.name === change.data.name) return;
  const name = change.data.name;
  if (creatorSuppliedLiteral(name, messages) || generatedNames.includes(name)) return;
  return `Character name '${name}' was not supplied by the creator or returned by generate_names. Call generate_names and use an exact result; do not invent or alter it.`;
}
