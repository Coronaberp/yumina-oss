import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import type { Message, SessionData } from "./chat";

const previousFetch = globalThis.fetch;
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
} });

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const stubs: Record<string, string> = {
  "@/lib/auth-guard": "export function handleAuthLoss() {}",
  "@/lib/feedback": "export const feedback = { notice() {}, error() {}, warning() {} };",
  "@/lib/i18n": "export default { t: (key, options) => options?.defaultValue ?? key, language: 'en' };",
  "./i18n": "export default { t: (key, options) => options?.defaultValue ?? key, language: 'en' };",
};
const vite = await createServer({
  root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@": `${appRoot}/src`, "@yumina/engine": `${appRoot}/../engine/src/index.ts` } },
  plugins: [{
    name: "fallback-test-ui-stubs", enforce: "pre",
    resolveId(id) {
      const key = Object.keys(stubs).find(key => key === id || (key.startsWith("@/") && id === key.replace("@", `${appRoot}/src`)));
      return key ? `\0fallback-test:${key}` : null;
    },
    load(id) { return id.startsWith("\0fallback-test:") ? stubs[id.slice("\0fallback-test:".length)] : null; },
  }],
});
const { useChatStore: store } = await vite.ssrLoadModule("/src/stores/chat.ts") as typeof import("./chat");
const { useConfigStore: config } = await vite.ssrLoadModule("/src/stores/config.ts") as typeof import("./config");
const session: SessionData = { id: "s1", worldId: "world", state: { variables: {} }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const opening: Message = { id: "opening", sessionId: session.id, role: "assistant", status: "complete", content: "Welcome", createdAt: new Date().toISOString(), swipes: [{ content: "Welcome", choices: [], createdAt: new Date().toISOString() }], activeSwipeIndex: 0 };
const { useUserProfileStore: profile } = await vite.ssrLoadModule("/src/stores/user-profile.ts") as typeof import("./user-profile");
const { useCreditStore: credits } = await vite.ssrLoadModule("/src/edition/slots.state.ts") as typeof import("@/edition/slots.state");
const sent: Array<Record<string, unknown>> = [];
let backupFails = false;
let actualBackupFailed = false;
beforeEach(() => {
  sent.length = 0; backupFails = false; actualBackupFailed = false;
  profile.setState({ profile: { id: "member", preferences: { activeApiKeyId: "primary" } } as never });
  credits.setState({ provider: "private" });
  config.setState({ selectedModel: "custom/same-model", mixMode: false, modelFallback: { mode: "auto", officialModel: "", privateModel: "custom/same-model", privateKeyId: "backup" } });
  store.setState({ session, messages: [structuredClone(opening)], readOnly: false, isStreaming: false, error: null, modelFallback: null, pendingChoices: [] });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(init?.body as string); sent.push(body);
    if (!body.fallbackApiKeyId || backupFails) {
      const failure = { code: "MODEL_FALLBACK_REQUIRED", error: "Unavailable", userMessageId: "player", fallback: { requestedModel: body.model, reason: "capacity", provider: "private", backupMatchesProfile: actualBackupFailed } };
      return new Response(`event: error\ndata: ${JSON.stringify(failure)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    }
    const reply = { messageId: "reply", userMessageId: "player", content: "Finished scene", rawContent: "Finished scene", choices: [], state: { variables: {} }, swipeIndex: 0, totalSwipes: 1 };
    return new Response(`event: done\ndata: ${JSON.stringify(reply)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  };
});
after(async () => {
  globalThis.fetch = previousFetch;
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  await vite.close();
});
async function settled(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("Fallback did not settle");
}
for (const action of ["send", "continue", "regenerate"] as const) {
  test(`${action} retries the same model on the saved backup connection without changing the primary`, async () => {
    if (action === "send") store.getState().sendMessage("Enter");
    else if (action === "continue") store.getState().continueLastMessage();
    else store.getState().regenerateMessage(opening.id);
    await settled(() => sent.length === 2 && !store.getState().isStreaming);
    assert.equal(sent[0]!.fallbackApiKeyId, undefined);
    assert.equal(sent[1]!.fallbackApiKeyId, "backup");
    assert.equal(sent[1]!.model, "custom/same-model");
    assert.deepEqual(sent[1]!.modelFallback, { requestedModel: "custom/same-model", reason: "capacity", automatic: true, providerChanged: true });
    if (action === "send") assert.equal(sent[1]!.retryMessageId, "player");
    assert.equal(config.getState().selectedModel, "custom/same-model");
    assert.equal(profile.getState().profile!.preferences.activeApiKeyId, "primary");
    assert.equal(store.getState().error, null);
  });
}
test("backup failure stops after one automatic attempt", async () => {
  backupFails = true; store.getState().sendMessage("Enter");
  await settled(() => sent.length === 2 && store.getState().modelFallback?.status === "failed");
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(sent.length, 2);
});
test("asking before another-provider retry supports the same model", async () => {
  config.setState({ modelFallback: { ...config.getState().modelFallback, mode: "ask" } }); store.getState().sendMessage("Enter");
  await settled(() => store.getState().modelFallback?.status === "ask");
  const notice = store.getState().modelFallback!; assert.equal(sent.length, 1);
  store.getState().resolveModelFallback(notice.id, notice.suggestedModel, false, true);
  await settled(() => sent.length === 2 && !store.getState().isStreaming); assert.equal(sent[1]!.fallbackApiKeyId, "backup");
});
test("retry original uses the original connection even when the backup model ID matches", async () => {
  config.setState({ modelFallback: { ...config.getState().modelFallback, mode: "ask" } }); store.getState().sendMessage("Enter");
  await settled(() => store.getState().modelFallback?.status === "ask"); const notice = store.getState().modelFallback!;
  store.getState().resolveModelFallback(notice.id, notice.requestedModel, false, false);
  await settled(() => sent.length === 2 && !store.getState().isStreaming);
  assert.equal(sent[1]!.fallbackApiKeyId, undefined); assert.equal(sent[1]!.modelFallback, undefined);
});
test("an old fallback prompt cannot retry after the account or provider changes", async () => {
  config.setState({ modelFallback: { ...config.getState().modelFallback, mode: "ask" } }); store.getState().sendMessage("Enter");
  await settled(() => store.getState().modelFallback?.status === "ask"); const notice = store.getState().modelFallback!;
  profile.setState({ profile: { id: "other-member", preferences: { activeApiKeyId: "other-key" } } as never });
  store.getState().resolveModelFallback(notice.id, notice.suggestedModel, false, true);
  assert.equal(sent.length, 1); assert.equal(store.getState().modelFallback, null);
});

test("a content-routed failure on the configured backup does not resend the same connection and model", async () => {
  actualBackupFailed = true;
  store.getState().sendMessage("Enter");
  await settled(() => !store.getState().isStreaming && !!store.getState().modelFallback);
  assert.equal(sent.length, 1);
  assert.equal(store.getState().modelFallback!.suggestedModel, "");
});

test("one-turn private model choices do not replace the configured provider backup when asked to remember", async () => {
  config.setState({ modelFallback: { ...config.getState().modelFallback, mode: "ask" } });
  store.getState().sendMessage("Enter");
  await settled(() => store.getState().modelFallback?.status === "ask");
  const notice = store.getState().modelFallback!;
  const saved = { ...config.getState().modelFallback };
  store.getState().resolveModelFallback(notice.id, "custom/one-turn-model", true, true);
  await settled(() => sent.length === 2 && !store.getState().isStreaming);
  assert.deepEqual(config.getState().modelFallback, saved);
  assert.equal(sent[1]!.fallbackApiKeyId, undefined);
});
