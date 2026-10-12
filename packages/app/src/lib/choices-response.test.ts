import assert from "node:assert/strict";
import test from "node:test";
import { parseGenerateChoicesResponse } from "./choices-response.ts";

const messageId = "assistant-reply-17";
const activeSwipeIndex = 1;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function success(data: unknown) {
  return jsonResponse({ data });
}

test("returns validated choices and optional credit cost", async () => {
  const result = await parseGenerateChoicesResponse(success({
    messageId,
    activeSwipeIndex,
    choices: ["Inspect the map", "Ask the guide", "Wait for dawn"],
    creditCost: 0.25,
  }), messageId, activeSwipeIndex);
  assert.deepEqual(result, {
    choices: ["Inspect the map", "Ask the guide", "Wait for dawn"],
    creditCost: 0.25,
  });
});

test("preserves JSON server and provider errors", async () => {
  await assert.rejects(
    parseGenerateChoicesResponse(jsonResponse({ error: "Provider unavailable. Please try again." }, 502), messageId, activeSwipeIndex),
    { message: "Provider unavailable. Please try again." },
  );
});

test("replaces an HTML SPA/proxy response with the actionable backend message and hides its body", async () => {
  const html = "<!doctype html><html><body>PRIVATE_PROXY_FALLBACK_MARKER</body></html>";
  const response = new Response(html, { status: 404, headers: { "content-type": "text/html" } });
  await assert.rejects(
    parseGenerateChoicesResponse(response, messageId, activeSwipeIndex),
    error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Choices API returned a web page instead of JSON. Update/restart the Yumina backend or check the API proxy.");
      assert.doesNotMatch(error.message, /PRIVATE_PROXY_FALLBACK_MARKER|<!doctype|Unexpected token/);
      return true;
    },
  );
});

test("returns the actionable message for other non-JSON response bodies", async () => {
  await assert.rejects(
    parseGenerateChoicesResponse(new Response("upstream gateway unavailable", { status: 502 }), messageId, activeSwipeIndex),
    /Choices API returned a web page instead of JSON\. Update\/restart the Yumina backend or check the API proxy\./,
  );
});

test("rejects invalid success shape, identity, index, choice arrays and credit cost", async t => {
  const invalid: Array<[string, unknown]> = [
    ["missing data", {}],
    ["null data", { data: null }],
    ["wrong message", { messageId: "another-message", activeSwipeIndex, choices: ["A", "B"] }],
    ["wrong swipe", { messageId, activeSwipeIndex: 0, choices: ["A", "B"] }],
    ["missing choices", { messageId, activeSwipeIndex, choices: null }],
    ["too few choices", { messageId, activeSwipeIndex, choices: ["A"] }],
    ["too many choices", { messageId, activeSwipeIndex, choices: ["A", "B", "C", "D", "E"] }],
    ["empty choice", { messageId, activeSwipeIndex, choices: ["A", "  "] }],
    ["non-string choice", { messageId, activeSwipeIndex, choices: ["A", 2] }],
    ["duplicate choices", { messageId, activeSwipeIndex, choices: ["Ask", " ask "] }],
    ["invalid credit cost", { messageId, activeSwipeIndex, choices: ["A", "B"], creditCost: "free" }],
  ];
  for (const [name, data] of invalid) {
    await t.test(name, async () => {
      await assert.rejects(parseGenerateChoicesResponse(success(data), messageId, activeSwipeIndex), { message: "Invalid choices response." });
    });
  }
});

test("rejects a JSON error response without an error message", async () => {
  await assert.rejects(
    parseGenerateChoicesResponse(jsonResponse({ details: "not an API error" }, 503), messageId, activeSwipeIndex),
    { message: "Could not generate choices (HTTP 503)." },
  );
});
