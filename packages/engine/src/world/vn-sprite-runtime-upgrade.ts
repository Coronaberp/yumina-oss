import { spriteRuntimeBases } from './sprite-runtime-upgrade-bases.generated.js';
import { spriteRuntimeVariantsBase as spriteRuntimeTemplates } from './sprite-runtime-variants-base.generated.js';
import { spriteVariantRuntimePatches } from './sprite-runtime-variant-patches.generated.js';

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error('Invalid sprite runtime template anchors');
  return source.slice(from, to);
}

/** Exact source edits only. Unknown custom feature code requires a reviewed patch. */
function patch(source: string, old: string, current: string, file: string): string {
  if (source.includes(current)) return source;
  if (!old || source.split(old).length !== 2) throw new Error(`${file} has custom sprite code near ${JSON.stringify(old.slice(0, 80))}; review this feature fragment before upgrading`);
  return source.replace(old, () => current);
}

const previousSpriteCatalog = "export function spriteCatalogFor(api) {\n  let config = api.variables?.[\"vn-sprite-config\"] || spriteConfig;\n  try { if (typeof config === \"string\") config = JSON.parse(config); } catch { config = spriteConfig; }\n  return { types: { normal: \"Normal\", ...config?.types }, emotions: { ...spriteConfig.emotions, ...config?.emotions } };\n}";

/** Upgrade the sprite feature without rebuilding any card file from a template.
 * All edits are atomic: any unknown fragment throws before callers receive files.
 * Unrelated card code, literals, NPC/persona selection and custom UI stay byte-identical. */
function upgradeLegacySpriteFiles(input: Record<string, string>): Record<string, string> {
  if (!input['sprites.ts'] || !input['passages.ts']) return input;
  const files = { ...input };
  const edit = (file: string, old: string, current: string) => {
    if (files[file]) files[file] = patch(files[file]!, old, current, file);
  };
  const change = (file: string, start: string, end: string, currentStart = start) => edit(file,
    between(spriteRuntimeBases[file]!,start,end), between(spriteRuntimeTemplates[file]!,currentStart,end));
  edit('sprites.ts', 'import { normalizeSpriteExpression } from "./expressions";', 'import { normalizeSpriteExpression, normalizeSpriteId } from "./expressions";');
  const spriteSource = spriteRuntimeTemplates['sprites.ts']!;
  const anchor = '/** Uploaded cutouts take precedence over the selected defaults for their gender. */';
  const config = between(spriteSource,'/** Card-wide labels.', '/** Additional wardrobes:');
  const types = between(spriteSource,'/** Additional wardrobes:', '/** Character wardrobe descriptions:');
  const wardrobe = between(spriteSource,'/** Character wardrobe descriptions:', 'export function spriteSetsFor');
  const helpers = between(spriteSource,'export function spriteSetsFor',anchor);
  const declarations = (files['sprites.ts']!.match(/export const spriteConfig\s*=/) ? '' : config)
    + (files['sprites.ts']!.match(/export const spriteTypes\s*=/) ? '' : types)
    + (files['sprites.ts']!.match(/export const spriteWardrobeDescriptions\s*=/) ? '' : wardrobe)
    + (files['sprites.ts']!.includes('export function spriteSetsFor') ? '' : helpers);
  if (declarations) edit('sprites.ts',anchor,declarations+anchor);
  // Only the shipped helper is replaceable; preserve data literals and reject custom implementations.
  const currentCatalog = between(spriteSource, 'export function spriteCatalogFor', '\nfunction characterExpressions').trimEnd();
  if (files['sprites.ts']!.split('export function spriteCatalogFor').length !== 2) {
    throw new Error('sprites.ts has ambiguous spriteCatalogFor declarations; review before upgrading');
  }
  const sourceCatalog = between(files['sprites.ts']!, 'export function spriteCatalogFor', '\nfunction characterExpressions').trimEnd();
  if (sourceCatalog !== currentCatalog && sourceCatalog !== previousSpriteCatalog) {
    throw new Error('sprites.ts has custom spriteCatalogFor code; review this feature fragment before upgrading');
  }
  edit('sprites.ts', previousSpriteCatalog, currentCatalog);
  change('sprites.ts','  let map = api.variables?.["vn-sprites"] || sprites;', '\n}\n\nexport function spriteFor', '  const sets = spriteSetsFor(api);');
  edit('sprites.ts', 'name, emotion: line.emotion, ...(line.player', 'name, emotion: line.emotion, spriteType: line.spriteType, ...(line.player');
  change('sprites.ts','.map(({ name, emotion, src, key, defaultMode, player })', '\n}', '.map(({ name, emotion, spriteType, src, key, defaultMode, player })');
  const oldExpression = spriteRuntimeBases['expressions.ts']!.slice(spriteRuntimeBases['expressions.ts']!.indexOf('/** Normalize complete labels,')).trimEnd();
  const currentExpression = spriteRuntimeTemplates['expressions.ts']!.slice(spriteRuntimeTemplates['expressions.ts']!.indexOf('/** Stable marker/catalog ID;')).trimEnd();
  edit('expressions.ts', files['expressions.ts']?.includes(oldExpression) ? oldExpression : oldExpression.replace('expressionMap[key]!', 'expressionMap[key]'), currentExpression);
  // The new normalizer also needs its raw ID helper immediately before it.
  if (files['expressions.ts'] && !files['expressions.ts'].includes('export function normalizeSpriteId')) {
    const start = '/** Resolve exact configured IDs';
    const helper = between(spriteRuntimeTemplates['expressions.ts']!, '/** Stable marker/catalog ID;',start);
    edit('expressions.ts',start,helper+start);
  }
  if (files['presentation-markup.ts']?.includes('function expression(value = "normal")')) {
    const old = `function expression(value = "normal") {
  value = value.trim().toLowerCase();
  return /^(normal|happy|sad|angry|shy|smug)$/.test(value) ? value : expressionAliases[value] || "normal";
}`;
    edit('presentation-markup.ts', old, `function expression(value = "normal") { return normalizeSpriteId(value); }`);
    if (!files['presentation-markup.ts']!.includes('import { normalizeSpriteId }')) files['presentation-markup.ts'] = 'import { normalizeSpriteId } from "./expressions";\n' + files['presentation-markup.ts'];
  } else if (!files['presentation-markup.ts']?.includes('import { normalizeSpriteId }')) {
    change('presentation-markup.ts', 'import { ', '\nimport { canonicalCharacterName');
  }
  change('presentation-markup.ts', '    const emotion = ', '\n  });');
  change('presentation-markup.ts', '    return `[SPEAKER:${name}:${emotion}', '\n  });\n}', '    const spriteType = name !==');
  if (!files['passages.ts']!.includes('import { normalizeSpriteId } from "./expressions";')) edit('passages.ts','import { normalizeSpriteExpression } from "./expressions";', 'import { normalizeSpriteExpression, normalizeSpriteId } from "./expressions";');
  if (files['passages.ts']!.includes('      const markup = ')) {
    change('passages.ts','      const markup = ', '\n      return passages(api.entries, markup', '      const spriteType = name !==');
  } else {
    edit('passages.ts',
      '      return passages(api.entries, `[SPEAKER:${name}:${normalizeSpriteExpression(segment.emotion)}${metadata}] ${segment.text}`);',
      '      const spriteType = name !== "NPC" && name !== "Narrator" ? `:${normalizeSpriteId(segment.spriteType)}` : "";\n      return passages(api.entries, `[SPEAKER:${name}:${normalizeSpriteId(segment.emotion)}${metadata || spriteType}] ${segment.text}`);');
  }
  if (files['passages.ts']!.includes('const initialFields = ')) edit('passages.ts', 'emotion = normalizeSpriteExpression(initialFields[0])', 'emotion = normalizeSpriteId(initialFields[0])');
  edit('passages.ts', 'emotion = normalizeSpriteExpression(fields[0])', 'emotion = normalizeSpriteId(fields[0])');
  if (files['passages.ts']!.includes('const initialFields = ')) {
    edit('passages.ts', '  let npcId = npcGender ?', '  let spriteType = name.toLowerCase() !== "npc" && name.toLowerCase() !== "narrator" ? normalizeSpriteId(initialFields[1]) : "normal";\n  let npcId = npcGender ?');
  } else {
    edit('passages.ts', '  const chunks = [];', '  let spriteType = "normal";\n  const chunks = [];');
  }
  files['passages.ts'] = files['passages.ts']!.replaceAll('name, emotion, scene, explicit, npcGender, npcId', 'name, emotion, spriteType, scene, explicit, npcGender, npcId');
  edit('passages.ts', '      emotion = normalizeSpriteId(fields[0]); explicit = true;', '      emotion = normalizeSpriteId(fields[0]); explicit = true;\n      spriteType = name.toLowerCase() !== "npc" && name.toLowerCase() !== "narrator" ? normalizeSpriteId(fields[1]) : "normal";');
  edit('passages.ts', 'emotion: chunk.emotion, scene: chunk.scene', 'emotion: chunk.emotion, spriteType: chunk.spriteType, scene: chunk.scene');
  edit('character-viewer.tsx', 'import { sprites } from "./sprites";\nimport { spriteExpressions } from "./expressions";', 'import { spriteSetsFor, spriteCatalogFor } from "./sprites";');
  change('character-viewer.tsx','  let map = api.variables?.["vn-sprites"] || sprites;', '\n}\n\nexport function characterStats', '  const sets = spriteSetsFor(api), config = spriteCatalogFor(api);');
  edit('character-viewer.tsx', 'evidence, images: expressionSprites(live.current, target), stats:', 'evidence, images: expressionSprites(live.current, target), spriteTypes: spriteCatalogFor(live.current).types, stats:');
  if (!files['character-viewer.tsx']?.includes('return { viewer, open, close, retry };')) edit('character-viewer.tsx', 'images: expressionSprites(api, viewer.target) } : null', 'images: expressionSprites(api, viewer.target), spriteTypes: spriteCatalogFor(api).types } : null');
  edit('character-viewer.tsx', '  const [expression, setExpression] = React.useState(0),', '  const [spriteType, setSpriteType] = React.useState("normal"), [expression, setExpression] = React.useState(0),');
  change('character-viewer.tsx','  const image = ', '\n  const stats = ', '  const types = ');
  change('character-viewer.tsx','          {viewer.images.length > 1 && ', '\n        </div>', '          {types.length > 1 && ');
  return Object.keys(files).some(file=>files[file]!==input[file]) ? files : input;
}


function occurrences(source: string, fragment: string): number {
  return fragment ? source.split(fragment).length - 1 : 0;
}
function regexEscape(value: string): string { return value.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&'); }

/** Reviewed legacy parser preserves rendering, paging
 * and imports. Only carry the optional outfit fields through its existing path. */
function upgradeReviewedPassages(source: string): string {
  const edit = (before: string, after: string, count = 1) => {
    const oldCount = occurrences(source, before), newCount = occurrences(source, after);
    if (newCount === count && oldCount === occurrences(after, before) * count) return;
    if (oldCount !== count || newCount !== occurrences(before, after) * count) throw new Error('passages.ts has custom sprite code in reviewed legacy parser; review before upgrading');
    source = source.split(before).join(after);
  };
  if (source.includes('import { normalizeSpriteExpression, normalizeSpriteId')) {
    edit('import { normalizeSpriteExpression, normalizeSpriteId } from "./expressions";', 'import { normalizeSpriteExpression, normalizeSpriteId, normalizeSpriteSelectionId } from "./expressions";');
  } else {
    edit('import { normalizeSpriteId } from "./expressions";', 'import { normalizeSpriteId, normalizeSpriteSelectionId } from "./expressions";');
  }
  if (source.includes('initialFields')) {
    edit('  let spriteType = name.toLowerCase() !== "npc" && name.toLowerCase() !== "narrator" ? normalizeSpriteId(initialFields[1]) : "normal";', '  let spriteType = name.toLowerCase() !== "npc" && name.toLowerCase() !== "narrator" && initialFields[1] ? normalizeSpriteId(initialFields[1]) : undefined;\n  let spriteVariant = spriteType && initialFields[2] ? normalizeSpriteId(initialFields[2]) : undefined;');
  } else {
    edit('  let spriteType = "normal";', '  let spriteType, spriteVariant;');
  }
  edit('name, emotion, spriteType, scene, explicit, npcGender, npcId', 'name, emotion, spriteType, spriteVariant, scene, explicit, npcGender, npcId', 2);
  edit('      spriteType = name.toLowerCase() !== "npc" && name.toLowerCase() !== "narrator" ? normalizeSpriteId(fields[1]) : "normal";',
    '      spriteType = name.toLowerCase() !== "npc" && name.toLowerCase() !== "narrator" && fields[1] ? normalizeSpriteId(fields[1]) : undefined;\n      spriteVariant = spriteType && fields[2] ? normalizeSpriteId(fields[2]) : undefined;');
  edit('emotion: chunk.emotion, spriteType: chunk.spriteType, scene: chunk.scene', 'emotion: chunk.emotion, spriteType: chunk.spriteType, spriteVariant: chunk.spriteVariant, scene: chunk.scene');
  edit('      const spriteType = name !== "NPC" && name !== "Narrator" ? `:${normalizeSpriteId(segment.spriteType)}` : "";',
    '      const typeId = normalizeSpriteSelectionId(segment.spriteType);\n      const variantId = segment.spriteVariant == null || segment.spriteVariant === "" ? "" : normalizeSpriteSelectionId(segment.spriteVariant);\n      const spriteType = name !== "NPC" && name !== "Narrator" && typeId && variantId !== undefined\n        ? `:${typeId}${variantId ? `:${variantId}` : ""}` : "";');
  return source;
}

/** Apply immutable prevariant-to-variant edits without replacing authored files. */
function upgradeVariantSpriteFiles(input: Record<string, string>): Record<string, string> {
  const files = { ...input };
  for (const change of spriteVariantRuntimePatches) {
    if (change.file === 'passages.ts') {
      if (change.declaration === 'import:./expressions') files['passages.ts'] = upgradeReviewedPassages(files['passages.ts']!);
      continue;
    }
    const source = files[change.file];
    if (source === undefined) continue;
    // An unrelated custom entry need not use our scene sprite renderer.
    if (change.file === 'index.tsx' && !/\bsceneSprites\s*\(/.test(source)) continue;
    if (change.append) {
      if (occurrences(source, change.after) === 1) continue;
      const declared = change.declaration.startsWith('import:')
        ? new RegExp('(?:from\\s*|import\\s*)["\x27]' + regexEscape(change.declaration.slice(7)) + '["\x27]').test(source)
        : new RegExp('\\b(?:const|let|var|function|class)\\s+' + regexEscape(change.declaration) + '\\b').test(source);
      // Existing authored data may differ from the empty shipped declaration.
      if (declared && change.data) continue;
      if (declared || occurrences(source, change.after) > 1) throw new Error(change.file + ' has custom sprite declaration ' + change.declaration + '; review before upgrading');
      files[change.file] = source + '\n' + change.after + '\n';
      continue;
    }
    if (change.file === 'presentation-markup.ts' && change.declaration === 'import:./expressions' && source.includes('function expression(value = "normal") { return normalizeSpriteId(value); }')) {
      const before = 'import { normalizeSpriteId } from "./expressions";', after = 'import { normalizeSpriteId, normalizeSpriteSelectionId } from "./expressions";';
      if (occurrences(source, after) === 1) continue;
      if (occurrences(source, before) === 1) { files[change.file] = source.replace(before, after); continue; }
    }
    if (change.file === 'character-viewer.tsx' && change.declaration === 'useCharacterViewer' && change.before.includes('spriteCatalogFor(api)') && source.includes('  return { viewer, open, close, retry };')) continue;
    if (change.file === 'index.tsx' && source.includes('const currentMessage = replies[turnIndex];')) {
      const before = 'sceneSprites(sceneApi, readLines, spriteLimit)', after = 'sceneSprites(sceneApi, readLines, spriteLimit, currentMessage)';
      if (occurrences(source, after) === 1) continue;
      if (occurrences(source, before) === 1) { files[change.file] = source.replace(before, after); continue; }
    }
    if (change.file === 'sprites.ts' && change.declaration === 'sceneSprites' && change.before.includes('cast.set(key')) {
      const before = change.before.replace('name, emotion:', 'name: line.name, emotion:');
      const after = '    const name = line.name;\n' + change.after;
      if (occurrences(source, after) === 1) continue;
      if (occurrences(source, before) === 1) { files[change.file] = source.replace(before, after); continue; }
    }
    const beforeCount = occurrences(source, change.before), afterCount = occurrences(source, change.after);
    if (afterCount === 1 && beforeCount === occurrences(change.after, change.before)) continue;
    if (beforeCount !== 1 || afterCount !== occurrences(change.before, change.after)) throw new Error(change.file + ' has custom sprite code in ' + change.declaration + '; review this feature fragment before upgrading');
    files[change.file] = source.replace(change.before, () => change.after);
  }
  return Object.keys(files).some(file => files[file] !== input[file]) ? files : input;
}

/** Legacy -> captured prevariant runtime -> optional variants. Each stage works
 * on a private copy. Unknown edited feature fragments reject the entire update. */
export function upgradeVnSpriteFiles(input: Record<string, string>): Record<string, string> {
  if (!input['sprites.ts'] || !input['passages.ts']) return input;
  try { return upgradeVariantSpriteFiles(input); }
  catch (variantError) {
    try { return upgradeVariantSpriteFiles(upgradeLegacySpriteFiles(input)); }
    catch { throw variantError; }
  }
}
