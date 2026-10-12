import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator, location: dom.window.location,
  localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element,
  Node: dom.window.Node, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import("react-dom/client");
const vite = await createServer({
  configFile: false, root: fileURLToPath(new URL("../../..", import.meta.url)), appType: "custom", logLevel: "silent",
  resolve: { alias: {
    "@": fileURLToPath(new URL("../..", import.meta.url)),
    "@yumina/engine": fileURLToPath(new URL("../../../../engine/src/index.ts", import.meta.url)),
    "@yumina/shared": fileURLToPath(new URL("../../../../shared/src/index.ts", import.meta.url)),
  } },
  esbuild: { jsx: "automatic" }, server: { middlewareMode: true },
});
const { ApiKeysSettings } = await vite.ssrLoadModule("/src/features/settings/api-keys.tsx") as typeof import("./api-keys");
const { useConfigStore } = await vite.ssrLoadModule("/src/stores/config.ts") as typeof import("@/stores/config");
const { parseContentEndpointSelection } = await vite.ssrLoadModule("/src/features/settings/content-endpoint-cards.tsx") as typeof import("./content-endpoint-cards");
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { profile: JSON.parse(readFileSync(new URL("../../locales/en/profile.json", import.meta.url), "utf8")) } }, interpolation: { escapeValue: false } });
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  await vite.close();
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
function button(label: string) {
  const match = [...dom.window.document.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
  assert.ok(match, `Missing button: ${label}`);
  return match;
}
function modelField() {
  return dom.window.document.querySelector<HTMLInputElement>('input[placeholder="Enter the full model ID that works in your other app"]')!;
}
async function input(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
interface EndpointFixture {
  selection: { sfwApiKeyId: string | null; nsfwApiKeyId: string | null };
  patches: Record<string, unknown>[];
  profilePatches: Record<string, unknown>[];
  remount: () => Promise<void>;
}
async function render(run: (calls: string[], fixture: EndpointFixture) => Promise<void>, reply: unknown = { ok: true, reply: "Hello" }, pending?: Promise<Response>, options: { separateSfw?: boolean; nsfwId?: string; endpointFailure?: string; pendingEndpoint?: Promise<void>; inheritedDefaults?: boolean; sharedDefaultsWithOwnProfile?: boolean; contextWindow?: number } = {}) {
  const calls: string[] = [];
  const entry = { id: "custom-profile", provider: "custom", label: "Featherless", baseUrl: "https://api.example.com/v1", metadata: { defaultModel: "manual/model", contextWindow: options.contextWindow ?? null }, createdAt: "2026-09-12" };
  const profiles = options.inheritedDefaults ? [] : options.separateSfw ? [entry, { ...entry, id: "sfw-profile", label: "Cerebas" }, { ...entry, id: "other-profile", label: "Other provider" }] : [entry];
  const selection = { sfwApiKeyId: options.inheritedDefaults ? null : options.separateSfw ? "sfw-profile" : entry.id, nsfwApiKeyId: options.nsfwId ?? null,
    ...((options.inheritedDefaults || options.sharedDefaultsWithOwnProfile) ? { defaults: { sfw: { provider: 'custom', model: 'custom/admin-sfw-model' }, nsfw: { provider: 'custom', model: 'custom/admin-nsfw-model' } } } : {}),
  };
  const patches: Record<string, unknown>[] = [];
  const profilePatches: Record<string, unknown>[] = [];
  useConfigStore.setState({ selectedModel: "custom/story-model" });
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path.endsWith("/content-endpoints")) {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body));
        patches.push(patch);
        await options.pendingEndpoint;
        if (options.endpointFailure) return new Response(JSON.stringify({ error: options.endpointFailure }), { status: 500, headers: { "Content-Type": "application/json" } });
        Object.assign(selection, patch);
      }
      return json({ data: selection });
    }
    if (path.endsWith("/api/users/me")) return json({ data: { id: "settings-user", name: "Settings user", email: "settings@example.invalid", role: "user", preferences: { activeApiKeyId: selection.sfwApiKeyId, nsfwApiKeyId: selection.nsfwApiKeyId }, createdAt: "2026-09-12", updatedAt: "2026-09-12" } });
    if (path.endsWith("/list-models")) return pending ?? json({ data: { ok: false, code: "model_list_unavailable", status: 404 } });
    if (path.endsWith("/test")) return json({ data: reply });
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      profilePatches.push(patch);
      if (patch.defaultModel !== undefined) entry.metadata.defaultModel = patch.defaultModel;
      if (patch.contextWindow !== undefined) entry.metadata.contextWindow = patch.contextWindow;
      for (const name of ['temperature', 'topP', 'topK']) if (patch[name] !== undefined) Object.assign(entry.metadata, { [name]: patch[name] });
      return json({ data: entry });
    }
    return json({ data: profiles });
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  let mount = 0;
  const remount = async () => { await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(ApiKeysSettings, { key: mount++ })))); };
  try {
    await remount();
    await run(calls, { selection, patches, profilePatches, remount });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = realFetch;
  }
}

test('profile creativity settings save, survive reopening, and reject invalid values', async () => {
  await render(async (_calls, fixture) => {
    const saveButton = () => {
      const node = [...dom.window.document.querySelectorAll('button')].find(node => ['Save', 'Saved'].includes(node.textContent?.trim() ?? ''));
      assert.ok(node);
      return node;
    };
    const field = (name: string) => {
      const node = dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);
      assert.ok(node, `Missing creativity control: ${name}`);
      return node;
    };
    assert.equal(field('Temperature').value, '0.8');
    assert.equal(field('Top P').value, '0.95');
    assert.equal(field('Top K').value, '40');
    await input(field('Temperature'), '0.6');
    await input(field('Top P'), '0.9');
    await input(field('Top K'), '60');
    await act(async () => saveButton().click());
    assert.deepEqual(fixture.profilePatches.at(-1), { temperature: 0.6, topP: 0.9, topK: 60 });
    await fixture.remount();
    assert.equal(field('Temperature').value, '0.6');
    assert.equal(field('Top P').value, '0.9');
    assert.equal(field('Top K').value, '60');
    await input(field('Top K'), '1.5');
    assert.equal(field('Top K').getAttribute('aria-invalid'), 'true');
    assert.equal(saveButton().disabled, true);
    await input(field('Top K'), '0');
    await input(field('Temperature'), '0');
    await act(async () => saveButton().click());
    assert.deepEqual(fixture.profilePatches.at(-1), { temperature: 0, topK: 0 });
    for (const name of ['Temperature', 'Top P', 'Top K']) await input(field(name), '');
    await act(async () => saveButton().click());
    assert.deepEqual(fixture.profilePatches.at(-1), { temperature: 0.8, topP: 0.95, topK: 40 });
    assert.equal(saveButton().disabled, true);
    await fixture.remount();
    assert.equal(field('Temperature').value, '0.8');
    assert.equal(field('Top P').value, '0.95');
    assert.equal(field('Top K').value, '40');
  });
});

test("endpoint context windows save independently and clearing restores automatic detection", async () => {
  await render(async (_calls, { profilePatches, remount }) => {
    const field = () => dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Context window (tokens)"]');
    assert.ok(field(), "The endpoint profile exposes its context window");
    assert.equal(field()!.value, "");
    await input(field()!, "65536");
    await act(async () => button("Save").click());
    assert.equal(profilePatches.at(-1)?.contextWindow, 65536);
    await remount();
    assert.equal(field()!.value, "65536");
    await input(field()!, "");
    await act(async () => button("Save").click());
    assert.equal(profilePatches.at(-1)?.contextWindow, null);
    await remount();
    assert.equal(field()!.value, "");
  });
});

test("an invalid endpoint context window blocks saving", async () => {
  await render(async (_calls, { profilePatches }) => {
    const field = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Context window (tokens)"]');
    assert.ok(field);
    await input(field, "0");
    assert.equal(field.getAttribute("aria-invalid"), "true");
    assert.equal(button("Save").disabled, true);
    assert.equal(profilePatches.length, 0);
  });
});

test("settings expose only SFW and NSFW provider selections", async () => {
  await render(async () => {
    const body = dom.window.document.body.textContent ?? "";
    assert.ok(body.includes("SFW provider"));
    assert.ok(body.includes("NSFW provider"));
    assert.ok(body.includes("No NSFW provider selected"));
    assert.ok(body.includes("Featherless"));
    assert.ok(!body.includes("Little Idot provider"));
    assert.equal(dom.window.document.querySelectorAll("section[aria-labelledby^=content-endpoint-]").length, 2);
    assert.ok(body.includes("before sending"));
  });
});

test('inherited endpoint metadata survives parsing and appears as configured admin defaults', async () => {
  const selection = { sfwApiKeyId: null, nsfwApiKeyId: null, defaults: { sfw: { provider: 'custom', model: 'custom/admin-sfw-model' }, nsfw: { provider: 'custom', model: 'custom/admin-nsfw-model' } } };
  assert.deepEqual(parseContentEndpointSelection(selection), selection);
  await render(async () => {
    const body = dom.window.document.body.textContent ?? '';
    assert.ok(body.includes('Admin default'));
    assert.ok(body.includes('custom/admin-sfw-model'));
    assert.ok(body.includes('custom/admin-nsfw-model'));
    assert.ok(!body.includes('No NSFW provider selected'));
    assert.ok(!body.includes('Edit profile'), 'Members cannot edit the shared admin profiles');
    assert.ok(body.includes('Create profile'), 'Members can still add their own providers');
  }, undefined, undefined, { inheritedDefaults: true });
});

test("unavailable discovery leaves the manual model usable and a real reply establishes test success", async () => {
  await render(async (calls) => {
    await act(async () => button("Fetch models").click());
    const warning = [...dom.window.document.querySelectorAll("div")].find(node => node.textContent === "Could not fetch the model list (HTTP 404). Enter a model ID and send a test message.");
    assert.ok(warning?.className.includes("text-amber-200"));
    assert.equal(modelField().disabled, false);
    assert.equal(button("Send test message").disabled, false);
    await act(async () => button("Send test message").click());
    assert.ok(dom.window.document.body.textContent?.includes("Test successful"));
    assert.ok(!dom.window.document.body.textContent?.includes("Could not fetch the model list"));
    assert.equal(calls.filter(call => call.endsWith("/test")).length, 1);
    await input(modelField(), "another/model");
    assert.ok(!dom.window.document.body.textContent?.includes("Test successful"), "changing the model invalidates the previous result");
  });
});

test("an empty successful payload cannot be displayed as a successful generation", async () => {
  await render(async () => {
    await act(async () => button("Send test message").click());
    assert.ok(!dom.window.document.body.textContent?.includes("Test successful"));
    assert.ok(dom.window.document.body.textContent?.includes("Test failed"));
  }, { ok: true, reply: "   " });
});

test("saving a manual model never triggers model discovery for a custom profile", async () => {
  await render(async (calls) => {
    await input(modelField(), "another/model");
    await act(async () => button("Save").click());
    assert.ok(calls.some(call => call.startsWith("PATCH")));
    assert.ok(!calls.some(call => call.endsWith("/list-models")));
    assert.equal(modelField().value, "another/model");
  });
});

test("pending discovery locks credentials, model edits and competing requests", async () => {
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  await render(async () => {
    await act(async () => button("Fetch models").click());
    assert.equal(modelField().disabled, true);
    assert.equal(button("Send test message").disabled, true);
    assert.equal(button("Additional params").disabled, true);
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[name="profile-custom-profile-api-key"]')!.disabled, true);
    await act(async () => finish(json({ data: { ok: false, code: "model_list_unavailable", status: 404 } })));
    assert.equal(modelField().disabled, false);
    assert.equal(button("Send test message").disabled, false);
  }, undefined, pending);
});

test("a profile can be assigned to NSFW directly, keeps SFW and its model, and stays marked after reload", async () => {
  await render(async (_, { selection, patches, remount }) => {
    assert.ok(button("Use as SFW"));
    await act(async () => button("Use as NSFW").click());
    assert.deepEqual(patches, [{ nsfwApiKeyId: "custom-profile" }]);
    assert.deepEqual(selection, { sfwApiKeyId: "sfw-profile", nsfwApiKeyId: "custom-profile" });
    assert.equal(useConfigStore.getState().selectedModel, "custom/story-model", "NSFW assignment leaves the story model alone");
    const nsfw = dom.window.document.querySelector('[role="img"][aria-label="Active NSFW provider"]');
    assert.ok(nsfw);
    assert.ok(nsfw.classList.contains("bg-red-500"), "assigned NSFW profile has a red indicator");
    assert.equal(nsfw.closest("button")!.textContent?.trim(), "Featherless");
    const sfw = dom.window.document.querySelector('[role="img"][aria-label="Active SFW provider"]');
    assert.ok(sfw);
    assert.ok(sfw.classList.contains("bg-emerald-400"));
    assert.equal(sfw.closest("button")!.textContent?.trim(), "Cerebas");
    assert.equal(button("NSFW provider").getAttribute("aria-pressed"), "true");
    assert.equal(button("Use as SFW").disabled, false, "the same profile may serve multiple roles");
    await remount();
    assert.ok(dom.window.document.querySelector('[role="img"][aria-label="Active NSFW provider"]'));
    assert.equal(button("NSFW provider").getAttribute("aria-pressed"), "true");
  }, undefined, undefined, { separateSfw: true });
});

test("NSFW assignment moves its red indicator between profiles and can be cleared", async () => {
  await render(async (_, { selection, patches }) => {
    await act(async () => button("Other provider").click());
    await act(async () => button("Use as NSFW").click());
    assert.equal(selection.nsfwApiKeyId, "other-profile");
    const indicators = dom.window.document.querySelectorAll('[role="img"][aria-label="Active NSFW provider"]');
    assert.equal(indicators.length, 1);
    assert.equal(indicators[0].closest("button")!.textContent?.trim(), "Other provider");
    await act(async () => button("NSFW provider").click());
    assert.deepEqual(patches[1], { nsfwApiKeyId: null });
    assert.equal(selection.sfwApiKeyId, "sfw-profile");
    assert.equal(selection.nsfwApiKeyId, null);
    assert.equal(dom.window.document.querySelectorAll('[role="img"][aria-label="Active NSFW provider"]').length, 0);
    assert.ok(button("Use as NSFW"));
  }, undefined, undefined, { separateSfw: true, nsfwId: "custom-profile" });
});

test("a failed NSFW save leaves the previous red indicator and SFW assignment intact", async () => {
  await render(async (_, { selection }) => {
    await act(async () => button("Use as NSFW").click());
    assert.deepEqual(selection, { sfwApiKeyId: "sfw-profile", nsfwApiKeyId: "other-profile" });
    assert.equal(dom.window.document.querySelector('[role="img"][aria-label="Active NSFW provider"]')!.closest("button")!.textContent?.trim(), "Other provider");
    assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Endpoint unavailable/);
    assert.equal(button("Use as NSFW").disabled, false);
  }, undefined, undefined, { separateSfw: true, nsfwId: "other-profile", endpointFailure: "Endpoint unavailable" });
});

test("endpoint actions prevent competing SFW and NSFW writes while saving", async () => {
  let finish!: () => void;
  const pendingEndpoint = new Promise<void>(resolve => { finish = resolve; });
  await render(async (_, { patches }) => {
    await act(async () => button("Use as SFW").click());
    assert.equal(button("Use as NSFW").disabled, true);
    assert.equal(button("SFW provider").disabled, true);
    await act(async () => button("Use as NSFW").click());
    assert.equal(patches.length, 1, "the competing NSFW request is blocked");
    await act(async () => finish());
    assert.equal(button("SFW provider").disabled, false);
  }, undefined, undefined, { separateSfw: true, pendingEndpoint });
});


test("one saved profile can serve both SFW and NSFW", async () => {
  await render(async (_, { selection, patches, remount }) => {
    await act(async () => button("Use as NSFW").click());
    assert.deepEqual(selection, { sfwApiKeyId: "custom-profile", nsfwApiKeyId: "custom-profile" });
    assert.deepEqual(patches, [{ nsfwApiKeyId: "custom-profile" }]);
    assert.equal(button("SFW provider").disabled, false);
    await remount();
    for (const label of ["Active SFW provider", "Active NSFW provider"]) {
      assert.equal(dom.window.document.querySelector(`[role="img"][aria-label="${label}"]`)!.closest("button")!.textContent?.trim(), "Featherless");
    }
  });
});

test("only Story assignment updates the current Story model", async () => {
  await render(async (_, { selection }) => {
    await act(async () => button("Use as NSFW").click());
    assert.equal(useConfigStore.getState().selectedModel, "custom/story-model");
    await act(async () => button("Use as SFW").click());
    assert.equal(useConfigStore.getState().selectedModel, "custom/manual/model");
    assert.equal(selection.nsfwApiKeyId, "custom-profile");
  }, undefined, undefined, { separateSfw: true });
});


test("clearing a personal SFW assignment restores the admin model immediately", async () => {
  await render(async (_, { selection }) => {
    await act(async () => button("SFW provider").click());
    assert.equal(selection.sfwApiKeyId, null);
    assert.equal(useConfigStore.getState().selectedModel, "custom/admin-sfw-model");
    assert.ok(dom.window.document.body.textContent?.includes("Admin default"));
  }, undefined, undefined, { sharedDefaultsWithOwnProfile: true });
});
