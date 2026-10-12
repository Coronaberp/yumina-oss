import { StatusView } from "./status-view";

// UI options → Visualizations. Custom source lives in Advanced; the sheet owns Back/Close.
export default function StatusLayout({ config, variables, preview = false }) {
  return <StatusView config={config} variables={variables} preview={preview} />;
}
