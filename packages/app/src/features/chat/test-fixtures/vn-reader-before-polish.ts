import assert from "node:assert/strict";

/** Reconstruct shipped boundaries, rather than mixing old migration markers
 * with the later model-routing and Auto handler signatures. */
export function beforeModelRouting(source: string): string {
  const changes = [
    ['import { ModelRoutingDetails } from "./model-routing-details";\n', ""],
    ["function Menu({ api, currentMessage, onClose", "function Menu({ api, onClose"],
    ['            <ModelRoutingDetails selectedModel={api.selectedModel} message={currentMessage} />\n', ""],
    ["<Menu api={api} currentMessage={currentMessage} onClose=", "<Menu api={api} onClose="],
  ] as const;
  for (const [before, after] of changes) {
    assert.equal(source.split(before).length, 2, `Known stock model-routing fixture anchor: ${before.trim()}`);
    source = source.replace(before, after);
  }
  return source;
}

export function beforeAutoReading(source: string): string {
  const begin = source.indexOf("  useAutoReading({");
  const end = source.indexOf("\n\n  React.useEffect(() => {\n    function keydown", begin);
  assert.ok(begin > 0 && end > begin, "Known stock Auto fixture boundary");
  const oldAuto = `  React.useEffect(() => {
    if (!auto || panel || viewerOpen || hidden || end || waiting || api.isStreaming) return;
    const timer = setTimeout(() => setCursor({ turn, index: index + 1 }), Math.max(autoDelay, (line?.text.length || 0) * 35));
    return () => clearTimeout(timer);
  }, [auto, panel, viewerOpen, hidden, end, waiting, api.isStreaming, turn, index, autoDelay, line?.text]);`;
  source = source.slice(0, begin) + oldAuto + source.slice(end);
  const changes = [
    ['import { useAutoReading } from "./auto-reading";\n', ""],
    ["function movePage(direction, manual = true)", "function movePage(direction)"],
    ["if (manual) setAuto(false);", "setAuto(false);"],
    ['      setAuto(false);\n      const text = event.target.closest(".vn-text");', '      const text = event.target.closest(".vn-text");'],
    ["onClick={() => setAuto(current => !current)}", "onClick={() => setAuto(!auto)}"],
  ] as const;
  for (const [before, after] of changes) {
    assert.equal(source.split(before).length, 2, `Known stock Auto fixture anchor: ${before.trim()}`);
    source = source.replace(before, after);
  }
  return source;
}
