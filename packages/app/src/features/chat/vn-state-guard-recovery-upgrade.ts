const stockControls = "    {error && <div className=\"vn-error\" role=\"alert\"><span>{error}</span>\n      {canRetry && !api.readOnly && <button disabled={api.isStreaming} onClick={retryResponse}>Retry</button>}\n      {canChangeChoice && <button disabled={busy} onClick={changePendingChoice}>Choose something else</button>}\n      <button onClick={() => api.openModelPicker()}>Choose model</button>\n      {operationError && <button onClick={() => setOperationError(\"\")}>Dismiss</button>}\n    </div>}";
const correctedControls = "    {error && <div className=\"vn-error\" role=\"alert\"><span>{error}</span>\n      {canRetry && !api.readOnly && <button disabled={api.isStreaming} onClick={retryResponse}>Retry</button>}\n      {canChangeChoice && <button disabled={busy} onClick={changePendingChoice}>Choose something else</button>}\n      {/^(?:State update check failed \\((?:correction_model_unavailable|correction_timeout|correction_context_limit|correction_output_limit|incomplete_correction|invalid_correction|provider_auth|provider_rate_limit|provider_context_limit|provider_unsupported_format|provider_model_unavailable|provider_unavailable|provider_error)\\)\\.|Not enough mushies for the state update correction(?:[.:]|$))/.test(error)\n        ? typeof api.openStateGuardSettings === \"function\"\n          ? <button disabled={api.readOnly || api.isStreaming} onClick={() => api.openStateGuardSettings()}>State Update Guard settings</button>\n          : <span>Open State Update Guard from the app menu to check its correction model settings.</span>\n        : <button onClick={() => api.openModelPicker()}>Choose model</button>}\n      {operationError && <button onClick={() => setOperationError(\"\")}>Dismiss</button>}\n    </div>}";

/** Refresh only the exact shipped recovery controls; leave creator handlers intact. */
export function upgradeVnStateGuardRecoveryFiles(files: Record<string, string>): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !source.includes('className="vn"') || !source.includes('className="vn-stage"')
      || !source.includes('const error = api.error ||') || source.split(stockControls).length !== 2) continue;
    if (updated === files) updated = { ...files };
    updated[name] = source.replace(stockControls, correctedControls);
  }
  return updated;
}
