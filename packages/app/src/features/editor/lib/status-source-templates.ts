import data from "../../../../../../interfaces/vn/status-data.ts?raw";
import view from "../../../../../../interfaces/vn/status-view.tsx?raw";
import gauge from "../../../../../../interfaces/vn/status-gauge.tsx?raw";
import widgets from "../../../../../../interfaces/vn/status-widgets.tsx?raw";
import sheet from "../../../../../../interfaces/vn/status-sheet.tsx?raw";
import layout from "../../../../../../interfaces/vn/status-layout.tsx?raw";

export const statusSourceTemplates = { "status-data.ts": data, "status-view.tsx": view, "status-sheet.tsx": sheet,
  "status-gauge.tsx": gauge, "status-widgets.tsx": widgets, "status-layout.tsx": layout };
