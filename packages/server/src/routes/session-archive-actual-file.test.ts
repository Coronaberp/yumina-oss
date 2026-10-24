/** Opt-in, isolated verification of the user-supplied archive. Never executes HTML. */
import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test, after, mock } from "node:test";
import { openAsBlob, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { replaceArchiveMediaReferences } from "@yumina/shared";
import { db } from "../db/index.js";
import { assets, imageMasters as imageMasterRows, messages, playSessions, user, worlds } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { STORAGE_DIR } from "../lib/env.js";
import { getObjectBuffer, headObject, putObject } from "../lib/s3.js";
import { imageMasters } from "../lib/image-masters.js";
import { createImageMasterService } from "../lib/image-master-service.js";
import { encodeImageMaster } from "../lib/image-master-envelope.js";
import { requestBodyLimit } from "../middleware/request-body-limit.js";
import { sessionArchiveRoutes } from "./session-archives.js";
import { parseArchiveUpload } from "../../../app/src/features/chat/archive-upload.js";
import { parseArchiveFile } from "../../../app/src/features/chat/archive-html.js";
import { importArchivePayload, ARCHIVE_CHUNK_BYTES } from "../../../app/src/features/chat/archive-import-client.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown): string => sha(JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === "object"
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) ?? "undefined");
function normalized(value: unknown, refs: Map<string, string>): unknown {
  if (typeof value === "string") return refs.get(value) ?? replaceArchiveMediaReferences(value, refs);
  if (Array.isArray(value)) return value.map(item => normalized(item, refs));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item, refs)]));
  return value;
}
after(async () => { mock.restoreAll(); if ("close" in db.$client) await db.$client.close(); });

test("actual Seiryu HTML restores seven messages, all asset hashes and saved state once in an isolated destination", { skip: !process.env.YUMINA_REAL_ARCHIVE_FILE }, async t => {
  let phase = "start";
  const started = performance.now(), cpu = process.cpuUsage();
  const mark = (name: string) => { phase = name; const usage = process.cpuUsage(cpu); console.log(JSON.stringify({ event: "archive-phase", name, elapsedMs: Math.round(performance.now() - started), cpuUserMs: usage.user / 1000, cpuSystemMs: usage.system / 1000, rssBytes: process.memoryUsage().rss })); };
  const originalFetch = globalThis.fetch;
  try {
    const variant = process.env.YUMINA_IMAGE_MASTER_VARIANT ?? "production-l1";
    assert.ok(variant === "raw-control" || variant === "production-l1");
    const metric = () => ({ calls: 0, wallMs: 0, cpuUserMs: 0, cpuSystemMs: 0 });
    const observation = { variant, store: metric(), verifiedOriginal: metric(), codec: { ...metric(), inputBytes: 0, outputBytes: 0, gzipCount: 0 }, write: { ...metric(), bytes: 0 } };
    const clock = () => ({ time: performance.now(), cpu: process.cpuUsage() });
    const accumulate = (target: ReturnType<typeof metric>, start: ReturnType<typeof clock>) => {
      const usage = process.cpuUsage(start.cpu); target.calls++; target.wallMs += performance.now() - start.time;
      target.cpuUserMs += usage.user / 1000; target.cpuSystemMs += usage.system / 1000;
    };
    const observedService = createImageMasterService(db, {
      async encode(bytes, options) {
        const start = clock(); observation.codec.inputBytes += bytes.length;
        try {
          const sourceSha256 = variant === "raw-control" ? sha(bytes) : null;
          const encoded = sourceSha256 ? { bytes, sourceSha256, storedSha256: sourceSha256, originalSize: bytes.length, storedSize: bytes.length }
            : await encodeImageMaster(bytes, options);
          observation.codec.outputBytes += encoded.storedSize;
          if ("contentEncoding" in encoded && encoded.contentEncoding === "gzip") observation.codec.gzipCount++;
          return encoded;
        } finally { accumulate(observation.codec, start); }
      },
      async write(key, bytes, mimeType, options) {
        const start = clock(); observation.write.bytes += bytes.length;
        try { await putObject(key, bytes, mimeType, options); }
        finally { accumulate(observation.write, start); }
      },
    });
    // Keep the real registry, validators, random keys and transaction path. Only
    // the factory's existing codec/write dependencies are observed in this test.
    t.mock.method(imageMasters, "store", async (...args: Parameters<typeof imageMasters.store>) => {
      const start = clock(); try { return await observedService.store(...args); }
      finally { accumulate(observation.store, start); }
    });
    t.mock.method(imageMasters, "storeVerifiedOriginal", async (...args: Parameters<typeof imageMasters.storeVerifiedOriginal>) => {
      const start = clock(); try { return await observedService.storeVerifiedOriginal(...args); }
      finally { accumulate(observation.verifiedOriginal, start); }
    });
    mark("file-hash");
    const file = await openAsBlob(process.env.YUMINA_REAL_ARCHIVE_FILE!, { type: "text/html" });
    assert.equal(file.size, 209_676_955, "only the reviewed archive is accepted");
    const hasher = createHash("sha256");
    for await (const bytes of createReadStream(process.env.YUMINA_REAL_ARCHIVE_FILE!)) hasher.update(bytes);
    const sourceFileSha256 = hasher.digest("hex");
    mark("inert-json-extraction");
    const upload = await parseArchiveUpload(file);
    assert.equal(upload.preview.mode, "full-save"); assert.equal(upload.preview.messageCount, 7);
    globalThis.gc?.();
    mark("source-integrity-manifest");
    const source = parseArchiveFile(await upload.payload.text());
    const sourceRefs = new Map<string, string>([[source.session.id, "SESSION"], [source.world.id, "WORLD"]]);
    source.messages.forEach((message, index) => sourceRefs.set(message.id, `MESSAGE-${index}`));
    const expectedAssets = new Map<string, { hash: string; bytes: number; mime: string }>();
    const sourceAssetRows: Array<{ key: string; hash: string }> = [];
    for (const [key, data] of Object.entries(source.assets)) {
      const match = /^data:([^;]+);base64,(.*)$/.exec(data);
      assert.ok(match, "embedded asset is a data URL");
      const bytes = Buffer.from(match[2]!, "base64"), hash = sha(bytes), token = `MEDIA-${hash}`;
      expectedAssets.set(sha(data), { hash, bytes: bytes.length, mime: match[1]! });
      sourceAssetRows.push({ key, hash }); sourceRefs.set(key, token); sourceRefs.set(data, token);
      if (key.startsWith("@asset:")) sourceRefs.set(`/cdn/${key.slice(7)}`, token);
    }
    const expectedState = normalized(source.restore?.state, sourceRefs);
    const expectedMessages = source.messages.map(message => ({ role: message.role, content: normalized(message.content, sourceRefs),
      swipes: normalized(message.swipes ?? [], sourceRefs), stateSnapshot: normalized(message.stateSnapshot ?? undefined, sourceRefs) }));
    const sourceMessages = source.messages.map(message => message.id);
    const expectedPersonaNameHash = digest(source.restore?.persona?.persona && (source.restore.persona.persona as Record<string, unknown>).name);
    const expectedAssetManifest = [...expectedAssets.values()].sort((a, b) => a.hash.localeCompare(b.hash));
    assert.equal(expectedAssets.size, 107);
    // Drop the large media strings before the route parses its file-backed payload.
    for (const key of Object.keys(source.assets)) delete source.assets[key];
    for (const key of [...sourceRefs.keys()]) if (key.startsWith("data:")) sourceRefs.delete(key);
    globalThis.gc?.();
    mark("isolated-chunked-import");
    const owner = crypto.randomUUID();
    await db.insert(user).values({ id: owner, name: "Archive verification fixture", email: `${owner}@test.invalid`, emailVerified: true });
    mock.method(auth.api, "getSession", async () => ({ user: { id: owner }, session: { id: "isolated-archive", userId: owner, expiresAt: new Date(Date.now() + 60000) } }));
    const app = new Hono(); app.use("*", requestBodyLimit); app.route("/api/session-archives", sessionArchiveRoutes);
    let chunks = 0, completions = 0, uploaded = 0, inFlight = 0, directImports = 0, requests = 0;
    const requestPhases = { initialization: metric(), chunkUpload: metric(), finalization: metric() };
    globalThis.fetch = async (input, init) => {
      assert.equal(inFlight++, 0, "upload requests remain sequential"); requests++;
      try {
        const path = String(input); assert.ok(path.startsWith("/api/session-archives/"), "all requests stay in-process");
        if (init?.method === "PUT") { const size = (init.body as Blob).size; assert.ok(size <= ARCHIVE_CHUNK_BYTES); chunks++; uploaded += size; }
        if (path.endsWith("/complete")) completions++;
        if (path.endsWith("/import")) directImports++;
        const requestMetric = init?.method === "PUT" ? requestPhases.chunkUpload : path.endsWith("/complete") ? requestPhases.finalization : requestPhases.initialization;
        const start = clock();
        try { return await app.request(path, init); }
        finally { accumulate(requestMetric, start); }
      } finally { inFlight--; }
    };
    const result = await importArchivePayload(upload.payload, { requestId: upload.requestId });
    assert.equal(uploaded, upload.payload.size); assert.equal(completions, 1); assert.equal(directImports, 0);
    assert.equal(chunks, Math.ceil(upload.payload.size / ARCHIVE_CHUNK_BYTES));
    mark("restored-integrity");
    const savedAssets = await db.select().from(assets).where(eq(assets.worldId, result.worldId));
    mark("asset-integrity");
    assert.equal(savedAssets.length, expectedAssets.size);
    const destinationRefs = new Map<string, string>([[result.sessionId, "SESSION"], [result.worldId, "WORLD"]]);
    const pendingHashes = expectedAssetManifest.map(row => row.hash), actualManifest: typeof expectedAssetManifest = [];
    const physicalManifest: Array<{ sourceSha256: string; storedSha256: string; storedBytes: number; decodedBytes: number; contentType: string; contentEncoding: string | null }> = [];
    const seenKeys = new Set<string>();
    for (const asset of savedAssets) {
      // The file API returns original bytes; physical image objects can be gzip envelopes.
      const { buffer: bytes, contentType } = await getObjectBuffer(asset.url, { maxBytes: asset.sizeBytes! });
      const hash = sha(bytes), index = pendingHashes.indexOf(hash);
      assert.ok(index >= 0, "stored media hash belongs to the source manifest"); pendingHashes.splice(index, 1);
      assert.equal(bytes.length, asset.sizeBytes);
      actualManifest.push({ hash, bytes: bytes.length, mime: asset.mimeType! });
      destinationRefs.set(`@asset:${asset.id}`, `MEDIA-${hash}`); destinationRefs.set(`/cdn/${asset.id}`, `MEDIA-${hash}`);
      if (!seenKeys.has(asset.url)) {
        seenKeys.add(asset.url);
        const metadata = await headObject(asset.url), physical = await stat(join(STORAGE_DIR, asset.url));
        const hasher = createHash("sha256");
        for await (const chunk of createReadStream(join(STORAGE_DIR, asset.url))) hasher.update(chunk);
        const storedSha256 = hasher.digest("hex");
        assert.equal(metadata.contentLength, physical.size, "HEAD describes physical storage bytes");
        assert.equal(contentType, metadata.contentType);
        if (asset.mimeType!.startsWith("image/")) {
          assert.equal(metadata.sourceSha256, hash, "master source hash identifies decoded original bytes");
          assert.equal(metadata.storedSha256, storedSha256, "master stored hash identifies the physical envelope");
          assert.equal(metadata.decodedLength, bytes.length);
        }
        physicalManifest.push({ sourceSha256: hash, storedSha256, storedBytes: physical.size, decodedBytes: bytes.length, contentType: metadata.contentType, contentEncoding: metadata.contentEncoding ?? null });
      }
    }
    assert.equal(pendingHashes.length, 0); actualManifest.sort((a, b) => a.hash.localeCompare(b.hash));
    assert.equal(digest(actualManifest), digest(expectedAssetManifest), "all media bytes/MIME types are preserved");
    const masters = await db.select().from(imageMasterRows).where(eq(imageMasterRows.userId, owner));
    const expectedMasterCount = new Set(expectedAssetManifest.filter(row => row.mime.startsWith("image/")).map(row => row.hash)).size;
    assert.equal(masters.length, expectedMasterCount, "unique image masters remain separate from logical asset rows");
    mark("message-integrity");
    const savedMessages = await db.select().from(messages).where(eq(messages.sessionId, result.sessionId)).orderBy(asc(messages.createdAt), asc(messages.id));
    assert.equal(savedMessages.length, 7);
    savedMessages.forEach((message, index) => destinationRefs.set(message.id, `MESSAGE-${index}`));
    const actualMessages = savedMessages.map(message => ({ role: message.role, content: normalized(message.content, destinationRefs),
      swipes: normalized(message.swipes ?? [], destinationRefs), stateSnapshot: normalized(message.stateSnapshot ?? undefined, destinationRefs) }));
    const messageDigests = actualMessages.map((message, index) => Object.fromEntries(Object.entries(message)
      .map(([key, value]) => [key, { actual: digest(value), expected: digest((expectedMessages[index] as Record<string, unknown>)[key]) }])));
    console.log(JSON.stringify({ event: "archive-message-digests", rows: messageDigests }));
    assert.equal(digest(actualMessages), digest(expectedMessages), "messages, swipes and snapshots are preserved after identifier remapping");
    mark("state-integrity");
    const [session] = await db.select().from(playSessions).where(eq(playSessions.id, result.sessionId));
    assert.equal(digest(normalized(session!.state, destinationRefs)), digest(expectedState), "saved state is preserved after identifier remapping");
    mark("persona-integrity");
    assert.equal(digest(session!.sessionPersona?.persona?.name), expectedPersonaNameHash, "saved persona identity is retained");
    const [world] = await db.select().from(worlds).where(eq(worlds.id, result.worldId));
    assert.equal(world!.status, "draft"); assert.equal(world!.creatorId, owner);
    assert.notEqual(result.worldId, source.world.id); assert.notEqual(result.sessionId, source.session.id);
    mark("durable-retry");
    const before = { requests, chunks, completions, assets: savedAssets.length, sessions: (await db.select().from(playSessions)).length };
    // Exercise durable server reconciliation rather than the browser module's in-memory promise cache.
    const retried = await app.request(`/api/session-archives/uploads/${upload.requestId}/complete`, { method: "POST" });
    assert.equal(retried.status, 201);
    const retryResult = await retried.json() as { data: { sessionId: string; worldId: string } };
    assert.equal(digest(retryResult.data), digest(result));
    assert.equal((await db.select().from(assets)).length, before.assets);
    assert.equal((await db.select().from(playSessions)).length, before.sessions);
    assert.equal((await db.select().from(imageMasterRows)).length, masters.length);
    const usage = process.cpuUsage(cpu);
    console.log(JSON.stringify({ event: "archive-result", passed: true, sourceFileSha256, htmlBytes: file.size, jsonBytes: upload.payload.size,
      messages: savedMessages.length, uniqueAssets: savedAssets.length, decodedAssetBytes: actualManifest.reduce((sum, asset) => sum + asset.bytes, 0),
      assetManifestSha256: digest(actualManifest), normalizedMessagesSha256: digest(actualMessages), normalizedStateSha256: digest(expectedState),
      logicalAssetCount: savedAssets.length, uniqueMasterCount: masters.length, uniquePhysicalObjectCount: seenKeys.size,
      physicalStoredBytes: physicalManifest.reduce((sum, object) => sum + object.storedBytes, 0),
      gzipObjectCount: physicalManifest.filter(object => object.contentEncoding === "gzip").length,
      rawObjectCount: physicalManifest.filter(object => object.contentEncoding === null).length,
      physicalMetadataManifestSha256: digest(physicalManifest.sort((a, b) => a.sourceSha256.localeCompare(b.sourceSha256))),
      imageMasterObservation: { ...observation, storeIntervalRemainderWallMs: observation.store.wallMs - observation.codec.wallMs - observation.write.wallMs,
        qualifier: "Nested process CPU intervals are observational, not exclusive profiler attribution. Store remainder includes DB, hashing, format detection and JS. Image-master write counts exclude the one nonimage font." },
      requestPhases,
      chunks, completions, requests, sourceMessageCount: sourceMessages.length, sourceAssetReferenceCount: sourceAssetRows.length,
      elapsedMs: Math.round(performance.now() - started), cpuUserMs: usage.user / 1000, cpuSystemMs: usage.system / 1000, maxRssKiB: process.resourceUsage().maxRSS,
      isolated: true, htmlExecuted: false, networkRequests: 0, retryCreatedDuplicates: false }));
  } catch (error) {
    // Never let assertion diagnostics print archived prose, source code or media.
    throw new Error(`Actual archive verification failed in ${phase} (${error instanceof Error ? error.name : "unknown"}); private values omitted`);
  } finally { globalThis.fetch = originalFetch; }
});
