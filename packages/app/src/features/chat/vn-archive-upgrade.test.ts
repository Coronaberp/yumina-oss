import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { upgradeVnArchiveFiles } from "./vn-archive-upgrade";

test("saved VN upgrade wires only inert export and native turn filter, preserving card files", () => {
  const source = readFileSync(new URL("../../../../../interfaces/vn/index.tsx", import.meta.url), "utf8");
  const files = { "index.tsx": source, "status-config.ts": "my authored config", "font.ts": "my uploaded font" };
  const updated = upgradeVnArchiveFiles(files, "picker source");
  assert.ok(updated["index.tsx"].includes("api.openSessionExport()"));
  assert.ok(updated["index.tsx"].includes("<TurnPicker"));
  assert.ok(!updated["index.tsx"].includes('select aria-label="Filter by turn"'));
  assert.equal(updated["status-config.ts"], files["status-config.ts"]);
  assert.equal(updated["font.ts"], files["font.ts"]);
  assert.equal(updated["turn-picker.tsx"], "picker source");
  assert.deepEqual(upgradeVnArchiveFiles(updated, "picker source"), updated);
  assert.deepEqual(upgradeVnArchiveFiles({ "index.tsx": "Custom creator UI" }, "picker source"), { "index.tsx": "Custom creator UI" });
});

test("older saved VN menus gain Export without replacing the surrounding menu", () => {
  const source = 'function Menu({api,onClose}) { return <div className="vn"><nav className="vn-menu-list" aria-label="Story controls"><button>Authored menu entry</button></nav></div>; }';
  const updated = upgradeVnArchiveFiles({ "index.tsx": source }, "picker source");
  assert.ok(updated["index.tsx"].includes("api.openSessionExport()"));
  assert.ok(updated["index.tsx"].includes("Authored menu entry"));
  assert.deepEqual(upgradeVnArchiveFiles(updated, "picker source"), updated);
});
