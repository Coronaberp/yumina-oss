import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transform } from "sucrase";
import type { WorldDiff } from "@yumina/engine";
import type { VersionComparisonInput } from "./version-comparison-data";

test("comparison worker releases resources and ignores replies after cancellation", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let instance: FakeWorker;
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { preventDefault: () => void }) => void;
    onmessageerror?: () => void;
    terminated = false;
    // The worker fake exposes the browser-owned instance for event delivery.
    constructor() {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      instance = this;
    }
    postMessage() {}
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  const module = { exports: {} as { startVersionComparison: (input: VersionComparisonInput, done: (diff: WorldDiff | null) => void) => () => void } };
  const source = readFileSync(new URL("./version-comparison-client.ts", import.meta.url), "utf8").replaceAll("import.meta.url", '"https://test.local/"');
  new Function("module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)(module, module.exports);
  try {
    const results: Array<WorldDiff | null> = [];
    const start = () => module.exports.startVersionComparison({} as VersionComparisonInput, value => results.push(value));
    const stop = start(); const stale = instance!.onmessage!; stop();
    stale({ data: { diff: { changes: [], counts: { added: 0, removed: 0, modified: 0 } } } });
    assert.deepEqual(results, []); assert.equal(instance!.terminated, true);
    start(); const diff = { changes: [], counts: { added: 0, removed: 0, modified: 0 } };
    instance!.onmessage!({ data: { diff } }); assert.deepEqual(results, [diff]); assert.equal(instance!.terminated, true);
    start(); instance!.onerror!({ preventDefault() {} }); assert.equal(results.at(-1), null); assert.equal(instance!.terminated, true);
    start(); instance!.onmessageerror!(); assert.equal(results.at(-1), null); assert.equal(instance!.terminated, true);
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: class { constructor() { throw new Error("Unavailable"); } } });
    start(); assert.equal(results.at(-1), null);
  } finally { if (previous) Object.defineProperty(globalThis, "Worker", previous); else Reflect.deleteProperty(globalThis, "Worker"); }
});
