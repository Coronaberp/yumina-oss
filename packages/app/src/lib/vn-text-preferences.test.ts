import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";

test("account saves serialize, preserve unrelated preferences and recover after failure", async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  const { useUserProfileStore } = await import("@/stores/user-profile");
  const { saveVnTextPreferences } = await import("./vn-text-preferences");
  useUserProfileStore.getState().acceptProfile({ id: "test-reader", preferences: { unrelated: "keep" } });
  const originalFetch = globalThis.fetch;
  const bodies: unknown[] = [], release: Array<(response: Response) => void> = [];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Promise(resolve => release.push(resolve)); };
  try {
    const first = saveVnTextPreferences({ dialogue: { size: 30 } });
    const second = saveVnTextPreferences({ dialogue: { size: 36 }, narration: { color: "#ABCDEF" } });
    await setImmediate(); assert.equal(bodies.length, 1);
    useUserProfileStore.setState(state => ({ profile: { ...state.profile!, preferences: { ...state.profile!.preferences, changedMeanwhile: true } } }));
    release.shift()!(new Response("{}", { status: 200 })); await first; await setImmediate(); assert.equal(bodies.length, 2);
    release.shift()!(new Response("{}", { status: 200 })); await second;
    assert.deepEqual(useUserProfileStore.getState().profile!.preferences, { unrelated: "keep", changedMeanwhile: true, vnTextPreferences: { dialogue: { size: 36 }, narration: { color: "#abcdef" } } });
    assert.deepEqual(bodies[1], { preferences: { vnTextPreferences: { dialogue: { size: 36 }, narration: { color: "#abcdef" } } } });
    const failed = saveVnTextPreferences({ narration: { size: 40 } });
    const rejection = assert.rejects(failed, /Could not save/); await setImmediate(); release.shift()!(new Response("{}", { status: 503 })); await rejection;
    assert.equal((useUserProfileStore.getState().profile!.preferences.vnTextPreferences as { dialogue: { size: number } }).dialogue.size, 36);
    const reset = saveVnTextPreferences({}); await setImmediate(); release.shift()!(new Response("{}")); await reset;
    assert.deepEqual(useUserProfileStore.getState().profile!.preferences.vnTextPreferences, { dialogue: {}, narration: {} });
    useUserProfileStore.getState().clear();
    await assert.rejects(saveVnTextPreferences({}), /Sign in/);
  } finally { globalThis.fetch = originalFetch; useUserProfileStore.getState().clear(); }
});
