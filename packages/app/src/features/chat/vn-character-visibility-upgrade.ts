const importLine = 'import { useMetCharacters, visibleCharacterStatus } from "./character-visibility";';
const hook = '  const metCharacterIds = useMetCharacters(sceneApi, currentMessage, readLines, panel === "status");';
const sheetSignature = 'export function StatusSheet({ api, onClose, onBack, preview = false })';
const sheetLayout = '<StatusLayout config={statusConfig} variables={api.variables} preview={preview} />';
const filteredSignature = 'export function StatusSheet({ api, onClose, onBack, preview = false, filterCharacters })';
const filteredLayout = '<StatusLayout config={!preview && filterCharacters ? filterCharacters(statusConfig) : statusConfig} variables={api.variables} preview={preview} />';

/** Retain explicit silent entrances as stage metadata, without changing the
 * narrator label or treating ordinary name mentions as a cast declaration. */
function stagePresence(files: Record<string, string>, prefix: string): Record<string, string> {
  const passage = prefix + 'passages.ts', sprites = prefix + 'sprites.ts';
  const anchor = '          ...(isPlayer ? { player: true } : {}),\n';
  const presence = '          ...(!spoken && declared && chunk.explicit && span.kind !== "literal" ? { stageName: displayCharacterName(declared.name) } : {}),\n';
  let updated = files;
  const passageSource = files[passage];
  if (passageSource?.includes(anchor) && passageSource.includes('const declared = character(entries, chunk.name);') && !passageSource.includes('stageName:')) {
    updated = { ...updated, [passage]: passageSource.replace(anchor, anchor + presence) };
  }
  const spriteSource = files[sprites];
  const before = '    if (!line.name) continue;\n    const key = spriteKey(line);';
  if (spriteSource?.includes(before) && spriteSource.includes('cast.set(key, { name: line.name, emotion: line.emotion,')) {
    updated = { ...updated, [sprites]: spriteSource.replace(before, '    const name = line.name || line.stageName;\n    if (!name) continue;\n    const key = spriteKey({ ...line, name });')
      .replace('cast.set(key, { name: line.name, emotion: line.emotion,', 'cast.set(key, { name, emotion: line.emotion,') };
  }
  return updated;
}

/** Add encounter visibility at the shipped sheet boundary. Never replace a
 * creator's layout, config, widgets, assets, variables, or custom tap handler. */
export function upgradeVnCharacterVisibilityFiles(files: Record<string, string>, visibilitySource: string): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith('.tsx') || !source.includes('className="vn-stage"') || !source.includes('const readLines =')
      || !source.includes('const currentMessage =') || !source.includes('<StatusSheet api={sceneApi}')) continue;
    const prefix = name.slice(0, name.lastIndexOf('/') + 1);
    if (source.includes('filterCharacters=')) {
      if (source.includes(hook)) updated = stagePresence(updated, prefix);
      continue;
    }
    const helper = prefix + 'character-visibility.ts', sheet = prefix + 'status-sheet.tsx';
    if (files[helper] !== undefined && files[helper] !== visibilitySource) continue;
    const sheetSource = files[sheet];
    const shippedSheet = sheetSource?.includes(sheetSignature) && sheetSource.includes(sheetLayout);
    const filterAwareSheet = sheetSource?.includes(filteredSignature) && sheetSource.includes(filteredLayout);
    if ((!shippedSheet && !filterAwareSheet) || !source.includes('  function advance() {') || source.includes('const metCharacterIds =')) continue;
    const next = (source.includes(importLine) ? '' : importLine + '\n') + source
      .replace('  function advance() {', hook + '\n\n  function advance() {')
      .replace('<StatusSheet api={sceneApi}', '<StatusSheet api={sceneApi} filterCharacters={config => visibleCharacterStatus(config, sceneApi.entries, metCharacterIds)}');
    if (updated === files) updated = { ...files };
    updated[name] = next;
    updated[helper] = visibilitySource;
    updated[sheet] = sheetSource.replace(sheetSignature, filteredSignature).replace(sheetLayout, filteredLayout);
    updated = stagePresence(updated, prefix);
  }
  return updated;
}
