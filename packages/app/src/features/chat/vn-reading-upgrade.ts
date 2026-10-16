const previousAdvance = `  function advance() {
    if (hidden) { setHidden(false); return; }
    movePage(1);
  }`;
const readingAdvance = `  const scrollPassage = usePassageReading(view, turn, index, line?.text, pendingPlayerLine);

  function advance() {
    if (hidden) { setHidden(false); return; }
    if (panel || viewerOpen || error || !line) return;
    setAuto(false);
    if (scrollPassage()) return;
    movePage(1);
  }`;
const readingImport = 'import { usePassageReading } from "./reading";';

/** Upgrade the shipped tap handler on saved VN cards without replacing their
 * authored interface files, art mappings, status layouts or story data. */
export function upgradeVnReadingFiles(files: Record<string, string>, readingSource: string): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !source.includes('className="vn"') || !source.includes('className="vn-stage"')
      || !source.includes("const pendingPlayerLine =") || !source.includes("function movePage(direction)") || !source.includes(previousAdvance)) continue;
    const helper = name.slice(0, name.lastIndexOf("/") + 1) + "reading.ts";
    if (files[helper] !== undefined && files[helper] !== readingSource) continue;
    if (updated === files) updated = { ...files };
    updated[helper] = readingSource;
    updated[name] = (source.includes(readingImport) ? "" : readingImport + "\n") + source.replace(previousAdvance, readingAdvance);
  }
  return updated;
}
