import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { clientDom, loadClientModule } from "../../lib/feed-beacon.test-helpers";
import * as storyReturnUrl from "../../lib/story-return-url";

type PreviewSearch = { returnTo?: string; returnKey?: string; adminPreview?: boolean };
type RouteOptions = { validateSearch: (search: Record<string, unknown>) => PreviewSearch; component: () => unknown };

function loadPreviewRoute(search: PreviewSearch = {}, preview: (props: Record<string, unknown>) => null = () => null) {
  return loadClientModule<{ Route: { options: RouteOptions } }>(new URL("./preview.$worldId.tsx", import.meta.url), {
    "@tanstack/react-router": { createFileRoute: () => (options: RouteOptions) => ({
      options, useParams: () => ({ worldId: "private-world" }), useSearch: () => search,
    }) },
    "@/lib/lazy-route-component": { lazyRouteComponent: () => preview },
    "@/lib/story-return-url": storyReturnUrl,
    "lucide-react": { Loader2: () => null },
  }).Route;
}

test("preview route enables admin mode only for explicit true and preserves safe return fields", () => {
  const route = loadPreviewRoute();
  for (const value of [true, "true"]) {
    const search = route.options.validateSearch({ adminPreview: value, returnTo: "/app/hub", returnKey: "return-key-123" });
    assert.equal(search.adminPreview, true, `explicit ${JSON.stringify(value)} must enable admin preview`);
    assert.equal(search.returnTo, "/app/hub");
    assert.equal(search.returnKey, "return-key-123");
  }
  for (const value of [undefined, false, "false", "TRUE", "1", 1, {}, [], ["true"], null]) {
    const search = route.options.validateSearch({ adminPreview: value, returnTo: "https://external.test", returnKey: "invalid!" });
    assert.ok(!search.adminPreview, `${JSON.stringify(value)} must not enable admin preview`);
    assert.equal(search.returnTo, undefined);
    assert.equal(search.returnKey, undefined);
  }
});

test("preview route passes admin mode separately from the return navigation context", async () => {
  const env = clientDom();
  const received: Record<string, unknown>[] = [];
  const route = loadPreviewRoute({ adminPreview: true, returnTo: "/app/hub", returnKey: "return-key-123" }, (props) => {
    received.push(props);
    return null;
  });
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(route.options.component as () => null)));
    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
      worldId: "private-world", adminPreview: true,
      returnContext: { returnTo: "/app/hub", returnKey: "return-key-123" },
    });
  } finally { await act(async () => root.unmount()); env.restore(); }
});

test("WorldPreview forwards explicit admin mode to the real session-start request", async () => {
  const sessionBodies: unknown[] = [];
  const consumed: string[] = [];
  const env = clientDom({ fetch: async (url: string, init?: RequestInit) => {
    if (url === "/api/worlds/private-world") return new Response(JSON.stringify({ data: { id: "private-world", schema: {} } }));
    assert.equal(url, "/api/sessions");
    sessionBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ data: { id: "admin-session" } }));
  } });
  const navigations: unknown[] = [];
  const router = { history: {}, state: { location: { href: "/app/preview/private-world?adminPreview=true" } }, navigate: async (value: unknown) => { navigations.push(value); } };
  const hook = loadClientModule<typeof import("../../features/chat/use-guest-session-start")>(new URL("../../features/chat/use-guest-session-start.ts", import.meta.url), {
    "@tanstack/react-router": { useRouter: () => router },
    "@/lib/discovery-attribution": { consumeDiscoveryHandoff: (worldId: string) => { consumed.push(worldId); }, discoveryAttribution: () => undefined },
  });
  const { WorldPreview } = loadClientModule<typeof import("../../features/chat/world-preview")>(new URL("../../features/chat/world-preview.tsx", import.meta.url), {
    "./use-guest-session-start": hook,
    "react-i18next": { useTranslation: () => ({ t: (key: string) => key }) },
    "@tanstack/react-router": { useRouter: () => router },
    "lucide-react": { ArrowLeft: () => null, Loader2: () => null, LogIn: () => null },
    "@/hooks/use-auth-guard": { useAuthGuard: () => ({ requireAuth: () => {}, isAuthenticated: true }) },
    "@/components/layout/top-bar": { TopBarAccountControls: () => null },
    "./world-renderer": { WorldRenderer: () => null },
    "./variable-key": { makeVariableKeyResolver: () => (value: string) => value },
    "./preview-greetings": { collectPreviewGreetings: () => [] },
    "@yumina/engine": {},
    "@/lib/utils": { safeParseWorldDef: () => undefined },
    "@/lib/asset-url": { absoluteImageUrl: () => "" },
    "@/stores/ui": { useUiStore: (selector: (state: { playZoomPercent: number }) => unknown) => selector({ playZoomPercent: 100 }) },
    "@/stores/audio": {},
    "@/lib/story-return": { navigateToStoryReturn: () => {} },
  });
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(WorldPreview, { worldId: "private-world", adminPreview: true, returnContext: { returnTo: "/app/hub", returnKey: "return-key-123" } } as Parameters<typeof WorldPreview>[0])));
    assert.deepEqual(sessionBodies, [{ worldId: "private-world", adminPreview: true, ephemeral: true }]);
    assert.deepEqual(consumed, [], "the pending discovery handoff belongs to an ordinary play");
    assert.deepEqual(navigations, [{ to: "/app/chat/$sessionId", params: { sessionId: "admin-session" }, search: { moderationGroupKey: undefined, returnTo: "/app/hub", returnKey: "return-key-123" } }]);
  } finally { await act(async () => root.unmount()); env.restore(); }
});
