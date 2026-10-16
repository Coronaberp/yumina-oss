import { isPresentationLiteral, maskPresentationLiterals, presentationLiteralRanges } from "./presentation-literals.js";

const ANGLE_VARIABLE = /<\s*([\w\p{L}\p{N}.$-]+):\s*(set|add|subtract|multiply|toggle|append|\+|-|\*)\s*("(?:[^"\\]|\\.)*"|[^<>\n"]+)?\s*>/giu;

function angleVariableId(id: string, declaredVariables: readonly string[]): string | undefined {
  const dot = id.indexOf("."), root = dot < 0 ? id : id.slice(0, dot);
  if (declaredVariables.includes(root)) return id;
  const matches = declaredVariables.filter(variable => variable.toLowerCase() === root.toLowerCase());
  // Case drift may identify one declared variable; ambiguous names stay prose.
  return matches.length === 1 ? matches[0]! + (dot < 0 ? "" : id.slice(dot)) : undefined;
}

function replaceAngleVariableDirectives(text: string, declaredVariables: readonly string[],
  replace: (id: string, op: string, value: string | undefined) => string): string {
  if (!declaredVariables.length || !text.includes("<")) return text;
  const literals = presentationLiteralRanges(text);
  return text.replace(ANGLE_VARIABLE, (source, id: string, op: string, value: string | undefined, index: number) => {
    const variableId = angleVariableId(id, declaredVariables);
    return variableId && !isPresentationLiteral(literals, index) ? replace(variableId, op.toLowerCase(), value?.trim()) : source;
  });
}

/** Models sometimes substitute angle brackets for the square-bracket protocol.
 * Adapt only declared state commands; quoted/code examples remain exact prose. */
export function normalizeAngleVariableDirectives(text: string, declaredVariables: readonly string[] = []): string {
  return replaceAngleVariableDirectives(text, declaredVariables, (id, op, value) => `[${id}: ${op}${value ? ` ${value}` : ""}]`);
}

/** Display cleanup for old saved replies as well as live streaming fragments.
 * This never applies state effects or changes the saved/raw message. */
export function stripAngleVariableDirectives(text: string, declaredVariables: readonly string[] = [], streaming = false): string {
  const clean = replaceAngleVariableDirectives(text, declaredVariables, () => "");
  if (!streaming) return clean;
  const literals = presentationLiteralRanges(clean);
  return clean.replace(/<\s*([\w\p{L}\p{N}.$-]+):[^<>\n]*$/u, (source, id: string, index: number) =>
    angleVariableId(id, declaredVariables) && !isPresentationLiteral(literals, index) ? "" : source);
}

/** State-command wrappers are metadata; keep their contents for parsing and
 * preserve authored code examples. A missing closing tag must not eat prose. */
export function stripVariableUpdateTags(text: string): string {
  const literals = maskPresentationLiterals(text);
  const stripped = literals.text
    .replace(/^[\t ]*<yield>\s*(?:choices\s+follow\.?)?\s*<\/yield>[\t ]*(?:\r?\n|$)/gim, "")
    .replace(/^[\t ]*(?:<\s*\/?\s*variable[-_]updates\s*>|\[\s*\/?\s*variable[-_]updates\s*\])[\t ]*\r?$/gim, "");
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
