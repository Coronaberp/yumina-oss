import type { RootComponent, Variable } from "@yumina/engine";
import { normalizeStatusConfig, type StatusConfig, type StatusField } from "../../../../../../interfaces/vn/status-data";
import { upgradeStatusFiles, installStatusLayoutFiles } from "@yumina/engine";
export { upgradeStatusFiles } from "@yumina/engine";

export const STATUS_CONFIG_FILE = "status-config.ts";
export const STATUS_LAYOUT_FILE = "status-layout.tsx";

/** Preview the same saved layout and frame as play, inside the existing sandbox. */
export function buildStatusPreviewFiles(root: RootComponent, config: StatusConfig, templates: Record<string, string>): { entryFile: string; files: Record<string, string> } {
  const files = installStatusLayoutFiles(upgradeStatusFiles({ ...templates, ...root.files }, templates), templates);
  const entryFile = "__status-preview.tsx";
  return { entryFile, files: { ...files, [STATUS_CONFIG_FILE]: writeStatusConfig(config), [entryFile]: `
import { StatusSheet } from "./status-sheet";
import { styles } from "./styles";
import { statusConfig } from "./status-config";
${files["font.ts"] ? 'import { fontRef } from "./font";' : 'const fontRef = "";'}
export default function StatusPreview(){
  const api=useYumina();
  const container=React.useRef(null);
  React.useEffect(()=>{
    const parentOrigin=new URLSearchParams(window.location.search).get("parentOrigin");
    function selectCategory(event){
      if(event.source!==window.parent || !parentOrigin || event.origin!==parentOrigin || event.data?.type!=="yumina-status-preview-category") return;
      const index=statusConfig.groups.findIndex(group=>group.id===event.data.categoryId);
      if(index<0) return;
      const list=container.current?.querySelector('[role="tablist"][aria-label="Status categories"]');
      const tabs=list ? Array.from(list.querySelectorAll('[role="tab"]')) : [];
      const group=statusConfig.groups[index];
      const labeled=tabs.filter(tab=>tab.getAttribute("aria-label")===group.label || Array.from(tab.childNodes).filter(node=>node.nodeType===3).map(node=>node.textContent).join("").trim()===group.label);
      const tab=tabs.find(tab=>tab.getAttribute("data-status-category")===group.id) || (labeled.length===1 && statusConfig.groups.filter(item=>item.label===group.label).length===1 ? labeled[0] : tabs.length===statusConfig.groups.length ? tabs[index] : null);
      if(!tab) return;
      if(tab.getAttribute("aria-selected")!=="true") tab.click();
      const bounds=tab.getBoundingClientRect(), viewport=list.getBoundingClientRect();
      if(bounds.left<viewport.left) list.scrollLeft-=viewport.left-bounds.left;
      else if(bounds.right>viewport.right) list.scrollLeft+=bounds.right-viewport.right;
    }
    window.addEventListener("message",selectCategory);
    if(parentOrigin) window.parent.postMessage({type:"yumina-status-preview-ready"},parentOrigin);
    return ()=>window.removeEventListener("message",selectCategory);
  },[]);
  const fontUrl=fontRef ? api.resolveAssetUrl(fontRef) : "";
  const previewStyles=fontUrl ? styles.replaceAll("__FONT_URL__",fontUrl) : styles.replace(/@font-face\\s*\\{[^}]*__FONT_URL__[^}]*\\}/gi, "");
  return <div ref={container} className="vn vn-status-design-preview"><style>{previewStyles}</style><style>{\`
    .vn-status-design-preview .vn-drawer{animation:none!important;transform:none!important;width:100%;max-width:100%;border:0}
    .vn-status-design-preview .vn-overlay{z-index:1}
  \`}</style><StatusSheet api={api} onClose={()=>{}} onBack={()=>{}} preview /></div>;
}` } };
}
const statusMenuCss = '\n/* Status menu: keep longer menus scrolling inside the right sheet. */\n.vn .vn-drawer{overflow-y:auto;overflow-x:hidden}.vn .vn-menu-list{flex-shrink:0}.vn .vn-menu-status{width:100%;margin-left:0;min-height:64px;padding-left:12px!important;font-size:22px!important}\n';

export function readStatusConfig(source: string): StatusConfig {
  const literal = /^\s*(?:\/\/[^\n]*\n\s*)*export\s+const\s+statusConfig\s*=\s*([\s\S]*?);?\s*$/.exec(source)?.[1];
  if (!literal) throw new Error("These settings cannot be read by the visual builder. Ask the agent to repair your status settings.");
  const raw = JSON.parse(literal.replace(/;\s*$/, ""));
  const normalized = normalizeStatusConfig(raw);
  const authoredFields = Array.isArray(raw?.fields) ? raw.fields.filter((field: unknown) => field && typeof field === "object") : [];
  const authoredGroups = Array.isArray(raw?.groups) ? raw.groups : [];
  // Visual controls own known properties; keep authored extensions for custom layouts.
  return { ...raw, ...normalized,
    fields: normalized.fields.map((field, index) => ({ ...authoredFields[index], ...field })),
    groups: normalized.groups.map(group => ({ ...authoredGroups.find((item: { id?: string } | null) => item?.id === group.id), ...group })),
  };
}

export function writeStatusConfig(config: StatusConfig): string {
  return `// Edited by UI options → Visualizations. Values come from the current game state.\nexport const statusConfig = ${JSON.stringify(config, null, 2)};\n`;
}

export function fieldForVariable(variable?: Variable): StatusField {
  const name = variable?.name ?? "New field";
  const health = /\b(hp|health)\b/i.test(name);
  const stamina = /stamina|mana|energy/i.test(name);
  const money = /gold|wealth|coins|points/i.test(name);
  const signed = variable?.type === "number" && (variable.min ?? 0) < 0 && (variable.max ?? 100) > 0;
  const relationship = signed || /^rel-/.test(variable?.id ?? "") || /affinity|relationship|affection/i.test(name);
  const format = variable?.type === "number" ? relationship ? "pips" : health || stamina ? "bar" : variable.max === 10 ? "segments" : "value" : variable?.type === "json" ? "inventory" : "value";
  return {
    id: crypto.randomUUID(), label: name, variableId: variable?.id ?? "", path: "",
    group: relationship ? "relationships" : money || format === "inventory" ? "resources" : health || stamina || /corruption|arousal|heat/i.test(name) ? "vitals" : "overview",
    format, icon: health ? "♥" : stamina ? "◆" : money ? "●" : "✦",
    color: health ? "#a46d5d" : stamina ? "#568292" : "#c8b17e", min: variable?.min ?? 0, max: variable?.max ?? 100,
    maxVariableId: "", maxPath: "",
    gaugeShape: "half", pipShape: "heart", pipCount: 10, levelVariableId: "", levelPath: "", sceneIcon: "auto",
  };
}

export function initialStatusConfig(variables: Variable[]): StatusConfig {
  return normalizeStatusConfig({ title: "Status", subtitle: "Current state", accent: "#c8b17e",
    groups: [{ id: "overview", label: "Overview" }, { id: "vitals", label: "Vitals" }, { id: "resources", label: "Resources" }, { id: "relationships", label: "Relationships" }],
    fields: variables.filter(variable => !variable.internal && variable.enabled !== false).map(variable => fieldForVariable(variable)) });
}

/** Upgrade the known VN menu in place, retaining its authored files and assets. */
export function installStatusVisualization(root: RootComponent, config: StatusConfig, templates: Record<string, string>): Record<string, string> {
  const files = { ...root.files };
  const entry = files["__user-root.tsx"] ? "__user-root.tsx" : root.entryFile;
  let source = files[entry];
  if (source.includes('import { StatusSheet }') && (!source.includes('className="vn-menu-item vn-menu-status"') || !source.includes('StatusSheet api={sceneApi}') || !source.includes('previousPanel.current === "status"'))) {
    throw new Error("This interface has incomplete Status support. Ask the agent to restore the Status button and Back action.");
  }
  if (!source.includes('import { StatusSheet }')) {
    const menuAnchor = '          <div className="vn-menu-action-row">\n            {api.sessionId';
    const renderAnchor = '    {panel === "memory"';
    const focusAnchor = '    previousPanel.current = panel;';
    if (!source.includes(menuAnchor) || !source.includes(renderAnchor) || !source.includes(focusAnchor)) {
      throw new Error("This custom interface needs Status support. Select the current VN layout or ask the agent to add it.");
    }
    source = 'import { StatusSheet } from "./status-sheet";\n' + source;
    source = source.replace(menuAnchor, '          <button className="vn-menu-item vn-menu-status" onClick={() => setPanel("status")}><Icons.BarChart3 /><span>Status</span></button>\n' + menuAnchor);
    source = source.replace(renderAnchor, '    {panel === "status" && <StatusSheet api={sceneApi} onClose={() => setPanel("")} onBack={() => setPanel("menu")} />}\n' + renderAnchor);
    source = source.replace(focusAnchor, '    if (panel && view.current) { view.current.scrollTop = 0; view.current.scrollLeft = 0; }\n    if (panel === "status") view.current?.querySelector(".vn-back")?.focus({ preventScroll: true });\n    else if (panel === "menu" && previousPanel.current === "status") view.current?.querySelector(".vn-menu-status")?.focus({ preventScroll: true });\n' + focusAnchor);
    source = source.replace('panel === "save" ? "menu" : ""', '["save", "status"].includes(panel) ? "menu" : ""');
    files[entry] = source;
  }
  if (!source.includes('view.current.scrollTop = 0')) {
    source = source.replace('    previousPanel.current = panel;', '    if (panel && view.current) { view.current.scrollTop = 0; view.current.scrollLeft = 0; }\n    previousPanel.current = panel;');
    files[entry] = source;
  }
  source = source.replace('.filter(node => node.getClientRects().length);', '.filter(node => node.getClientRects().length && node.tabIndex >= 0);');
  files[entry] = source;
  if (files["styles.ts"] && !files["styles.ts"].includes('/* Status menu:')) {
    // Append to the exported stylesheet while keeping all authored CSS intact.
    const end = files["styles.ts"].lastIndexOf('`');
    if (end < 0) throw new Error("Status needs a template-literal stylesheet in styles.ts.");
    files["styles.ts"] = files["styles.ts"].slice(0, end) + statusMenuCss + files["styles.ts"].slice(end);
  }
  const upgraded = installStatusLayoutFiles(upgradeStatusFiles(files, templates), templates);
  if (upgraded["status-view.tsx"] && config.fields.some(field => ["gauge", "resource", "chips", "pips", "xp-ring", "scene"].includes(field.format)) && upgraded["status-view.tsx"] !== templates["status-view.tsx"] && !upgraded["status-view.tsx"]?.includes('"./status-widgets"')) {
    throw new Error("This custom design needs support for the selected display. Ask the agent to add it to your status layout.");
  }
  for (const [name, source] of Object.entries(templates)) if (!upgraded[name]) upgraded[name] = source;
  upgraded[STATUS_CONFIG_FILE] = writeStatusConfig(config);
  return upgraded;
}
