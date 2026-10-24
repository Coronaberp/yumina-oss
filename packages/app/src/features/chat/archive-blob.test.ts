import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { JSDOM } from "jsdom";
import type { SessionArchive } from "@yumina/shared";
import * as html from "./archive-html";
import { parseArchiveUpload } from "./archive-upload";

const stamp = "2026-10-13T01:00:00.000Z";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fixture(): SessionArchive {
  const assets = Object.fromEntries(Array.from({ length: 107 }, (_, i) => [`@asset:12345678-${i}`, `data:image/png;base64,${Buffer.alloc(64 + i, i).toString("base64")}`]));
  return { format: "yumina-chat", version: 1, mode: "full-save", exportedAt: stamp,
    session: { id: "source-session", name: "海里 🌙", createdAt: stamp, updatedAt: stamp },
    world: { id: "source-world", name: "Archive fixture", description: "A saved world", schema: { entries: [], variables: [], media: Object.keys(assets) } },
    player: { name: "Saved player", avatar: null }, participants: [], display: [], assets,
    messages: Array.from({ length: 7 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? "user" as const : "assistant" as const,
      content: i ? `Saved message ${i}` : '</script><script>globalThis.archivePwned=true</script>' + "海🙂".repeat(65000), createdAt: stamp })),
    restore: { state: { variables: { hp: 7 }, turnCount: 15 }, persona: { persona: { name: "Saved player" }, started: true }, settings: { sessionMemoryPinned: "Keep the promise" }, checkpoints: [], memories: [], snippets: [], continuityNotes: [] } };
}

test("Blob HTML export retains the exact standalone format with bounded string parts and all 107 asset hashes", async () => {
  const archive = fixture(), legacy = html.buildArchiveHtml(archive);
  assert.equal(digest(legacy), "d6321f05d7376dce87282639af434b8022a589e4a06808ef44a512a9b2983df1", "standalone HTML bytes match the pre-change format");
  const buildBlob = (html as typeof html & { buildArchiveHtmlBlob?: (archive: SessionArchive) => Blob }).buildArchiveHtmlBlob;
  assert.equal(typeof buildBlob, "function", "normal downloads need a Blob-parts path without a full HTML-string intermediate");
  const OriginalBlob = globalThis.Blob, parts: number[] = [];
  class ObservedBlob extends OriginalBlob {
    constructor(values: BlobPart[] = [], options?: BlobPropertyBag) {
      if (options?.type === "text/html") parts.push(...values.filter((part): part is string => typeof part === "string").map(part => Buffer.byteLength(part)));
      super(values, options);
    }
  }
  Object.defineProperty(globalThis, "Blob", { configurable: true, writable: true, value: ObservedBlob });
  try {
    const blob = buildBlob!(archive);
    assert.equal(blob.type, "text/html");
    const content = await blob.text();
    assert.equal(content, legacy);
    assert.ok(parts.length > 3); assert.ok(Math.max(...parts) <= 393216, "escaping cannot create an unbounded Blob string part");
    assert.ok(Math.max(...parts) < blob.size / 2);
    const upload = await parseArchiveUpload(blob);
    assert.equal(upload.preview.messageCount, 7); assert.equal(upload.preview.mode, "full-save");
    const restored = html.parseArchiveFile(await upload.payload.text());
    assert.deepEqual(restored.restore, archive.restore);
    assert.deepEqual(restored.messages, archive.messages);
    for (const [key, source] of Object.entries(archive.assets)) assert.equal(digest(Buffer.from(restored.assets[key]!.split(",")[1]!, "base64")), digest(Buffer.from(source.split(",")[1]!, "base64")));
    assert.equal(Object.keys(restored.assets).length, 107);
    console.log(JSON.stringify({ proxy: "Blob construction input string parts, not measured browser memory", htmlBytes: blob.size, legacySingleStringPartBytes: Buffer.byteLength(legacy), maxBlobStringPartBytes: Math.max(...parts), blobParts: parts.length, assets: 107, messages: 7 }));
  } finally { Object.defineProperty(globalThis, "Blob", { configurable: true, writable: true, value: OriginalBlob }); }
});

test("normal archive download passes its Blob directly and returns only the filename", async t => {
  const dom = new JSDOM("<body></body>", { url: "https://fixture.invalid" });
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document"), savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
  t.mock.method(dom.window.HTMLAnchorElement.prototype, "click", () => {});
  const blobs: Blob[] = [];
  t.mock.method(URL, "createObjectURL", (blob: unknown) => { assert.ok(blob instanceof Blob); blobs.push(blob); return "blob:fixture"; });
  t.mock.method(URL, "revokeObjectURL", () => {});
  t.mock.method(globalThis, "setTimeout", () => 0 as unknown as ReturnType<typeof setTimeout>);
  const archive = fixture();
  archive.mode = "transcript"; delete archive.restore; delete archive.world.schema; archive.assets = {}; archive.messages[0]!.content = "Hello";
  archive.participants = [{ id: "player", name: "Saved player", avatar: null }, { id: "narrator", name: "Narrator", avatar: null }];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    assert.equal(String(input), "/api/session-archives/source-session?mode=transcript");
    return Response.json({ data: archive });
  });
  const appRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const vite = await createServer({ root: appRoot, configFile: false, envFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true, watch: null }, resolve: { alias: { "@": `${appRoot}/src` } } });
  try {
    const client = await vite.ssrLoadModule("/src/features/chat/archive-client.ts") as typeof import("./archive-client");
    const existing = new Blob(["Fixture"], { type: "text/html" });
    client.downloadArchiveFile(existing, "fixture.html");
    assert.equal(blobs[0], existing, "an already-built Blob is reused directly");
    const result = await client.downloadSessionArchive("source-session", "transcript");
    assert.deepEqual(Object.keys(result), ["filename"], "the completed UI operation does not retain the large archive and HTML string");
    assert.ok(blobs[1] instanceof Blob); assert.equal(blobs[1]!.type, "text/html");
    assert.equal(html.parseArchiveFile(await blobs[1]!.text()).messages.length, 7);
    assert.equal(dom.window.document.querySelectorAll("a").length, 0);
  } finally {
    await vite.close(); dom.window.close();
    if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument); else Reflect.deleteProperty(globalThis, "document");
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
  }
});
