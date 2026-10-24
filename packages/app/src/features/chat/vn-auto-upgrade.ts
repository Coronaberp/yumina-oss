const stockTransforms: Array<[string, string]> = [
  [
    "  React.useEffect(() => {\n    if (!auto || panel || viewerOpen || hidden || end || waiting || api.isStreaming) return;\n    const timer = setTimeout(() => setCursor({ turn, index: index + 1 }), Math.max(autoDelay, (line?.text.length || 0) * 35));\n    return () => clearTimeout(timer);\n  }, [auto, panel, viewerOpen, hidden, end, waiting, api.isStreaming, turn, index, autoDelay, line?.text]);",
    "  useAutoReading({\n    active: auto, paused: !!panel || viewerOpen || hidden || !hydrated,\n    halted: end || waiting || api.isStreaming || !!error || !line,\n    pageKey: `${api.sessionId}:${turn}:${index}:${pendingPlayerSprite?.id || \"\"}`,\n    text: line?.text || \"\", pace: autoDelay, view, scrollPassage,\n    onAdvance: () => movePage(1, false), onStop: () => setAuto(false),\n  });"
  ],
  [
    "  function movePage(direction) {\n    if (panel || viewerOpen || error || !line) return;\n    setAuto(false);",
    "  function movePage(direction, manual = true) {\n    if (panel || viewerOpen || error || !line) return;\n    if (manual) setAuto(false);"
  ],
  [
    "      const text = event.target.closest(\".vn-text\");\n      if (text && text.scrollHeight",
    "      setAuto(false);\n      const text = event.target.closest(\".vn-text\");\n      if (text && text.scrollHeight"
  ],
  [
    "onClick={() => setAuto(!auto)}",
    "onClick={() => setAuto(current => !current)}"
  ]
];
const autoImport = 'import { useAutoReading } from "./auto-reading";';
const stockContext = [
  'className="vn"', 'className="vn-stage"',
  'const [auto, setAuto] = React.useState(false);',
  'const [autoDelay, setAutoDelay] = React.useState(4500);',
  'const [hydrated, setHydrated] = React.useState(false);',
  'const [pendingPlayerSprite, setPendingPlayerSprite] = React.useState(null);',
  'const scrollPassage = usePassageReading(view, turn, index, line?.text, pendingPlayerLine);',
  'const viewerOpen = !!characterViewer.viewer;',
];

/** Refresh only the exact shipped Auto contract. Authored handlers, helpers,
 * colors, layouts, scene maps and story data retain their original bytes. */
export function upgradeVnAutoFiles(files: Record<string, string>, autoSource: string): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !stockContext.every(anchor => source.includes(anchor))
      || !stockTransforms.every(([before]) => source.split(before).length === 2)) continue;
    const helper = name.slice(0, name.lastIndexOf("/") + 1) + "auto-reading.ts";
    if (files[helper] !== undefined && files[helper] !== autoSource) continue;
    let next = source;
    for (const [before, after] of stockTransforms) next = next.replace(before, after);
    if (!next.includes(autoImport)) next = autoImport + "\n" + next;
    if (updated === files) updated = { ...files };
    updated[helper] = autoSource;
    updated[name] = next;
  }
  return updated;
}
