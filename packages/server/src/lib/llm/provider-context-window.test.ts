import assert from "node:assert/strict";
import test from "node:test";
import { createByokProvider } from "./provider-factory.js";
import { clampMaxContextToModel } from "./context-window.js";

test("a saved endpoint cap constrains Story input even when its model family advertises a larger window", async () => {
  const provider = createByokProvider("custom", "fixture", "https://example.com/v1", { contextWindow: 65536 });
  const window = await provider.getContextWindow?.();
  assert.equal(window, 65536);
  assert.equal(clampMaxContextToModel(200000, "custom/qwen3.8", 12000, undefined, window), 45505);
});

test("endpoint caps apply independently to every saved provider type and can return to automatic detection", async () => {
  for (const name of ["custom", "openrouter", "anthropic", "openai", "google", "ollama"] as const) {
    const provider = createByokProvider(name, name === "ollama" ? "https://ollama.example.com" : "fixture", "https://example.com/v1", { contextWindow: 32768 });
    assert.equal(await provider.getContextWindow?.(), 32768, name);
  }
  const automatic = createByokProvider("custom", "fixture", "https://example.com/v1", { contextWindow: null });
  assert.equal(await automatic.getContextWindow?.(), undefined);
});

test("an explicit cap cannot expand a smaller discovered account window", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ max_context_length: 32768 }));
  const provider = createByokProvider("custom", "endpoint-cap-fixture", "https://api.featherless.ai/v1", { contextWindow: 65536 });
  assert.equal(await provider.getContextWindow?.(), 32768);
});
