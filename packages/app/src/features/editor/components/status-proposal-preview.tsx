import { useEditorStore } from "@/stores/editor";
import { readStatusConfig, initialStatusConfig, STATUS_CONFIG_FILE, STATUS_LAYOUT_FILE } from "../lib/status-visualizations";
import { StatusLayoutPreview } from "./status-layout-preview";
import { statusSourceTemplates } from "../lib/status-source-templates";
import type { ToolCall } from "@/features/studio/lib/types";

/** Show an uncommitted layout in the read-only sandbox before approving it. */
export function StatusProposalPreview({ toolCall }: { toolCall: ToolCall }) {
  const draft = useEditorStore(state => state.worldDraft);
  if (!draft.rootComponent) return null;
  try {
    const args = JSON.parse(toolCall.function.arguments);
    const name = toolCall.function.name;
    const id = name.endsWith("status_visualization") ? STATUS_LAYOUT_FILE : args.id;
    const files = { ...draft.rootComponent.files };
    if (typeof args.layoutCode === "string") files[id] = args.layoutCode;
    else if (typeof args.tsxCode === "string") files[id] = args.tsxCode;
    else if (typeof args.old_code === "string" && args.old_code && typeof args.new_code === "string" && files[id]?.includes(args.old_code)) files[id] = files[id].replace(args.old_code, args.new_code);
    const config = files[STATUS_CONFIG_FILE] ? readStatusConfig(files[STATUS_CONFIG_FILE]) : initialStatusConfig(draft.variables);
    const variables = Object.fromEntries(draft.variables.filter(variable => !variable.internal).map(variable => [variable.id, variable.defaultValue]));
    return <StatusLayoutPreview root={{ ...draft.rootComponent, files }} config={config} variables={variables} templates={statusSourceTemplates} worldName={draft.name} />;
  } catch { return <p role="alert" className="text-xs text-destructive">This design could not be previewed. Ask the agent to repair it.</p>; }
}
