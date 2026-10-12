import type { NameGeneratorProfile } from "@yumina/shared";
import type { ChatMessage } from "../llm/types.js";

export function creatorSuppliedLiteral(value: string, messages: readonly ChatMessage[]): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
  return messages.some(message => message.role === "user" && pattern.test(typeof message.content === "string"
    ? message.content : message.content.map(part => "text" in part ? part.text : "").join("\n")));
}

function literals(input: Record<string, unknown>): Array<{ path: string; value: string }> {
  const result: Array<{ path: string; value: string }> = [];
  const add = (path: string, value: unknown) => { if (typeof value === "string" && value) result.push({ path, value }); };
  add("surname", input.surname); add("particle", input.particle);
  for (const field of ["constraints", "surnameConstraints"]) {
    const constraints = input[field];
    if (constraints && typeof constraints === "object") {
      add(`${field}.prefix`, (constraints as Record<string, unknown>).prefix);
      add(`${field}.suffix`, (constraints as Record<string, unknown>).suffix);
    }
  }
  const phonetics = input.phonetics;
  if (phonetics && typeof phonetics === "object") {
    const data = phonetics as Record<string, unknown>;
    const endings = data.endings && typeof data.endings === "object" ? data.endings as Record<string, unknown> : {};
    for (const [field, fragments] of Object.entries({ starts: data.starts, middles: data.middles, ...endings })) {
      if (Array.isArray(fragments)) for (const fragment of fragments) if (Array.isArray(fragment)) add(`phonetics.${field}`, fragment[0]);
    }
  }
  return result;
}

/** Model-authored literals cannot be laundered through a local tool result.
 * CLI/direct generator inputs are author input and do not use this Studio gate. */
export function assertNameInputsAuthored(input: Record<string, unknown>, messages: readonly ChatMessage[], profiles: readonly NameGeneratorProfile[]): void {
  const allowed = new Set(profiles.flatMap(profile => literals(profile as unknown as Record<string, unknown>).map(item => item.value.toLowerCase())));
  for (const item of literals(input)) {
    if (allowed.has(item.value.toLowerCase()) || creatorSuppliedLiteral(item.value, messages)) continue;
    throw new Error(`${item.path} must come from creator-supplied text or an existing naming profile. Use installed phonetic styles to generate names instead of inventing literal names or fragments.`);
  }
}
