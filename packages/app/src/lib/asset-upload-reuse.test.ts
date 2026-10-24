import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { AssetUploadError, uploadAssetWithPresignedUrl } from "./asset-upload";

const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const explicitId = "a1111111-1111-4111-8111-111111111111";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Request = { url: string; init?: RequestInit };
async function withCrypto(value: unknown, run: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value });
  try { await run(); } finally {
    if (previous) Object.defineProperty(globalThis, "crypto", previous);
    else Reflect.deleteProperty(globalThis, "crypto");
  }
}
function fixture(prepare: unknown = { key: "users/owner/image/staging.png", uploadUrl: "/storage" }) {
  const requests: Request[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); requests.push({ url, init });
    if (url === "/prepare") return Response.json({ data: prepare });
    if (url === "/storage") return new Response(null);
    assert.equal(url, "/register");
    return Response.json({ data: JSON.parse(String(init?.body)) });
  };
  return { requests, fetchImpl };
}
function config(file: File, fetchImpl: typeof fetch) {
  return { file, fetchImpl, prepareUrl: "/prepare", registerUrl: "/register",
    registerBody: ({ key, file: source }: { key: string; file: File }) => ({ key, filename: source.name, sizeBytes: source.size }) };
}

test("complete original image bytes determine both request digests; caller fields cannot forge them", async () => {
  await withCrypto(webcrypto, async () => {
    const f = fixture();
    const file = new File(["pixels\0EXIF:original metadata\0animation:all frames"], "portrait.png", { type: "image/png" });
    const sourceSha256 = digest(await file.text());
    const result = await uploadAssetWithPresignedUrl({ ...config(file, f.fetchImpl),
      prepareBody: { sourceSha256: "f".repeat(64), requestId: explicitId },
      registerBody: ({ key }) => ({ key, filename: file.name, folderId: "folder-a", sourceSha256: "e".repeat(64), requestId: explicitId }),
    });
    assert.equal(JSON.parse(String(f.requests[0]!.init?.body)).sourceSha256, sourceSha256);
    assert.equal(f.requests[1]!.init?.body, file, "the PUT body is the complete original File");
    assert.deepEqual(result, { key: "users/owner/image/staging.png", filename: "portrait.png", folderId: "folder-a", sourceSha256, requestId: explicitId });
    assert.equal(JSON.parse(String(f.requests[0]!.init?.body)).requestId, explicitId);
  });
});

test("verified reuse skips PUT but registers independent names, folders and bindings", async () => {
  await withCrypto(webcrypto, async () => {
    const master = `users/owner/image-masters/${digest("same original")}`;
    const f = fixture({ key: master, reused: true });
    const stages: string[] = [];
    for (const [name, folderId] of [["portrait.png", "covers"], ["page-banner.png", "banners"]]) {
      const file = new File(["same original"], name, { type: "image/png" });
      const result = await uploadAssetWithPresignedUrl<Record<string, unknown>>({ ...config(file, f.fetchImpl),
        onStage: stage => stages.push(stage), registerBody: ({ key }) => ({ key, filename: name, folderId }),
      });
      assert.match(String(result.requestId), uuid);
      const { requestId, ...logical } = result;
      assert.deepEqual(logical, { key: master, filename: name, folderId, sourceSha256: digest("same original") });
      assert.equal(JSON.parse(String(f.requests.at(-2)!.init?.body)).requestId, requestId);
    }
    assert.deepEqual(f.requests.map(r => r.url), ["/prepare", "/register", "/prepare", "/register"]);
    assert.deepEqual(stages, ["prepare", "register", "prepare", "register"]);
    assert.notEqual(JSON.parse(String(f.requests[0]!.init?.body)).requestId, JSON.parse(String(f.requests[2]!.init?.body)).requestId,
      "separate invocations retain independent logical references");
  });
});

test("only an explicit reuse flag and safe relative key permit skipping the storage request", async () => {
  await withCrypto(webcrypto, async () => {
    const file = new File(["source"], "source.png", { type: "image/png" });
    for (const response of [
      { reused: true }, { reused: true, key: "" }, { reused: true, key: "https://other.test/master" },
      { reused: true, key: "/absolute/key" }, { reused: true, key: "users/../other/master" },
      { reused: true, key: "users\\other\\master" }, { reused: true, key: "users/owner/\nmaster" },
      { reused: true, key: "users/owner/master", uploadUrl: "/storage" },
    ]) {
      const f = fixture(response);
      await assert.rejects(uploadAssetWithPresignedUrl(config(file, f.fetchImpl)),
        error => error instanceof AssetUploadError && error.stage === "prepare");
      assert.deepEqual(f.requests.map(r => r.url), ["/prepare"]);
    }
    for (const reused of [undefined, false, "true"]) {
      const f = fixture({ reused, key: "users/owner/staging", uploadUrl: "/storage" });
      await uploadAssetWithPresignedUrl(config(file, f.fetchImpl));
      assert.deepEqual(f.requests.map(r => r.url), ["/prepare", "/storage", "/register"]);
    }
  });
});

test("hash fallback uploads originals without a claimed or caller-supplied digest", async () => {
  const file = new File(["source"], "source.png", { type: "image/png" });
  for (const crypto of [undefined, { subtle: {} }, { subtle: { digest: async () => { throw Error("unsupported"); } } }]) {
    await withCrypto(crypto, async () => {
      const f = fixture();
      const result = await uploadAssetWithPresignedUrl({ ...config(file, f.fetchImpl),
        prepareBody: { sourceSha256: "f".repeat(64) }, registerBody: { sourceSha256: "e".repeat(64) } });
      assert.equal("sourceSha256" in JSON.parse(String(f.requests[0]!.init?.body)), false);
      assert.deepEqual(Object.keys(result as object), ["requestId"]);
      assert.equal(f.requests[1]!.init?.body, file);
    });
  }
  await withCrypto(undefined, async () => {
    const f = fixture({ reused: true, key: "users/owner/master" });
    await assert.rejects(uploadAssetWithPresignedUrl(config(file, f.fetchImpl)), /reuse|prepare/i);
    assert.deepEqual(f.requests.map(r => r.url), ["/prepare"], "a reuse claim without a computed digest is invalid");
  });
});

test("operation IDs match both requests and conflicting caller IDs are rejected", async () => {
  await withCrypto(webcrypto, async () => {
    const file = new File(["source"], "source.png", { type: "image/png" });
    const f = fixture();
    await uploadAssetWithPresignedUrl({ ...config(file, f.fetchImpl), requestId: explicitId });
    assert.equal(JSON.parse(String(f.requests[0]!.init?.body)).requestId, explicitId);
    assert.equal(JSON.parse(String(f.requests[2]!.init?.body)).requestId, explicitId);
    const conflict = "b2222222-2222-4222-8222-222222222222";
    const known = fixture();
    await assert.rejects(uploadAssetWithPresignedUrl({ ...config(file, known.fetchImpl), requestId: explicitId, prepareBody: { requestId: conflict } }), /request ID/i);
    assert.equal(known.requests.length, 0);
    await assert.rejects(uploadAssetWithPresignedUrl({ ...config(file, known.fetchImpl), requestId: "invalid" }), /request ID/i);
    assert.equal(known.requests.length, 0);
    const late = fixture();
    await assert.rejects(uploadAssetWithPresignedUrl({ ...config(file, late.fetchImpl), prepareBody: { requestId: explicitId }, registerBody: { requestId: conflict } }), /request ID/i);
    assert.equal(late.requests.some(r => r.url === "/register"), false);
  });
});

test("large-file hash fallback is a memory bound, never an upload-size limit", async () => {
  await withCrypto(webcrypto, async () => {
    const file = new File(["large input represented without allocating it"], "large.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 17 * 1024 * 1024 });
    Object.defineProperty(file, "arrayBuffer", { value: () => { throw Error("must not allocate a large hashing buffer"); } });
    const f = fixture();
    await uploadAssetWithPresignedUrl(config(file, f.fetchImpl));
    assert.equal("sourceSha256" in JSON.parse(String(f.requests[0]!.init?.body)), false);
    assert.equal(f.requests[1]!.init?.body, file);
    assert.deepEqual(f.requests.map(r => r.url), ["/prepare", "/storage", "/register"]);
  });
});

test("a caller-owned retry ID reconciles a lost acknowledgment without uploading or registering twice", async () => {
  await withCrypto(webcrypto, async () => {
    const file = new File(["original"], "original.png", { type: "image/png" });
    const operationIds: unknown[] = [];
    let committed = false, transfers = 0, registrations = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = input === "/storage" ? null : JSON.parse(String(init?.body));
      if (input === "/prepare") {
        operationIds.push(body.requestId);
        assert.equal(body.sourceSha256, digest("original"));
        return Response.json({ data: committed ? { asset: { id: "logical-upload" } } : { key: "users/owner/staging", uploadUrl: "/storage" } });
      }
      if (input === "/storage") { transfers++; return new Response(null); }
      registrations++; committed = true;
      assert.equal(body.requestId, explicitId); assert.equal(body.sourceSha256, digest("original"));
      throw new TypeError("Registration response disconnected after commit");
    };
    const upload = { ...config(file, fetchImpl), requestId: explicitId };
    await assert.rejects(uploadAssetWithPresignedUrl(upload), /register/i);
    assert.deepEqual(await uploadAssetWithPresignedUrl(upload), { id: "logical-upload" });
    assert.deepEqual(operationIds, [explicitId, explicitId]);
    assert.equal(transfers, 1); assert.equal(registrations, 1);
  });
});

test("cancellation before and during hashing never makes a prepare or storage request", async () => {
  for (const during of ["before", "read", "digest"]) {
    const controller = new AbortController();
    const file = new File(["source"], "source.png", { type: "image/png" });
    if (during === "before") controller.abort();
    if (during === "read") Object.defineProperty(file, "arrayBuffer", { value: async () => { controller.abort(); return new ArrayBuffer(6); } });
    const crypto = during === "digest" ? { subtle: { digest: async () => { controller.abort(); return new ArrayBuffer(32); } } } : webcrypto;
    await withCrypto(crypto, async () => {
      const f = fixture();
      await assert.rejects(uploadAssetWithPresignedUrl({ ...config(file, f.fetchImpl), signal: controller.signal }));
      assert.equal(f.requests.length, 0, during);
    });
  }
});

test("changed metadata changes identity while different names alone do not", async () => {
  await withCrypto(webcrypto, async () => {
    const hashes: unknown[] = [];
    for (const [name, bytes] of [["one.png", "same pixels:metadata-one"], ["two.png", "same pixels:metadata-one"], ["one.png", "same pixels:metadata-two"]]) {
      const f = fixture();
      await uploadAssetWithPresignedUrl(config(new File([bytes], name, { type: "image/png" }), f.fetchImpl));
      hashes.push(JSON.parse(String(f.requests[0]!.init?.body)).sourceSha256);
    }
    assert.equal(hashes[0], digest("same pixels:metadata-one"));
    assert.equal(hashes[1], hashes[0]); assert.notEqual(hashes[2], hashes[0]);
  });
});
