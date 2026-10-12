import type { Variable } from "@yumina/engine";
import type { StatusConfig } from "../../../../../../interfaces/vn/status-data";
import { fieldForVariable } from "./status-visualizations";

/** Move/add only the requested field, preserving all other authored settings. */
export function applyStatusDrop(config: StatusConfig, variables: Variable[], active: string, over: string | null): StatusConfig {
  if (!over || active === over) return config;
  const target = over.startsWith("field:") ? config.fields.find(field => field.id === over.slice(6)) : undefined;
  const group = over.startsWith("category:") ? over.slice(9) : target?.group;
  if (!group || !config.groups.some(category => category.id === group)) return config;
  const fields = [...config.fields];
  if (active.startsWith("variable:")) {
    const variable = variables.find(item => item.id === active.slice(9) && !item.internal && item.enabled !== false);
    if (!variable) return config;
    const field = { ...fieldForVariable(variable), group };
    fields.splice(target ? fields.indexOf(target) : fields.length, 0, field);
  } else if (active.startsWith("field:")) {
    const from = fields.findIndex(field => field.id === active.slice(6));
    if (from < 0) return config;
    const field = fields[from];
    if (!target) {
      if (field.group === group) return config;
      fields[from] = { ...field, group };
    } else {
      const to = fields.indexOf(target);
      fields.splice(from, 1);
      fields.splice(to, 0, field.group === group ? field : { ...field, group });
    }
  } else return config;
  return { ...config, fields };
}

export function statusDesignPrompt(request: string): string {
  return `Customize my player Status screen in UI options → Visualizations:\n\n${request.trim()}\n\nKeep my connected values, ranges and existing settings unless this design needs a change. Keep the drag-and-drop controls working for field order, categories, colors and displays. Status uses the right sheet, Back returns to the menu, and Close dismisses it. Preserve confirmed live values and unrelated gameplay. Do not show source code; handle it for me and briefly explain the visible changes.`;
}
