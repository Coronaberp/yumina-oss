const menu = "function Menu({ api, onClose, setPanel, settings, onSetting, busy, run, onRestore })";
const menuWithReply = "function Menu({ api, currentMessage, onClose, setPanel, settings, onSetting, busy, run, onRestore })";
const modelRow = '            <div className="vn-setting"><button onClick={() => api.openModelPicker()}>Choose AI model</button></div>';
const modelDetails = '            <ModelRoutingDetails selectedModel={api.selectedModel} message={currentMessage} />';
const menuCall = '<Menu api={api} onClose=';
const menuCallWithReply = '<Menu api={api} currentMessage={currentMessage} onClose=';
const helperImport = 'import { ModelRoutingDetails } from "./model-routing-details";\n';

/** Add read-only model details to recognizable shipped Settings panels only.
 * Custom controls/helpers and partially upgraded layouts are author-owned. */
export function upgradeVnModelRoutingFiles(files: Record<string, string>, helperSource: string): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !source.includes('className="vn"') || !source.includes('className="vn-stage"')
      || !source.includes('import { styles } from "./styles";') || source.includes("ModelRoutingDetails")
      || ![menu, modelRow, menuCall].every(anchor => source.split(anchor).length === 2)) continue;
    const helper = name.slice(0, name.lastIndexOf("/") + 1) + "model-routing-details.tsx";
    if (files[helper] !== undefined && files[helper] !== helperSource) continue;
    if (updated === files) updated = { ...files };
    updated[name] = helperImport + source.replace(menu, menuWithReply).replace(modelRow, modelRow + "\n" + modelDetails).replace(menuCall, menuCallWithReply);
    updated[helper] = helperSource;
  }
  return updated;
}
