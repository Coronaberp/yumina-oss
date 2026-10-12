import { maskPresentationLiterals } from "./presentation-literals";

/** State-command wrappers are metadata; keep their contents for parsing and
 * preserve authored code examples. A missing closing tag must not eat prose. */
export function stripVariableUpdateTags(text: string): string {
  const literals = maskPresentationLiterals(text);
  const stripped = literals.text.replace(/^[\t ]*<\/?variable-updates[\t ]*>[\t ]*$/gim, "");
  return stripped === literals.text ? text : literals.restore(stripped).trimEnd();
}

/** Hide model-emitted state snapshots from prose without interpreting them as writes. */
export function stripGameStateDump(text: string): string {
  const literals = maskPresentationLiterals(text);
  // Models sometimes mix a bracket opener with an XML closer. Both are
  // reserved metadata wrappers; the original response remains available as raw.
  return literals.restore(literals.text.replace(
    /^[\t ]*(?:\[\s*game[-_]state\s*\]|<game[-_]state\s*>)[\t ]*\r?\n[\s\S]*?^[\t ]*(?:\[\s*\/game[-_]state\s*\]|<\/game[-_]state\s*>)[\t ]*$/gim,
    "",
  ));
}
