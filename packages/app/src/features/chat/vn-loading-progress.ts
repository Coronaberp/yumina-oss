const previousLoader = '<div className="vn-status" role="status"><span className="vn-spinner" aria-hidden="true" /><span>Loading…</span></div>';

/** Refresh only the recognizable shipped loader when playing a saved VN card. */
export function upgradeVnLoadingFiles(files: Record<string, string>, loadingSource: string): Record<string, string> {
  if (files["loading-status.tsx"] !== undefined && files["loading-status.tsx"] !== loadingSource) return files;
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !source.includes("const api = useYumina();") || !source.includes(previousLoader)) continue;
    if (updated === files) updated = { ...files, "loading-status.tsx": loadingSource };
    const prefix = source.includes('import { LoadingStatus } from "./loading-status";') ? "" : 'import { LoadingStatus } from "./loading-status";\n';
    updated[name] = prefix + source.replace(previousLoader, '<LoadingStatus api={api} />');
  }
  return updated;
}
