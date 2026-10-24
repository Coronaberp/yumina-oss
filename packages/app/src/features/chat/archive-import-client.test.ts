import assert from "node:assert/strict";
import test from "node:test";
import { importArchivePayload, ARCHIVE_CHUNK_BYTES } from "./archive-import-client";
const result = { sessionId: "restored-session", worldId: "original-card" };
const id = "1a197984-28be-4014-a972-23e5c5826e14";
test("a transcript sends one compact JSON request bound to its existing preview and stable import attempt", async () => {
  const original = globalThis.fetch; const calls: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { calls.push(init!); return Response.json({ data: result }, { status: 201 }); };
  try {
    const payload = new Blob(['{"mode":"transcript","messages":[]}']);
    assert.deepEqual(await importArchivePayload(payload, { requestId: id, contextSessionId: "preview-session" }), result);
    assert.equal(calls.length, 1);
    const headers = new Headers(calls[0].headers);
    assert.equal(headers.get("X-Yumina-Archive-Session"), "preview-session");
    assert.equal(headers.get("X-Yumina-Archive-Request"), id);
    assert.equal(await (calls[0].body as Blob).text(), await payload.text());
  } finally { globalThis.fetch = original; }
});
test("large full-save bytes arrive intact in bounded sequential chunks and finalize only once", async () => {
  const original = globalThis.fetch; const payload = new Blob(['{"assets":"', "x".repeat(ARCHIVE_CHUNK_BYTES * 2 + 17), '"}']);
  const received: Blob[] = []; const events: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input); events.push(`${init?.method}:${path}`);
    if (path.endsWith(`/uploads/${id}`)) return Response.json({ data: { state: "uploading", totalBytes: payload.size, receivedBytes: 0 } });
    if (path.includes("/chunks/")) {
      const body = init!.body as Blob;
      assert.ok(body.size <= ARCHIVE_CHUNK_BYTES);
      assert.equal(Number(path.split("/").at(-1)), received.reduce((total, chunk) => total + chunk.size, 0));
      received.push(body);
      return Response.json({ data: { state: "uploading", totalBytes: payload.size, receivedBytes: received.reduce((total, chunk) => total + chunk.size, 0) } });
    }
    assert.ok(path.endsWith("/complete")); return Response.json({ data: result }, { status: 201 });
  };
  try {
    assert.deepEqual(await importArchivePayload(payload, { requestId: id }), result);
    assert.equal(await new Blob(received).text(), await payload.text());
    assert.equal(received.length, 3);
    assert.equal(events.filter(event => event.endsWith("/complete")).length, 1);
    assert.ok(!events.some(event => event.endsWith("/import")));
  } finally { globalThis.fetch = original; }
});
test("simultaneous clicks share one request and a lost response is reconciled read-only", async () => {
  const original = globalThis.fetch; let posts = 0, reads = 0;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") { posts++; throw new TypeError("Connection lost after commit"); }
    reads++; return Response.json({ data: { state: "complete", result } });
  };
  try {
    const payload = new Blob(['{"mode":"transcript"}']);
    const values = await Promise.all([importArchivePayload(payload, { requestId: id }), importArchivePayload(payload, { requestId: id })]);
    assert.deepEqual(values, [result, result]); assert.equal(posts, 1); assert.equal(reads, 1);
  } finally { globalThis.fetch = original; }
});


test("a restore timeout reconciles its committed result without repeating the import", async t => {
  const original = globalThis.fetch; let posts = 0, reads = 0, timeouts = 0;
  t.mock.method(AbortSignal, "timeout", () => {
    const controller = new AbortController();
    if (timeouts++ === 0) queueMicrotask(() => controller.abort(new DOMException("Fixture deadline", "TimeoutError")));
    return controller.signal;
  });
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal, "every import and reconciliation request needs a bounded signal");
    if (init.method === "POST") {
      posts++;
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    }
    reads++; return Response.json({ data: { state: "complete", result } });
  };
  try {
    assert.deepEqual(await importArchivePayload(new Blob(['{"mode":"transcript"}']), { requestId: crypto.randomUUID() }), result);
    assert.equal(posts, 1); assert.equal(reads, 1);
  } finally { globalThis.fetch = original; }
});

test("an unconfirmed restore timeout keeps its request ID and retry stays single-flight", async t => {
  const original = globalThis.fetch; let posts = 0, timeouts = 0;
  const importIds: (string | null)[] = [];
  t.mock.method(AbortSignal, "timeout", () => {
    const controller = new AbortController();
    if (timeouts++ === 0) queueMicrotask(() => controller.abort(new DOMException("Fixture deadline", "TimeoutError")));
    return controller.signal;
  });
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal, "a stalled restore cannot leave the modal locked indefinitely");
    if (init.method === "POST") {
      importIds.push(new Headers(init.headers).get("X-Yumina-Archive-Request"));
      if (++posts === 1) return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
      return Response.json({ data: result });
    }
    return Response.json({ data: { state: "importing" } });
  };
  try {
    const payload = new Blob(['{"mode":"transcript"}']);
    await assert.rejects(importArchivePayload(payload), /not.*confirm.*Retry.*same import/i);
    const restored = await Promise.all([importArchivePayload(payload), importArchivePayload(payload)]);
    assert.deepEqual(restored, [result, result]); assert.equal(posts, 2);
    assert.ok(importIds[0]); assert.equal(importIds[0], importIds[1]);
  } finally { globalThis.fetch = original; }
});

test("a stalled reconciliation is bounded and preserves the original explicit import failure", async t => {
  const original = globalThis.fetch; let timeouts = 0, reads = 0;
  t.mock.method(AbortSignal, "timeout", () => {
    const controller = new AbortController();
    if (timeouts++ === 1) queueMicrotask(() => controller.abort(new DOMException("Fixture deadline", "TimeoutError")));
    return controller.signal;
  });
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal, "status reconciliation also needs a bounded signal");
    if (init.method === "POST") return Response.json({ error: "The saved archive is incomplete." }, { status: 400 });
    reads++;
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  };
  try {
    await assert.rejects(importArchivePayload(new Blob(['{}'])), /saved archive is incomplete.*HTTP 400/);
    assert.equal(reads, 1);
  } finally { globalThis.fetch = original; }
});


test("a timed-out chunk resumes from acknowledged bytes using the same upload attempt", async t => {
  const original = globalThis.fetch; let timeouts = 0, received = 0, restores = 0;
  const offsets: number[] = [], uploadPaths: string[] = [];
  const payload = new Blob(["x".repeat(ARCHIVE_CHUNK_BYTES + 17)]);
  t.mock.method(AbortSignal, "timeout", () => {
    const controller = new AbortController();
    if (timeouts++ === 1) queueMicrotask(() => controller.abort(new DOMException("Fixture deadline", "TimeoutError")));
    return controller.signal;
  });
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    assert.ok(init?.signal);
    const state = () => Response.json({ data: { state: "uploading", totalBytes: payload.size, receivedBytes: received } });
    if (path.endsWith("/complete")) { restores++; return Response.json({ data: result }); }
    if (path.includes("/chunks/")) {
      const offset = Number(path.split("/").at(-1)); offsets.push(offset);
      received = offset + (init.body as Blob).size;
      if (offset === 0) return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
      return state();
    }
    if (init.method === "POST") uploadPaths.push(path);
    return state();
  };
  try {
    await assert.rejects(importArchivePayload(payload), /upload timed out.*Retry resumes the same upload/);
    assert.equal(restores, 0);
    assert.deepEqual(await importArchivePayload(payload), result);
    assert.deepEqual(offsets, [0, ARCHIVE_CHUNK_BYTES]);
    assert.equal(uploadPaths.length, 2); assert.equal(uploadPaths[0], uploadPaths[1]);
    assert.equal(restores, 1);
  } finally { globalThis.fetch = original; }
});

test("a stalled response body is bounded and its committed result is reconciled", async t => {
  const original = globalThis.fetch; let timeouts = 0, reads = 0;
  t.mock.method(AbortSignal, "timeout", () => {
    const controller = new AbortController();
    if (timeouts++ === 0) queueMicrotask(() => controller.abort(new DOMException("Fixture deadline", "TimeoutError")));
    return controller.signal;
  });
  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.signal);
    if (init.method === "POST") return new Response(new ReadableStream({ start(controller) {
      init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
    } }));
    reads++; return Response.json({ data: { state: "complete", result } });
  };
  try {
    assert.deepEqual(await importArchivePayload(new Blob(['{}'])), result);
    assert.equal(reads, 1);
  } finally { globalThis.fetch = original; }
});
