const previous = '  const stripped = literals.text.replace(';
const filtered = String.raw`  const stripped = literals.text
    .replace(/^[\t ]*<yield>\s*(?:choices\s+follow\.?)?\s*<\/yield>[\t ]*(?:\r?\n|$)/gim, "")
    .replace(`;

/** Hide known handoff metadata in old saved VN layouts and their greetings. */
export function upgradeVnMetadataFiles(files: Record<string, string>, angleSource?: string): Record<string, string> {
  if (!Object.values(files).some(source => source.includes('className="vn-stage"'))) return files;
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!/(?:^|\/)metadata\.ts$/.test(name) || !source.includes('export function stripVariableUpdateTags(text: string): string {')
      || !source.includes('variable[-_]updates') || !source.includes(previous)) continue;
    updated = { ...updated, [name]: source.replace(previous, filtered) };
  }
  if (angleSource) for (const [name, source] of Object.entries(updated)) {
    if (!/(?:^|\/)passages\.ts$/.test(name) || !source.includes('export function passages(entries, content, rawContent = content, player = null)')) continue;
    const prefix = name.slice(0, name.lastIndexOf('/') + 1);
    if (!updated[prefix + 'presentation-literals.ts']) continue;
    const helper = prefix + 'angle-markup.ts';
    if (updated[helper] !== undefined && updated[helper] !== angleSource) continue;
    if (source.includes('import { stripAngleMarkup }')) {
      const next = source
        .replace('standardizeSpeakerMarkup(stripAngleMarkup(stripZeroWidthSpaces(content)), names)', 'standardizeSpeakerMarkup(stripAngleMarkup(stripVariableUpdateTags(stripZeroWidthSpaces(content))), names)')
        .replace('standardizeSpeakerMarkup(stripAngleMarkup(stripZeroWidthSpaces(rawContent)), names)', 'standardizeSpeakerMarkup(stripAngleMarkup(stripVariableUpdateTags(stripZeroWidthSpaces(rawContent))), names)');
      if (next !== source) updated = { ...updated, [name]: next };
      continue;
    }
    const content = 'content = standardizeSpeakerMarkup(stripZeroWidthSpaces(content), names);';
    const raw = 'rawContent = standardizeSpeakerMarkup(stripZeroWidthSpaces(rawContent), names);';
    if (!source.includes(content) || !source.includes(raw)) continue;
    updated = { ...updated, [helper]: angleSource, [name]: 'import { stripAngleMarkup } from "./angle-markup";\n' + source
      .replace(content, 'content = standardizeSpeakerMarkup(stripAngleMarkup(stripVariableUpdateTags(stripZeroWidthSpaces(content))), names);')
      .replace(raw, 'rawContent = standardizeSpeakerMarkup(stripAngleMarkup(stripVariableUpdateTags(stripZeroWidthSpaces(rawContent))), names);') };
  }
  return updated;
}
