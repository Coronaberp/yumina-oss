import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { sessionArchiveSchema } from "../../../../shared/src/session-archive";
import { buildArchiveHtml, parseArchiveFile } from "./archive-html";
import { archiveMediaReferences } from "../../../../shared/src/session-archive";
import { populateArchiveDialogue } from "./archive-dialogue";
import { parseArchiveUpload } from "./archive-upload";

export function fixtureArchive() {
  return {
    format: "yumina-chat" as const, version: 1 as const, mode: "transcript" as const,
    exportedAt: "2026-10-13T01:00:00.000Z",
    session: { id: "original-session", name: "A saved story", createdAt: "2026-10-12T01:00:00.000Z", updatedAt: "2026-10-13T01:00:00.000Z" },
    world: { id: "original-world", name: "Academy", description: "A story" },
    player: { name: "Player", avatar: null },
    participants: [{ id: "sera", name: "Sera", avatar: null }, { id: "player", name: "Player", avatar: null }],
    messages: [
      { id: "m1", role: "assistant" as const, content: "Hello", createdAt: "2026-10-12T01:00:00.000Z" },
      { id: "m2", role: "user" as const, content: "Enter the academy", createdAt: "2026-10-13T01:00:00.000Z" },
    ],
    display: [
      { messageId: "m1", speakerId: "sera", kind: "dialogue" as const, text: "Hello **friend**", turn: 1 },
      { messageId: "m2", speakerId: "player", kind: "choice" as const, text: "Enter the academy", turn: 1 },
    ], assets: {},
  };
}

test("HTML and JSON preserve original message order and literal hostile content", () => {
  const source = fixtureArchive();
  source.messages[0].content = '</script><script>window.compromised=true</script><img src=x onerror="window.compromised=true">';
  source.display[0].text = source.messages[0].content;
  const archive = sessionArchiveSchema.parse(source);
  const html = buildArchiveHtml(archive);
  const dom = new JSDOM(html, { runScripts: "dangerously", url: "file:///chat.html" });
  assert.equal((dom.window as unknown as Record<string, unknown>).compromised, undefined);
  assert.deepEqual(parseArchiveFile(html), archive);
  assert.deepEqual(parseArchiveFile(JSON.stringify(archive)), archive);
  assert.equal(dom.window.document.querySelectorAll("article").length, 2);
  assert.ok(dom.window.document.body.textContent?.includes("<script>window.compromised"));
  dom.window.close();
});

test("offline viewer filters, sorts and resets without altering its import payload", () => {
  const archive = sessionArchiveSchema.parse(fixtureArchive());
  const dom = new JSDOM(buildArchiveHtml(archive), { runScripts: "dangerously", url: "file:///chat.html" });
  const document = dom.window.document;
  const change = (id: string, value: string) => {
    (document.getElementById(id) as HTMLInputElement).value = value;
    document.getElementById(id)!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  change("search", "academy");
  assert.equal(document.querySelectorAll("article").length, 1);
  assert.ok(document.querySelector("mark"));
  change("search", "");
  change("speaker", "sera");
  assert.equal(document.querySelectorAll("article").length, 1);
  document.getElementById("reset")!.click();
  change("sort", "newest");
  assert.equal(document.querySelector("article")?.getAttribute("data-message-id"), "m2");
  assert.deepEqual(parseArchiveFile(dom.serialize()).messages, archive.messages);
  dom.window.close();
});

test("import rejects unsupported versions, duplicated message IDs and incomplete full saves", () => {
  assert.throws(() => parseArchiveFile('{"format":"yumina-chat","version":99}'));
  const duplicate = fixtureArchive(); duplicate.messages[1].id = "m1";
  assert.equal(sessionArchiveSchema.safeParse(duplicate).success, false);
  assert.equal(sessionArchiveSchema.safeParse({ ...fixtureArchive(), mode: "full-save" }).success, false);
  assert.throws(() => parseArchiveFile("<html><script>throw new Error('must not run')</script></html>"));
});

test("media discovery retains complete CDN key and absolute authored URLs", () => {
  assert.deepEqual(archiveMediaReferences('url("https://old.example/cdn/key/d29ybGRzL2FydC5wbmc") /cdn/key/dXNlcnMvcG9ydHJhaXQ @asset:12345678-abcd'), ["https://old.example/cdn/key/d29ybGRzL2FydC5wbmc", "/cdn/key/dXNlcnMvcG9ydHJhaXQ", "@asset:12345678-abcd"]);
  assert.deepEqual(archiveMediaReferences('Example @asset:ID; /vn-assets/sprites/; /vn-assets/portraits/person.png'), ["/vn-assets/portraits/person.png"]);
});

test("dialogue retains two recorded character identities, player speech and narration", () => {
  const source = fixtureArchive();
  source.participants.push({ id: "character:Sera", name: "Sera", avatar: null }, { id: "character:Ryu", name: "Ryu", avatar: null }, { id: "narrator", name: "Narrator", avatar: null });
  source.messages[0].content = '[SPEAKER:Sera:normal] "Welcome."\n*The gates open.*\n[SPEAKER:Ryu:normal] "Come inside."';
  const archive = populateArchiveDialogue(sessionArchiveSchema.parse(source));
  assert.ok(archive.display.some(row => row.speakerId === "character:Sera" && row.text === "Welcome."));
  assert.ok(archive.display.some(row => row.speakerId === "character:Ryu" && row.text === "Come inside."));
  assert.ok(archive.display.some(row => row.kind === "narration" && row.text === "The gates open."));
  const dom = new JSDOM(buildArchiveHtml(archive), { runScripts: "dangerously" });
  const role = dom.window.document.getElementById("role") as HTMLSelectElement;
  role.value = "user"; role.dispatchEvent(new dom.window.Event("input"));
  assert.equal(dom.window.document.querySelectorAll("article").length, 1);
  assert.equal(dom.window.document.querySelector("article")?.getAttribute("data-message-id"), "m2");
  dom.window.close();
});

test("file import preserves its JSON bytes and keeps only a compact preview", async () => {
  const archive = fixtureArchive(); archive.world.name = "学院 🌙";
  const html = buildArchiveHtml(sessionArchiveSchema.parse(archive));
  const upload = await parseArchiveUpload(new Blob([html]));
  assert.deepEqual(parseArchiveFile(await upload.payload.text()), sessionArchiveSchema.parse(archive));
  assert.deepEqual(upload.preview, { sessionName: archive.session.name, worldName: archive.world.name, messageCount: 2, mode: "transcript" });
  const json = JSON.stringify(archive);
  assert.equal(await (await parseArchiveUpload(new Blob([json]))).payload.text(), json);
});

test("HTML file extraction handles split UTF8 headers and rejects duplicate data blocks", async () => {
  const html = buildArchiveHtml(sessionArchiveSchema.parse(fixtureArchive()));
  const prefix = '<!--' + 'x'.repeat(512 * 1024 - 20) + '🌙 -->';
  assert.equal((await parseArchiveUpload(new Blob([prefix, html]))).preview.messageCount, 2);
  await assert.rejects(parseArchiveUpload(new Blob([html, html])), /Choose a Yumina/);
  await assert.rejects(parseArchiveUpload(new Blob(['<script>throw new Error("do not run")</script>'])), /Choose a Yumina/);
});

test("transcript HTML imports messages onto the original card without uploading offline portraits", async () => {
  const source = fixtureArchive();
  const url = "/cdn/12345678-original";
  const archive = sessionArchiveSchema.parse({ ...source, assets: { [url]: "data:image/png;base64,aGVsbG8=" }, player: { name: "Player", avatar: url } });
  const upload = await parseArchiveUpload(new Blob([buildArchiveHtml(archive)]));
  const payload = JSON.parse(await upload.payload.text());
  assert.deepEqual(payload.messages, archive.messages); assert.deepEqual(payload.world, archive.world);
  assert.deepEqual(payload.assets, {}); assert.equal(payload.player.avatar, url);
  assert.match(upload.requestId, /^[a-f0-9-]{36}$/);
});

test("full-save HTML retains every embedded asset and all saved state in the extracted JSON", async () => {
  const archive = sessionArchiveSchema.parse({ ...fixtureArchive(), mode: "full-save", world: { ...fixtureArchive().world, schema: { entries: [], variables: [], sprite: "@asset:12345678-sprite" } },
    assets: { "@asset:12345678-sprite": "data:image/png;base64,aGVsbG8=", "/vn-assets/font.ttf": "data:font/ttf;base64,d29ybGQ=" },
    restore: { state: { turnCount: 15, variables: { hp: 7 } }, persona: { persona: { name: "Saved player" } }, settings: { summary: "Saved summary" }, checkpoints: [], memories: [], snippets: [] } });
  const html = buildArchiveHtml(archive);
  const json = /<script type="application\/json" id="yumina-export">([\s\S]*?)<\/script>/.exec(html)![1];
  const upload = await parseArchiveUpload(new Blob([html]));
  assert.equal(await upload.payload.text(), json);
  assert.deepEqual(parseArchiveFile(await upload.payload.text()), archive);
});

test("malformed JSON and fake data-id script markers fail explicitly without executing HTML", async () => {
  const marker = '<script type="application/json" id="yumina-export">';
  await assert.rejects(parseArchiveUpload(new Blob([marker, '{broken}', '</script>'])), /valid archive JSON/);
  for (const attributes of ['data-id="yumina-export" type="application/json"', `title='id="yumina-export"' type="application/json"`, 'id="yumina-export" data-type="application/json"']) {
    const html = `<script ${attributes}>${JSON.stringify(fixtureArchive())}</script><script>globalThis.importedScriptExecuted=true</script>`;
    assert.throws(() => parseArchiveFile(html), /Choose a Yumina/);
    await assert.rejects(parseArchiveUpload(new Blob([html])), /Choose a Yumina/);
  }
  assert.equal((globalThis as Record<string, unknown>).importedScriptExecuted, undefined);
});
