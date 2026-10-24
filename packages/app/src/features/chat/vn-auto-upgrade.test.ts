import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
const folder = new URL("../../../../../interfaces/vn/", import.meta.url);
const upgradePath = new URL("./vn-auto-upgrade.ts", import.meta.url);

async function fixture() {
  assert.ok(existsSync(upgradePath), "A guarded upgrade must exist for already-saved VN cuts");
  const { upgradeVnAutoFiles } = await import("./vn-auto-upgrade");
  const current = readFileSync(new URL("index.tsx", folder), "utf8");
  const helper = readFileSync(new URL("auto-reading.ts", folder), "utf8");
  const begin = current.indexOf("  useAutoReading({");
  const end = current.indexOf("\n\n  React.useEffect(() => {\n    function keydown", begin);
  assert.ok(begin > 0 && end > begin);
  const oldAuto = `  React.useEffect(() => {
    if (!auto || panel || viewerOpen || hidden || end || waiting || api.isStreaming) return;
    const timer = setTimeout(() => setCursor({ turn, index: index + 1 }), Math.max(autoDelay, (line?.text.length || 0) * 35));
    return () => clearTimeout(timer);
  }, [auto, panel, viewerOpen, hidden, end, waiting, api.isStreaming, turn, index, autoDelay, line?.text]);`;
  const old = (current.slice(0, begin) + oldAuto + current.slice(end))
    .replace('import { useAutoReading } from "./auto-reading";\n', '')
    .replace('function movePage(direction, manual = true)', 'function movePage(direction)')
    .replace('if (manual) setAuto(false);', 'setAuto(false);')
    .replace('      setAuto(false);\n      const text = event.target.closest(".vn-text");', '      const text = event.target.closest(".vn-text");')
    .replace('onClick={() => setAuto(current => !current)}', 'onClick={() => setAuto(!auto)}');
  return { upgradeVnAutoFiles, current, old, helper };
}

test("saved stock VN cuts acquire pacing without touching authored content", async () => {
  const { upgradeVnAutoFiles, old, helper } = await fixture();
  const input = { "index.tsx": "Custom wrapper", "__user-root.tsx": old, "scenes.ts": "Creator backgrounds", "styles.ts": "Custom colors", "status-layout.tsx": "Custom layout" };
  const upgraded = upgradeVnAutoFiles(input, helper);
  assert.notEqual(upgraded, input); assert.match(upgraded["__user-root.tsx"], /useAutoReading\(\{/);
  assert.equal(upgraded["auto-reading.ts"], helper);
  for (const key of ["index.tsx", "scenes.ts", "styles.ts", "status-layout.tsx"] as const) assert.equal(upgraded[key], input[key]);
  assert.equal(input["__user-root.tsx"], old);
  assert.equal(upgradeVnAutoFiles(upgraded, helper), upgraded);
});

test("current source, custom Auto handlers and custom helpers remain unchanged", async () => {
  const { upgradeVnAutoFiles, current, old, helper } = await fixture();
  const fresh = { "index.tsx": current, "auto-reading.ts": helper };
  assert.equal(upgradeVnAutoFiles(fresh, helper), fresh);
  const custom = { "index.tsx": old.replace('Math.max(autoDelay, (line?.text.length || 0) * 35)', 'customAutoPace(line)') };
  assert.equal(upgradeVnAutoFiles(custom, helper), custom);
  const collision = { "index.tsx": old, "auto-reading.ts": "Creator helper" };
  assert.equal(upgradeVnAutoFiles(collision, helper), collision);
  const unrelated = { "index.tsx": '<div className="vn">My own interface</div>' };
  assert.equal(upgradeVnAutoFiles(unrelated, helper), unrelated);
});

test("nested VN cuts receive a helper adjacent to their own entry", async () => {
  const { upgradeVnAutoFiles, old, helper } = await fixture();
  const updated = upgradeVnAutoFiles({ "ui/story.tsx": old }, helper);
  assert.equal(updated["ui/auto-reading.ts"], helper); assert.equal(updated["auto-reading.ts"], undefined);
});
