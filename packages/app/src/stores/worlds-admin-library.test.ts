import assert from "node:assert/strict";
import test from "node:test";
import { cachedFetch } from "../lib/cached-fetch";
import { loadClientModule } from "../lib/feed-beacon.test-helpers";
import type { AdminLibraryItem } from "./worlds";

const adminItem: AdminLibraryItem = {
  id: "01b05b03-98ac-45cc-8a64-ca7a53c97f10", name: "Seiryu Academy",
  thumbnailUrl: "/cdn/seiryu.webp", coverCrop: null, creatorName: "filgachtic",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z",
};

function store() {
  return loadClientModule<typeof import("./worlds")>(new URL("./worlds.ts", import.meta.url), {
    "@/lib/cached-fetch": { cachedFetch },
    "@/lib/feedback": { feedback: { error() {} } },
    "@/lib/i18n": { language: "en", t: (key: string) => key },
    "./library": { useLibraryStore: { getState: () => ({ invalidate() {} }) } },
  }).useWorldsStore;
}

test("world response stores admin metadata separately and an empty response removes it", async () => {
  const worlds = store();
  const originalFetch = globalThis.fetch;
  const own = { id: "own-world", creatorId: "admin" };
  let body: unknown = { data: [own], adminLibraryItems: [adminItem], adminLibraryViewerId: "admin" };
  globalThis.fetch = async () => new Response(JSON.stringify(body));
  try {
    await worlds.getState().fetchWorlds();
    assert.deepEqual(worlds.getState().worlds, [own]);
    assert.deepEqual(worlds.getState().adminLibraryItems, [adminItem]);
    assert.equal(worlds.getState().adminLibraryViewerId, "admin");
    body = { data: [own], adminLibraryItems: [], adminLibraryViewerId: null };
    worlds.setState({ lastFetchedAt: null });
    await worlds.getState().fetchWorlds();
    assert.deepEqual(worlds.getState().adminLibraryItems, []);
    assert.equal(worlds.getState().adminLibraryViewerId, null);
    body = { data: [own] };
    worlds.setState({ lastFetchedAt: null, adminLibraryItems: [adminItem], adminLibraryViewerId: "admin" });
    await worlds.getState().fetchWorlds();
    assert.deepEqual(worlds.getState().adminLibraryItems, []);
    assert.equal(worlds.getState().adminLibraryViewerId, null);
  } finally { globalThis.fetch = originalFetch; }
});

test("401, server failure, and network failure clear cached admin metadata", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const result of [401, 500, "network"] as const) {
      const worlds = store();
      worlds.setState({ adminLibraryItems: [adminItem], adminLibraryViewerId: "admin" });
      globalThis.fetch = async () => {
        if (result === "network") throw new Error("offline");
        return new Response(null, { status: result });
      };
      await worlds.getState().fetchWorlds();
      assert.deepEqual(worlds.getState().adminLibraryItems, [], String(result));
      assert.equal(worlds.getState().adminLibraryViewerId, null, String(result));
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("invalidate clears admin metadata immediately while the new request is pending", async () => {
  const worlds = store();
  const originalFetch = globalThis.fetch;
  let resolve!: (response: Response) => void;
  globalThis.fetch = () => new Promise<Response>(done => { resolve = done; });
  try {
    worlds.setState({ adminLibraryItems: [adminItem], adminLibraryViewerId: "admin" });
    worlds.getState().invalidate();
    assert.deepEqual(worlds.getState().adminLibraryItems, []);
    assert.equal(worlds.getState().adminLibraryViewerId, null);
  } finally {
    resolve(new Response(JSON.stringify({ data: [] })));
    await new Promise<void>(done => setImmediate(done));
    globalThis.fetch = originalFetch;
  }
});
