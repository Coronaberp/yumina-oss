import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { normalizeStudioChatReferences, latestStudioImageReferences, loadStudioImageReferences, hydrateStudioMessageImages, textOnlyStudioReferenceMessages } from "./studio-image-references.js";
import { harnessTurn } from "./studio-tools/harness-notes.js";

const owner = "reference-owner";
const key = `studio-chat/${owner}/12345678-1234-1234-1234-123456789abc.png`;
const upload = { key, url: "https://untrusted.example/private", name: "reference.png", mimeType: "image/png" };

test("chat references use canonical owned storage keys rather than supplied URLs", () => {
  const refs = normalizeStudioChatReferences(owner, [upload]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.key, key);
  assert.ok(!refs[0]!.url.includes("untrusted.example"));
  const messages = [{ role: "user" as const, content: [{ type: "image_url" as const, image_url: { url: refs[0]!.url } }] }];
  assert.equal(latestStudioImageReferences(owner, messages)[0]!.key, key);
  assert.equal(latestStudioImageReferences(owner, [...messages, harnessTurn("text_only_reply")])[0]!.key, key);
  assert.deepEqual(latestStudioImageReferences(owner, [...messages, { role: "user", content: "A new request without references" }]), []);
});

test("text-only selected agents can retain references for the independent image helper", () => {
  const [ref] = normalizeStudioChatReferences(owner, [upload]);
  const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "Make this blue" }, { type: "image_url" as const, image_url: { url: ref!.url } }] }];
  const textOnly = textOnlyStudioReferenceMessages(messages);
  assert.match(JSON.stringify(textOnly), /Codex image helper receives the actual image/);
  assert.doesNotMatch(JSON.stringify(textOnly), /"image_url"/);
  assert.equal(latestStudioImageReferences(owner, messages)[0]!.key, ref!.key, "Provider adaptation does not replace the stored reference");
});

test("status nudges preserve the reference for the unfinished image request", () => {
  const [ref] = normalizeStudioChatReferences(owner, [upload]);
  const request = { role: "user" as const, content: [{ type: "text" as const, text: "make her happy expression image" },
    { type: "image_url" as const, image_url: { url: ref!.url } }] };
  for (const nudge of ["??? Hello?", "Any update?", "Is it done yet?"]) {
    assert.equal(latestStudioImageReferences(owner, [request, { role: "user", content: nudge }])[0]?.key, key);
  }
  assert.deepEqual(latestStudioImageReferences(owner, [request, { role: "user", content: "Draw a blue landscape" },
    { role: "user", content: "Any update?" }]), [], "Do not cross a different substantive request");
});

test("another account, path traversal and too many references are rejected before reads", async () => {
  assert.throws(() => normalizeStudioChatReferences("other", [upload]), /own uploaded images/);
  assert.throws(() => normalizeStudioChatReferences(owner, [{ ...upload, key: `studio-chat/${owner}/../secret.png` }]), /own uploaded images/);
  assert.throws(() => normalizeStudioChatReferences(owner, Array(6).fill(upload)), /five/);
  let reads = 0;
  await assert.rejects(loadStudioImageReferences("other", [{ key, url: upload.url, name: upload.name }], undefined,
    async () => { reads++; return { buffer: Buffer.from("bad"), contentType: "image/png" }; }), /own uploaded images/);
  assert.equal(reads, 0);
});

test("actual owned image bytes become native image inputs and chat hydration keeps text", async () => {
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 4, background: "gold" } }).png().toBuffer();
  const refs = normalizeStudioChatReferences(owner, [upload]);
  const read = async (_key: string, options?: { maxBytes?: number; signal?: AbortSignal }) => {
    assert.equal(_key, key); assert.equal(options?.maxBytes, 10 * 1024 * 1024);
    return { buffer: bytes, contentType: "image/png" };
  };
  const inputs = await loadStudioImageReferences(owner, refs, undefined, read);
  assert.match(inputs[0]!, /^data:image\/png;base64,/);
  assert.equal((await sharp(Buffer.from(inputs[0]!.split(",")[1]!, "base64")).metadata()).width, 16);
  const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "Make this star blue" }, { type: "image_url" as const, image_url: { url: refs[0]!.url } }] }];
  const hydrated = await hydrateStudioMessageImages(owner, messages, undefined, read);
  assert.equal((hydrated[0]!.content as any[])[0].text, "Make this star blue");
  assert.match((hydrated[0]!.content as any[])[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal((messages[0]!.content[1] as any).image_url.url, refs[0]!.url, "Stored transcript stays compact");
});

test("invalid image bytes and cancelled references fail before native generation", async () => {
  const refs = normalizeStudioChatReferences(owner, [upload]);
  await assert.rejects(loadStudioImageReferences(owner, refs, undefined, async () => ({ buffer: Buffer.from("not an image"), contentType: "image/png" })), /valid image/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(loadStudioImageReferences(owner, refs, controller.signal, async () => assert.fail("Cancelled reads must not start")), { name: "AbortError" });
});
