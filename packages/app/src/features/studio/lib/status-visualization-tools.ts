export function isStatusVisualizationTool(name: string, args: Record<string, unknown> = {}): boolean {
  return name === "write_status_visualization" || name === "edit_status_visualization"
    || ["write_custom_ui", "edit_custom_ui", "studio.entity.edit"].includes(name) && ["status-layout.tsx", "status-config.ts"].includes(String(args.id ?? args.file ?? ""));
}
