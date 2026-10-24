import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Run the real browser module in a fresh realm for every case. Only its build-
// stamped document URL and browser/network primitives are fixture dependencies.
const code = ts.transpileModule(readFileSync(new URL("./sandbox-prewarm.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function fixture(options: { idle?: boolean; noWindow?: boolean; failDocument?: boolean; failAsset?: boolean } = {}) {
  const scheduled: Array<() => Promise<void>> = [];
  const requests: Array<{ url: string; options: RequestInit }> = [];
  const modules: string[] = [];
  const window = {
    requestIdleCallback: options.idle === false ? undefined : function (this: unknown, callback: () => Promise<void>) {
      assert.equal(this, window, "native idle callbacks require their Window receiver");
      scheduled.push(callback); return 1;
    },
    setTimeout(callback: () => Promise<void>, delay: number) { assert.equal(delay, 400); scheduled.push(callback); return 1; },
  };
  const context = vm.createContext({
    exports: {},
    ...(options.noWindow ? {} : { window }),
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, options: init });
      if (url === "/assets/document.html") {
        if (options.failDocument) throw new Error("Fixture offline");
        return { ok: true, text: async () => '<script src="/assets/sandbox.js"></script><link href="/assets/sandbox.css"><script src="/assets/sandbox.js"></script><script src="https://external.test/ignored.js"></script>' };
      }
      if (options.failAsset) throw new Error("Fixture asset offline");
      return { ok: true };
    },
    require: (name: string) => {
      modules.push(name);
      if (name === "./sandbox-doc-url") return { SANDBOX_DOC_URL: "/assets/document.html" };
      throw new Error(`Unexpected eager module: ${name}`);
    },
  });
  vm.runInContext(code, context);
  return { context, window, scheduled, requests, modules, prewarm: (context.exports as { prewarmSandbox: () => void }).prewarmSandbox };
}

test("idle sandbox warming keeps the native Window receiver and deduplicates repeated calls", async () => {
  const f = fixture();
  f.prewarm(); f.prewarm();
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.requests.length, 0, "startup does no work until the idle callback");
  await f.scheduled[0]();
  assert.deepEqual(f.requests.map(request => request.url), ["/assets/document.html", "/assets/document.html", "/assets/sandbox.js", "/assets/sandbox.css"]);
  assert.ok(f.requests.every(request => request.options.credentials === "omit" && request.options.cache === "force-cache"));
});

test("sandbox document warming does not load either compiler before a card needs one", async () => {
  const f = fixture({ idle: false });
  f.prewarm(); await f.scheduled[0]();
  assert.deepEqual(f.modules, ["./sandbox-doc-url"]);
});

test("an unavailable browser does not consume the later browser warmup", () => {
  const f = fixture({ noWindow: true });
  assert.doesNotThrow(f.prewarm);
  f.context.window = f.window;
  f.prewarm();
  assert.equal(f.scheduled.length, 1);
});

test("document and asset failures remain optional with no repeated warmup storm", async () => {
  for (const options of [{ failDocument: true }, { failAsset: true }]) {
    const f = fixture({ idle: false, ...options });
    f.prewarm();
    await assert.doesNotReject(f.scheduled[0]);
    f.prewarm();
    assert.equal(f.scheduled.length, 1);
    assert.ok(!f.modules.some(name => name.includes("tsx-compiler") || name.includes("tsx-bundler")));
  }
});
