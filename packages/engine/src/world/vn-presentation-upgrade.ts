import { preserveVnAssetConfiguration } from './vn-assets.js';

/** Refresh shipped VN helpers without dropping card-specific configuration. */
export function mergeVnPresentationFiles(saved: Record<string, string>, template: Record<string, string>): Record<string, string> {
  const files = { ...saved, ...template };
  for (const [file, kind] of [['sprites.ts', 'sprites'], ['scenes.ts', 'backgrounds']] as const) {
    if (saved[file] === undefined || template[file] === undefined) continue;
    try { files[file] = preserveVnAssetConfiguration(saved[file], template[file], kind); }
    catch (error) { throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)} Refusing to overwrite the card.`); }
  }
  // These files are creator-owned settings/layouts rather than shipped loaders.
  for (const file of ['status-config.ts', 'status-layout.tsx', 'character-showcase.ts', 'portraits.ts']) {
    if (saved[file] !== undefined) files[file] = saved[file];
  }
  return files;
}
