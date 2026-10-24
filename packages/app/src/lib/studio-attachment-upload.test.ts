import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

async function uploader() {
  assert.ok(existsSync(new URL("./studio-attachment-upload.ts", import.meta.url)), "Studio images must use the common verified upload path");
  return (await import("./studio-attachment-upload")).uploadStudioAttachments;
}
const hash = createHash("sha256").update("original animation and metadata").digest("hex");
const key = `users/owner/image-masters/public/${hash}.anim.png`;
const file = () => new File(["original animation and metadata"], "reference.png", { type: "image/png" });

test("Studio attachment misses send original bytes once and confirm before returning a canonical attachment", async () => {
  const upload = await uploader(), original = file();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith("upload-url")) return Response.json({ data: { key: "studio-chat/owner/staging.png", uploadUrl: "/storage" } });
    if (url === "/storage") return new Response(null);
    assert.equal(url, "/api/studio/upload-confirm");
    return Response.json({ data: { key, url: `/cdn/key/${Buffer.from(key).toString("base64url")}`, name: original.name, mimeType: original.type } });
  };
  const result = await upload([original], { apiBase: "", fetchImpl });
  assert.equal(requests.length, 3, "there is no redundant download-url or duplicate registration call");
  assert.equal(requests[1]!.init?.body, original);
  const prepare = JSON.parse(String(requests[0]!.init?.body)), confirm = JSON.parse(String(requests[2]!.init?.body));
  assert.equal(prepare.fileSize, original.size); assert.equal(prepare.sourceSha256, hash);
  assert.equal(confirm.fileSize, original.size); assert.equal(confirm.sourceSha256, hash);
  assert.equal(confirm.requestId, prepare.requestId); assert.equal(confirm.filename, original.name);
  assert.equal(result[0]!.key, key); assert.equal(result[0]!.name, original.name);
});

test("Studio attachment reuse confirms the owned master without transferring a body", async () => {
  const upload = await uploader(), requests: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push(String(input));
    if (String(input).endsWith("upload-url")) return Response.json({ data: { key, reused: true } });
    assert.equal(String(input), "/api/studio/upload-confirm");
    const body = JSON.parse(String(init?.body)); assert.equal(body.key, key); assert.equal(body.sourceSha256, hash);
    return Response.json({ data: { key, url: `/cdn/key/${Buffer.from(key).toString("base64url")}`, name: body.filename, mimeType: "image/png" } });
  };
  assert.equal((await upload([file()], { apiBase: "", fetchImpl }))[0]!.key, key);
  assert.deepEqual(requests, ["/api/studio/upload-url", "/api/studio/upload-confirm"]);
});

test("Studio upload errors and cancellation never expose an unconfirmed attachment", async () => {
  const upload = await uploader();
  const original = file(), controller = new AbortController(); let requests = 0;
  await assert.rejects(upload([original], { apiBase: "", signal: controller.signal, fetchImpl: async (input) => {
    requests++;
    if (String(input).endsWith("upload-url")) return Response.json({ data: { key, reused: true } });
    return Response.json({ error: "Image hash does not match" }, { status: 409 });
  } }), /hash does not match/);
  assert.equal(requests, 2);
  controller.abort(); requests = 0;
  await assert.rejects(upload([original], { apiBase: "", signal: controller.signal, fetchImpl: async () => { requests++; throw Error("unexpected"); } }));
  assert.equal(requests, 0);
});

test("Studio attachment cancellation during storage or confirmation cannot return a late attachment", async () => {
  const upload = await uploader();
  for (const phase of ["storage", "confirm"]) {
    const controller = new AbortController(), requests: string[] = [], progress: number[] = [];
    await assert.rejects(upload([file()], { apiBase: "", signal: controller.signal, onProgress: value => progress.push(value.loaded),
      fetchImpl: async (input) => {
        requests.push(String(input));
        if (String(input).endsWith("upload-url")) return Response.json({ data: { key: "studio-chat/owner/staging.png", uploadUrl: "/storage" } });
        if (input === "/storage") {
          if (phase === "storage") { controller.abort(); throw new DOMException("Aborted", "AbortError"); }
          return new Response(null);
        }
        controller.abort();
        return Response.json({ data: { key, url: `/cdn/key/${Buffer.from(key).toString("base64url")}`, name: "reference.png", mimeType: "image/png" } });
      } }));
    assert.equal(requests.length, phase === "storage" ? 2 : 3);
    assert.deepEqual(progress, [0], "progress is forwarded without a false completed-transfer event");
  }
});

test("Studio store delegates attachments to the verified helper rather than raw PUT/download logic", () => {
  const source = readFileSync(new URL("../stores/studio.ts", import.meta.url), "utf8");
  assert.ok(/uploadStudioAttachments/.test(source), "the store delegates to the verified helper");
  assert.ok(!/\/api\/studio\/(?:upload-url|download-url)/.test(source), "raw upload/download logic is removed");
});
