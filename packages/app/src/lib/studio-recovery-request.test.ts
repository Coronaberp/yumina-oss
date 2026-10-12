import test from "node:test";
import assert from "node:assert/strict";
import { createStudioRecoveryRequestCoordinator, type StudioRecoveryScope } from "./studio-recovery-request";

const scope: StudioRecoveryScope = { worldId: "world/one", conversationId: "chat one", runId: "run/one" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const requests: Array<{ url: string; init: RequestInit; response: ReturnType<typeof deferred<Response>> }> = [];
  const timers: Array<{ callback: () => void; delay: number; active: boolean }> = [];
  const coordinator = createStudioRecoveryRequestCoordinator({
    apiBase: "https://yumina.test",
    fetch: (url, init) => {
      const response = deferred<Response>();
      requests.push({ url, init, response });
      // Deliberately ignore abort: the coordinator must still bound a hung fetch
      // and prevent its eventual response from overwriting the replacement.
      return response.promise;
    },
    scheduleTimeout: (callback, delay) => {
      const timer = { callback, delay, active: true };
      timers.push(timer);
      return () => { timer.active = false; };
    },
  });
  const expire = () => {
    const timer = timers.find(item => item.active);
    assert.ok(timer, "a pending request must have a deadline");
    timer.active = false;
    timer.callback();
  };
  return { coordinator, requests, timers, expire };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("status requests are credentialed GETs scoped to the exact run, and release busy state", async () => {
  const { coordinator, requests, timers } = fixture();
  const pending = coordinator.request<{ data: { id: string } }>(scope);
  assert.equal(coordinator.isBusy(scope), true);
  await flush();
  assert.equal(requests[0]!.url, "https://yumina.test/api/studio/world%2Fone/agent/status?runId=run%2Fone");
  assert.equal(requests[0]!.init.method, "GET");
  assert.equal(requests[0]!.init.credentials, "include");
  assert.equal(requests[0]!.init.body, undefined);
  requests[0]!.response.resolve(Response.json({ data: { id: "run/one" } }));
  assert.deepEqual(await pending, { data: { id: "run/one" } });
  assert.equal(coordinator.isBusy(scope), false);
  assert.equal(timers.some(timer => timer.active), false);
});

test("concurrent status reads for one scope share a request and parsed result", async () => {
  const { coordinator, requests } = fixture();
  const first = coordinator.request(scope);
  const second = coordinator.request({ ...scope });
  assert.equal(first, second);
  await flush();
  assert.equal(requests.length, 1);
  requests[0]!.response.resolve(Response.json({ data: { status: "running" } }));
  assert.deepEqual(await first, { data: { status: "running" } });
  assert.deepEqual(await second, { data: { status: "running" } });
});

test("conversation lookups use encoded scope and distinct runs never share results", async () => {
  const { coordinator, requests } = fixture();
  const chat = { worldId: "world/one", conversationId: "chat one" };
  const first = coordinator.request(chat);
  const second = coordinator.request({ ...scope, runId: "run-two" });
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.url, "https://yumina.test/api/studio/world%2Fone/agent/status?conversationId=chat%20one");
  requests[0]!.response.resolve(Response.json({ data: { id: "run-one" } }));
  requests[1]!.response.resolve(Response.json({ data: { id: "run-two" } }));
  assert.deepEqual(await first, { data: { id: "run-one" } });
  assert.deepEqual(await second, { data: { id: "run-two" } });
});

test("a hung status fetch expires within the deadline even if fetch ignores abort", async () => {
  const { coordinator, requests, timers, expire } = fixture();
  const pending = coordinator.request(scope);
  const rejected = assert.rejects(pending, { name: "TimeoutError" });
  await flush();
  assert.ok(timers[0]!.delay >= 10_000 && timers[0]!.delay <= 15_000);
  expire();
  await rejected;
  assert.equal(requests[0]!.init.signal!.aborted, true);
  assert.equal(coordinator.isBusy(scope), false);
  assert.equal(requests.length, 1, "timeouts must not auto-retry or launch provider work");
  const next = coordinator.request(scope);
  await flush();
  requests[1]!.response.resolve(Response.json({ data: null }));
  await next;
});

test("Reconnect aborts and retries the same logical request, ignoring the stale response", async () => {
  const { coordinator, requests, timers } = fixture();
  const pending = coordinator.request(scope);
  await flush();
  assert.equal(coordinator.nudge(scope), true);
  assert.equal(requests[0]!.init.signal!.aborted, true);
  assert.equal(coordinator.request(scope), pending);
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(coordinator.isBusy(scope), true);
  assert.equal(timers.filter(timer => timer.active).length, 1);
  requests[0]!.response.resolve(Response.json({ data: { status: "running", iteration: 2 } }));
  requests[1]!.response.resolve(Response.json({ data: { status: "completed", iteration: 3 } }));
  assert.deepEqual(await pending, { data: { status: "completed", iteration: 3 } });
  assert.equal(coordinator.isBusy(scope), false);
});

test("rapid Reconnect presses coalesce into one replacement GET", async () => {
  const { coordinator, requests } = fixture();
  const pending = coordinator.request(scope);
  await flush();
  coordinator.nudge(scope);
  coordinator.nudge(scope);
  coordinator.nudge(scope);
  await flush();
  assert.equal(requests.length, 2);
  requests[1]!.response.resolve(Response.json({ data: { status: "running" } }));
  await pending;
});

test("nudging an idle scope performs no request", () => {
  const { coordinator, requests } = fixture();
  assert.equal(coordinator.nudge(scope), false);
  assert.equal(requests.length, 0);
});

test("the request deadline also covers a response body that never finishes", async () => {
  const { coordinator, requests, expire } = fixture();
  const pending = coordinator.request(scope);
  const rejected = assert.rejects(pending, { name: "TimeoutError" });
  await flush();
  requests[0]!.response.resolve(new Response(new ReadableStream({ start() {} })));
  await flush();
  expire();
  await rejected;
  assert.equal(coordinator.isBusy(scope), false);
});

test("HTTP and JSON failures release busy state without automatic replay", async () => {
  const { coordinator, requests } = fixture();
  const http = coordinator.request(scope);
  const httpRejected = assert.rejects(http, /HTTP 503/);
  await flush();
  requests[0]!.response.resolve(new Response("Unavailable", { status: 503 }));
  await httpRejected;
  assert.equal(coordinator.isBusy(scope), false);
  const malformed = coordinator.request(scope);
  const jsonRejected = assert.rejects(malformed, SyntaxError);
  await flush();
  requests[1]!.response.resolve(new Response("not JSON"));
  await jsonRejected;
  assert.equal(coordinator.isBusy(scope), false);
  assert.equal(requests.length, 2);
});

test("cancelling one scoped read leaves another conversation's read active", async () => {
  const { coordinator, requests } = fixture();
  const other = { ...scope, conversationId: "other-chat", runId: "other-run" };
  const first = coordinator.request(scope);
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = coordinator.request(other);
  await flush();
  coordinator.cancel(scope);
  await rejected;
  assert.equal(coordinator.isBusy(scope), false);
  assert.equal(coordinator.isBusy(other), true);
  assert.equal(requests[1]!.init.signal!.aborted, false);
  requests[1]!.response.resolve(Response.json({ data: { id: "other-run" } }));
  await second;
  assert.equal(coordinator.nudge(scope), false);
});
