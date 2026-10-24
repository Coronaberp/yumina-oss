import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import * as attribution from "../../lib/discovery-attribution";
import { clientDom, loadClientModule } from "../../lib/feed-beacon.test-helpers";

test("guest sign-in failure stays on the preview, retries once, and ignores abandoned requests", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test/app/preview/world-1" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map([...Object.keys(globals), "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const requests: ((response: Response) => void)[] = [];
  globalThis.fetch = () => new Promise<Response>((resolve) => requests.push(resolve));
  const navigations: unknown[] = [];
  const router = { state: { location: { href: "/app/preview/world-1" } }, navigate: (options: unknown) => { navigations.push(options); return Promise.resolve(); } };
  const require = createRequire(import.meta.url);
  const module = { exports: {} as { useGuestSessionStart: (ready: boolean, id: string, context: object) => { startError: boolean; retryStart: () => void } } };
  const source = readFileSync(new URL("./use-guest-session-start.ts", import.meta.url), "utf8").replace("import.meta.env.VITE_API_URL", '""');
  new Function("require", "module", "exports", transform(source, { transforms: ["typescript", "imports"] }).code)(
    (id: string) => id === "@tanstack/react-router" ? { useRouter: () => router }
      : id === "@/lib/discovery-attribution" ? attribution : require(id), module, module.exports,
  );
  const context = { returnTo: "/app/users/creator", returnKey: "original-return-key" };
  const Host = () => {
    const { startError, retryStart } = module.exports.useGuestSessionStart(true, "world-1", context);
    return createElement("button", { onClick: retryStart }, startError ? "Retry" : "Starting");
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(StrictMode, {}, createElement(Host))));
    assert.equal(requests.length, 1, "StrictMode must not create duplicate sessions");
    await act(async () => requests[0]!(new Response("{}", { status: 500 })));
    assert.equal(dom.window.document.querySelector("button")!.textContent, "Retry");
    assert.deepEqual(navigations, [], "a failure must not route to Discover");
    await act(async () => dom.window.document.querySelector("button")!.click());
    assert.equal(requests.length, 2);
    await act(async () => requests[1]!(new Response(JSON.stringify({ data: { id: "session-1" } }))));
    assert.deepEqual(navigations, [{ to: "/app/chat/$sessionId", params: { sessionId: "session-1" }, search: { moderationGroupKey: undefined, ...context } }]);
    await act(async () => dom.window.document.querySelector("button")!.click());
    assert.equal(requests.length, 2, "retry after success cannot create another session");
    await act(async () => root.render(null));
    await act(async () => root.render(createElement(Host)));
    await act(async () => root.render(null));
    await act(async () => requests[2]!(new Response(JSON.stringify({ data: { id: "abandoned-session" } }))));
    assert.equal(navigations.length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("guest auto-start consumes one exact-target origin across login, StrictMode and failed-request retry", async () => {
  const requests: Array<{ body: Record<string, unknown>; resolve: (response: Response) => void }> = [];
  const env = clientDom({ fetch: (_url: string, init: RequestInit) => new Promise<Response>(resolve => requests.push({ body: JSON.parse(String(init.body)), resolve })) });
  const consumed: string[] = [];
  const navigations: unknown[] = [];
  let navigationFails = true;
  const router = { state: { location: { href: "/app/preview/translation-a" } }, navigate: async (value: unknown) => {
    navigations.push(value);
    if (navigationFails) throw new Error("navigation failed after session creation");
  } };
  const { useGuestSessionStart } = loadClientModule<typeof import("./use-guest-session-start")>(new URL("./use-guest-session-start.ts", import.meta.url), {
    "@tanstack/react-router": { useRouter: () => router },
    "@/lib/discovery-attribution": { ...attribution, consumeDiscoveryHandoff: (worldId: string) => { consumed.push(worldId); return attribution.consumeDiscoveryHandoff(worldId); } },
  });
  const original = { worldId: "original-a", surface: "recommended", position: 6001, feedRequestId: "page-a", attributionToken: "receipt-a" };
  const context = { returnTo: "/app/hub", returnKey: "hub" };
  const Host = ({ ready, worldId }: { ready: boolean; worldId: string }) => {
    const state = useGuestSessionStart(ready, worldId, context);
    return createElement("button", { onClick: state.retryStart }, state.startError ? "Retry" : "Starting");
  };
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  const render = (ready: boolean, worldId: string) => act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { ready, worldId }))));
  try {
    attribution.rememberDiscoveryHandoff("translation-a", original);
    await render(false, "translation-a");
    assert.deepEqual(consumed, [], "guest rendering alone does not consume or create a session");
    assert.equal(requests.length, 0);
    await act(async () => root.render(null));
    await render(true, "translation-a");
    assert.deepEqual(consumed, ["translation-a"]);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body, { worldId: "translation-a", discoveryAttribution: { token: "receipt-a", worldId: "original-a" } });
    await act(async () => env.dom.window.document.querySelector("button")!.click());
    assert.equal(requests.length, 1, "an in-flight start cannot be duplicated by Retry");
    attribution.rememberDiscoveryHandoff("translation-a", { ...original, attributionToken: "later-page" });
    attribution.rememberDiscoveryHandoff("other-target", { ...original, worldId: "other-original", attributionToken: "other-receipt" });
    await act(async () => requests[0].resolve(new Response("{}", { status: 503 })));
    await act(async () => env.dom.window.document.querySelector("button")!.click());
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].body, requests[0].body, "retry retains the first immutable original-card receipt");
    assert.deepEqual(consumed, ["translation-a"], "retry does not consume a replacement handoff");
    router.state.location.href = "/app/preview/unrelated";
    await render(true, "unrelated");
    assert.deepEqual(requests[2].body, { worldId: "unrelated" }, "another story cannot inherit the previous flow's origin");
    assert.deepEqual(consumed, ["translation-a", "unrelated"]);
    await act(async () => requests[1].resolve(new Response(JSON.stringify({ data: { id: "abandoned" } }))));
    assert.equal(navigations.length, 0);
    await act(async () => requests[2].resolve(new Response(JSON.stringify({ data: { id: "unrelated-session" } }))));
    assert.equal(navigations.length, 1);
    navigationFails = false;
    await act(async () => env.dom.window.document.querySelector("button")!.click());
    assert.equal(requests.length, 3, "a failed navigation retries the created session instead of creating another");
    assert.equal(navigations.length, 2);
    assert.deepEqual(navigations[1], navigations[0]);
    assert.equal(attribution.consumeDiscoveryHandoff("other-target")?.worldId, "other-original");
  } finally { await act(async () => root.unmount()); env.restore(); }
});

function adminPreviewHarness() {
  const requests: Array<{ body: Record<string, unknown>; resolve: (response: Response) => void }> = [];
  const env = clientDom({ fetch: (_url: string, init: RequestInit) => new Promise<Response>(resolve => requests.push({ body: JSON.parse(String(init.body)), resolve })) });
  const consumed: string[] = [];
  const navigations: unknown[] = [];
  let navigationFails = false;
  let currentState: { startError: boolean; retryStart: () => void };
  const router = { state: { location: { href: "/app/preview/private-card?adminPreview=true" } }, navigate: async (value: unknown) => {
    navigations.push(value);
    if (navigationFails) throw new Error("navigation failed after session creation");
  } };
  const { useGuestSessionStart } = loadClientModule<typeof import("./use-guest-session-start")>(new URL("./use-guest-session-start.ts", import.meta.url), {
    "@tanstack/react-router": { useRouter: () => router },
    "@/lib/discovery-attribution": { ...attribution, consumeDiscoveryHandoff: (worldId: string) => { consumed.push(worldId); return attribution.consumeDiscoveryHandoff(worldId); } },
  });
  const context = { returnTo: "/app/hub", returnKey: "hub" };
  const Host = ({ adminPreview }: { adminPreview: boolean }) => {
    currentState = useGuestSessionStart(true, "private-card", context, adminPreview);
    return createElement("button", { onClick: currentState.retryStart }, currentState.startError ? "Retry" : "Starting");
  };
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  return {
    ...env, requests, consumed, navigations, router, context,
    render: (adminPreview: boolean) => act(async () => root.render(createElement(StrictMode, {}, createElement(Host, { adminPreview })))),
    retry: () => act(async () => currentState.retryStart()),
    resolve: (index: number, id: string) => act(async () => requests[index].resolve(new Response(JSON.stringify({ data: { id } })))),
    fail: (index: number) => act(async () => requests[index].resolve(new Response("{}", { status: 503 }))),
    failNavigation: (value: boolean) => { navigationFails = value; },
    unmount: () => act(async () => root.render(null)),
    cleanup: async () => { await act(async () => root.unmount()); env.restore(); },
  };
}

test("admin preview creates one ephemeral session in StrictMode without consuming discovery attribution", async () => {
  const h = adminPreviewHarness();
  const receipt = { worldId: "original-card", surface: "recommended", position: 2, feedRequestId: "admin-page", attributionToken: "admin-receipt" };
  try {
    attribution.rememberDiscoveryHandoff("private-card", receipt);
    await h.render(true);
    assert.equal(h.requests.length, 1, "StrictMode must reuse the admin creation request");
    assert.deepEqual(h.requests[0].body, { worldId: "private-card", adminPreview: true, ephemeral: true });
    assert.deepEqual(h.consumed, [], "admin preview must not consume an ordinary discovery handoff");
    await h.retry();
    assert.equal(h.requests.length, 1, "Retry cannot duplicate an in-flight admin session");
    await h.resolve(0, "admin-session");
    assert.deepEqual(h.navigations, [{ to: "/app/chat/$sessionId", params: { sessionId: "admin-session" }, search: { moderationGroupKey: undefined, ...h.context } }]);
    await h.retry();
    assert.equal(h.requests.length, 1, "Retry after success cannot create another admin session");
    assert.equal(attribution.consumeDiscoveryHandoff("private-card")?.attributionToken, "admin-receipt");
  } finally { await h.cleanup(); }
});

test("admin preview explicitly retries failed creation with the same ephemeral body and reuses a created session after navigation failure", async () => {
  const h = adminPreviewHarness();
  try {
    await h.render(true);
    await h.fail(0);
    assert.equal(h.dom.window.document.querySelector("button")!.textContent, "Retry");
    assert.equal(h.requests.length, 1, "failure does not automatically retry");
    await h.retry();
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests.map(request => request.body), [
      { worldId: "private-card", adminPreview: true, ephemeral: true },
      { worldId: "private-card", adminPreview: true, ephemeral: true },
    ]);
    assert.deepEqual(h.consumed, []);
    h.failNavigation(true);
    await h.resolve(1, "created-admin-session");
    assert.equal(h.dom.window.document.querySelector("button")!.textContent, "Retry");
    h.failNavigation(false);
    await h.retry();
    assert.equal(h.requests.length, 2, "navigation retry reuses the resolved session ID");
    assert.equal(h.navigations.length, 2);
    assert.deepEqual(h.navigations[1], h.navigations[0]);
    await h.retry();
    assert.equal(h.requests.length, 2);
  } finally { await h.cleanup(); }
});

test("changing the same preview target from ordinary to admin abandons the ordinary request", async () => {
  const h = adminPreviewHarness();
  try {
    attribution.rememberDiscoveryHandoff("private-card", { worldId: "source-card", surface: "recommended", position: 1, feedRequestId: "ordinary-page", attributionToken: "ordinary-receipt" });
    await h.render(false);
    assert.deepEqual(h.requests[0].body, { worldId: "private-card", discoveryAttribution: { token: "ordinary-receipt", worldId: "source-card" } });
    await h.render(true);
    assert.equal(h.requests.length, 2, "mode is part of the creation request identity");
    assert.deepEqual(h.requests[1].body, { worldId: "private-card", adminPreview: true, ephemeral: true });
    assert.deepEqual(h.consumed, ["private-card"]);
    await h.resolve(0, "old-ordinary-session");
    assert.deepEqual(h.navigations, [], "a late response from the previous mode cannot navigate");
    await h.resolve(1, "new-admin-session");
    assert.equal(h.navigations.length, 1);
    assert.deepEqual((h.navigations[0] as { params: unknown }).params, { sessionId: "new-admin-session" });
  } finally { await h.cleanup(); }
});

test("changing admin preview to ordinary consumes its pending handoff and ignores late admin responses", async () => {
  const h = adminPreviewHarness();
  try {
    attribution.rememberDiscoveryHandoff("private-card", { worldId: "source-card", surface: "recommended", position: 1, feedRequestId: "ordinary-page", attributionToken: "pending-receipt" });
    await h.render(true);
    await h.render(false);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[0].body, { worldId: "private-card", adminPreview: true, ephemeral: true });
    assert.deepEqual(h.requests[1].body, { worldId: "private-card", discoveryAttribution: { token: "pending-receipt", worldId: "source-card" } });
    assert.deepEqual(h.consumed, ["private-card"]);
    await h.resolve(0, "old-admin-session");
    assert.deepEqual(h.navigations, []);
    await h.unmount();
    await h.resolve(1, "abandoned-ordinary-session");
    assert.deepEqual(h.navigations, [], "unmounted ordinary request cannot navigate");
  } finally { await h.cleanup(); }
});

test("admin preview ignores a successful response after leaving its source URL", async () => {
  const h = adminPreviewHarness();
  try {
    await h.render(true);
    assert.deepEqual(h.requests[0].body, { worldId: "private-card", adminPreview: true, ephemeral: true });
    h.router.state.location.href = "/app/hub";
    await h.resolve(0, "admin-session-after-leaving");
    assert.deepEqual(h.navigations, []);
  } finally { await h.cleanup(); }
});
