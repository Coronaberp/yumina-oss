import { ThinkingTagFilter, extractResponseChoices, stripGameStateDump } from "@yumina/engine";

/** Older engine replies collapse horizontal whitespace. Recover only leading
 * whitespace from matching source lines; displayed words and line breaks
 * always come from the already-filtered content, never the provider's prose. */
export function restoreChatMarkdownIndentation(display: string, raw: string): string {
  if (!raw || display === raw) return display;
  const source = stripGameStateDump(extractResponseChoices(ThinkingTagFilter.strip(raw)).text);
  const signature = (line: string) => line.trim().replace(/[\t ]+/g, " ");
  const prefixes = new Map<string, { lines: Array<{ index: number; indent: string }>; next: number }>();
  source.split("\n").forEach((line, index) => {
    const key = signature(line);
    if (!key) return;
    const bucket = prefixes.get(key) ?? { lines: [], next: 0 };
    bucket.lines.push({ index, indent: /^[\t ]*/.exec(line)![0] });
    prefixes.set(key, bucket);
  });
  let cursor = 0;
  return display.split("\n").map(line => {
    const bucket = prefixes.get(signature(line));
    if (!bucket) return line;
    while (bucket.next < bucket.lines.length && bucket.lines[bucket.next]!.index < cursor) bucket.next++;
    const original = bucket.lines[bucket.next++];
    if (!original) return line;
    cursor = original.index + 1;
    const indent = /^[\t ]*/.exec(line)![0];
    if (indent.length > 1 || indent.includes("\t")) return line;
    return original.indent.replace(/\t/g, "    ").length > indent.length ? original.indent + line.slice(indent.length) : line;
  }).join("\n");
}
