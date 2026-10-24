import test from "node:test";
import assert from "node:assert/strict";
import { archiveResponseData } from "./archive-request";
test("archive responses retain explicit server errors and successful data", async () => {
  assert.deepEqual(await archiveResponseData(Response.json({ data: { sessionId: "new", worldId: "existing" } }, { status: 201 })), { sessionId: "new", worldId: "existing" });
  await assert.rejects(archiveResponseData(Response.json({ error: "This archive is incomplete." }, { status: 400 })), /This archive is incomplete/);
});
test("HTML proxy rejection retains HTTP 413 without parsing HTML as archive JSON", async () => {
  await assert.rejects(archiveResponseData(new Response('<html><head>413 Request Entity Too Large</head></html>', { status: 413 })), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /413/); assert.doesNotMatch(error.message, /Unexpected token|<html>/); return true;
  });
});
test("malformed and non-JSON responses stay explicit and inert", async () => {
  for (const status of [401, 502, 504]) await assert.rejects(archiveResponseData(new Response('<script>globalThis.archiveExecuted=true</script>', { status })), new RegExp(String(status)));
  for (const body of ['<html>Sign in</html>', '{"data":', '{}']) await assert.rejects(archiveResponseData(new Response(body)), /unexpected|invalid|confirm/i);
  assert.equal((globalThis as Record<string, unknown>).archiveExecuted, undefined);
});
