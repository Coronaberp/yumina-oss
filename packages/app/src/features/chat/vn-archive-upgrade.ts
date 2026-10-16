const inertExport = 'onClick={event => event.stopPropagation()}><Icons.Download /><span>Export</span></button>';
const activeExport = 'aria-haspopup="dialog" disabled={!api.sessionId || api.readOnly || api.isStreaming} onClick={() => { onClose(); api.openSessionExport(); }}><Icons.Download /><span>Export</span></button>';
const turnFilter = '<label className="vn-log-turn-filter">Turn<select aria-label="Filter by turn" value={turn} onChange={event => setTurn(event.target.value)}>';
const turnPicker = '<div className="vn-log-turn-filter"><span>Turn</span><TurnPicker value={turn} onChange={setTurn} replies={replies} currentTurnId={currentTurnId} pending={rows.some(row => row.turnId === "pending")} /></div>';

/** Upgrade recognizable shipped controls, retaining all authored story/UI files. */
export function upgradeVnArchiveFiles(files: Record<string, string>, pickerSource: string): Record<string, string> {
  let updated = files;
  for (const [name, original] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !original.includes('className="vn"') || !original.includes('className="vn-menu-list"')) continue;
    let source = original.replace(inertExport, activeExport);
    if (!source.includes("vn-menu-export")) {
      const start = source.indexOf('<nav className="vn-menu-list"');
      const end = source.indexOf("</nav>", start);
      if (end < 0 || !source.includes("function Menu({ api,") && !source.includes("function Menu({api,")) throw new Error("The saved menu needs review before adding Export.");
      source = source.slice(0, end) + '<button type="button" className="vn-menu-item vn-menu-export" ' + activeExport + '\n        ' + source.slice(end);
    }
    const start = source.indexOf(turnFilter);
    if (start >= 0) {
      const end = source.indexOf("</select></label>", start);
      if (end < 0) throw new Error("The saved Turn filter needs review before upgrading.");
      source = source.slice(0, start) + turnPicker + source.slice(end + "</select></label>".length);
    }
    if (source.includes("<TurnPicker") && !source.includes('from "./turn-picker"')) source = 'import { TurnPicker } from "./turn-picker";\n' + source;
    if (source !== original || source.includes("<TurnPicker") && files["turn-picker.tsx"] !== pickerSource) {
      if (updated === files) updated = { ...files };
      updated[name] = source;
      updated["turn-picker.tsx"] = pickerSource;
    }
  }
  return updated;
}
