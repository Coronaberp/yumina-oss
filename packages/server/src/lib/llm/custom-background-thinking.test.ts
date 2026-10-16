import assert from "node:assert/strict";
import test from "node:test";
import { createByokProvider } from "./provider-factory.js";

for (const stream of [true, false]) {
  for (const model of ["custom/glm-5.3", "custom/glm-5.3-flash", "z-ai/GLM-5.3-FLASH"]) {
    test(`${model} background checks explicitly use low thinking (${stream ? "streamed" : "buffered"})`, async t => {
      const requests: any[] = [];
      t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)));
        return stream
          ? new Response('data: {"choices":[{"delta":{"content":"{\\"valid\\":true}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
          : Response.json({ choices: [{ message: { content: '{"valid":true}' }, finish_reason: "stop" }] });
      });
      const provider = createByokProvider("custom", "fixture-only", "https://compatible.example/v1", {
        reasoningEffort: "high",
        excludeBody: ["reasoning_effort"],
        includeBody: { reasoning_effort: "max", thinking: { type: "disabled" } },
      });
      const chunks = [];
      for await (const chunk of provider.generateStream({
        model, messages: [{ role: "user", content: "Check the state." }],
        stream, disableReasoning: true, singleAttempt: true, maxTokens: 4096,
      })) chunks.push(chunk);
      assert.equal(chunks.at(-1)?.type, "done");
      assert.equal(requests.length, 1);
      assert.equal(requests[0].reasoning_effort, "low");
      assert.equal(requests[0].thinking.type, "enabled");
      assert.equal(requests[0].max_tokens, 4096);
    });
  }
}

test("GLM background low thinking does not add a vendor-specific thinking field or change story profile effort", async t => {
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: '{"valid":true}' }, finish_reason: "stop" }] });
  });
  const provider = createByokProvider("custom", "fixture-only", "https://compatible.example/v1", { reasoningEffort: "low" });
  for (const disableReasoning of [true, false]) {
    for await (const _ of provider.generateStream({ model: "custom/glm-5.3-flash", messages: [{ role: "user", content: "Check the state." }], stream: false, disableReasoning, singleAttempt: true })) {}
  }
  assert.deepEqual(requests.map(body => body.reasoning_effort), ["low", "low"]);
  assert.ok(requests.every(body => !("thinking" in body)));
  const high = createByokProvider("custom", "fixture-only", "https://compatible.example/v1", { reasoningEffort: "high" });
  for await (const _ of high.generateStream({ model: "custom/glm-5.3-flash", messages: [{ role: "user", content: "Tell a story." }], stream: false, singleAttempt: true })) {}
  assert.equal(requests.at(-1).reasoning_effort, "high");
});

test("other model families retain the supported reasoning opt-out", async t => {
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: '{"valid":true}' }, finish_reason: "stop" }] });
  });
  const provider = createByokProvider("custom", "fixture-only", "https://compatible.example/v1", { reasoningEffort: "high" });
  for (const model of ["custom/glm-4.7", "custom/glm-5.2", "custom/other-model"]) {
    for await (const _ of provider.generateStream({ model, messages: [{ role: "user", content: "Check the state." }], stream: false, disableReasoning: true, singleAttempt: true })) {}
  }
  assert.ok(requests.every(body => !("reasoning_effort" in body)));
});

for (const stream of [true, false]) {
  test(`OpenRouter GLM background checks use low thinking (${stream ? "streamed" : "buffered"})`, async t => {
    let body: any;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return stream
        ? new Response('data: {"choices":[{"delta":{"content":"{\\"valid\\":true}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        : Response.json({ choices: [{ message: { content: '{"valid":true}' }, finish_reason: "stop" }] });
    });
    const provider = createByokProvider("openrouter", "fixture-only", undefined, { reasoningEffort: "high" });
    for await (const _ of provider.generateStream({ model: "z-ai/glm-5.3-flash", messages: [{ role: "user", content: "Check the state." }], stream, disableReasoning: true, singleAttempt: true, maxTokens: 4096 })) {}
    assert.equal(body.reasoning.effort, "low");
  });
}
