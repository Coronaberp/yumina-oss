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
    const oldImport = 'import { stripGameStateDump } from "./metadata";';
    const newImport = 'import { stripGameStateDump, stripVariableUpdateTags } from "./metadata";';
    const imports = [oldImport, newImport].filter(statement => source.split(statement).length === 2);
    if (imports.length !== 1 || source.match(/from ["']\.\/metadata["']/g)?.length !== 1) continue;
    const metadata = updated[prefix + 'metadata.ts'];
    if (!metadata) continue;
    const hasVariableHelper = metadata.includes('export function stripVariableUpdateTags(text: string): string {');
    // Older snapshot-only metadata has no variable-tag helper to import.
    if (!hasVariableHelper && imports[0] === newImport) continue;
    const angleImport = 'import { stripAngleMarkup } from "./angle-markup";';
    const hasAngleImport = source.includes(angleImport);
    if (source.includes('import { stripAngleMarkup }') && !hasAngleImport) continue;
    const wrap = (value: string) => `standardizeSpeakerMarkup(${hasAngleImport ? 'stripAngleMarkup(' : ''}stripZeroWidthSpaces(${value})${hasAngleImport ? ')' : ''}, names)`;
    const values = ['content', 'rawContent'];
    const legacy = values.map(value => `${value} = ${wrap(value)};`);
    const angleFirst = values.map(value => `${value} = standardizeSpeakerMarkup(stripAngleMarkup(stripVariableUpdateTags(stripZeroWidthSpaces(${value}))), names);`);
    const snapshotCleanup = 'content = stripVariableUpdateTags(stripGameStateDump(extractResponseChoices(content).text));';
    // Recognize only the paired shipped cleanup, including its later snapshot
    // filter. A creator's replacement or partial transform is left untouched.
    const knownAngleFirst = hasVariableHelper && hasAngleImport && source.split(snapshotCleanup).length === 2;
    const before = [legacy, ...(knownAngleFirst ? [angleFirst] : [])]
      .find(anchors => anchors.every(anchor => source.split(anchor).length === 2));
    if (!before) continue;
    let next = source;
    for (const [index, value] of values.entries()) {
      const cleaned = `stripZeroWidthSpaces(${value})`;
      const variableCleaned = hasVariableHelper ? `stripVariableUpdateTags(${cleaned})` : cleaned;
      next = next.replace(before[index]!, `${value} = standardizeSpeakerMarkup(stripAngleMarkup(stripGameStateDump(${variableCleaned})), names);`);
    }
    if (hasVariableHelper) next = next.replace(oldImport, newImport);
    if (!hasAngleImport) next = angleImport + '\n' + next;
    if (next !== source) updated = { ...updated, [helper]: angleSource, [name]: next };
  }
  return updated;
}
