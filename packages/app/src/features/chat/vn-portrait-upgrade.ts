const before = 'src={api.resolveAssetUrl(portrait)}';
const after = 'src={api.resolveAssetUrl(portraitRef(portrait))}';
const importLine = 'import { portraitRef } from "./portrait-ref";';
const oldRows = '}), [visible, characters, api.entries, api.user?.name, api.user?.avatar, api.renderMarkdown, api.resolveAssetUrl, openCharacter]);';
const refreshedRows = oldRows.replace('[visible', '[api, visible');

/** Only adapt the shipped small-avatar renderer, preserving all authored art. */
export function upgradeVnPortraitFiles(files: Record<string, string>, helper: string): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith('.tsx') || !source.includes('function Portrait({ api, assetRef, name, player, npcGender })')
      || !source.includes('className="vn-avatar"') || !source.includes(before) && !source.includes(after)) continue;
    const path = name.slice(0, name.lastIndexOf('/') + 1) + 'portrait-ref.ts';
    if (files[path] !== undefined && files[path] !== helper) continue;
    const next = (source.includes(importLine) ? '' : importLine + '\n') + source.replace(before, after).replace(oldRows, refreshedRows);
    if (next === source) continue;
    updated = { ...updated, [name]: next, [path]: helper };
  }
  return updated;
}
