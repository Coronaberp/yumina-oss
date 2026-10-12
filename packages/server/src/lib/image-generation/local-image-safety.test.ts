import assert from "node:assert/strict";
import test from "node:test";
import { createLocalImageRequestCheck } from "./local-image-safety.js";

test("local image request checks accept only a complete safe classifier result", async () => {
  const check = createLocalImageRequestCheck({ classify: async () => ({ status: "complete", label: "sfw", routingSafe: true }) });
  await check("A red-haired student smiling in a school courtyard.");
});

test("local image request checks reject unsafe, uncertain, and unavailable results", async () => {
  for (const result of [
    { status: "complete", label: "nsfw", routingSafe: false },
    { status: "complete", label: "sfw", routingSafe: false },
    { status: "error", label: "nsfw", routingSafe: false },
  ]) {
    const check = createLocalImageRequestCheck({ classify: async () => result });
    await assert.rejects(check("A prompt"), error => error instanceof Error && "code" in error
      && (error as Error & { code: string }).code === (result.status === "error" ? "REQUEST_CHECK_UNAVAILABLE" : "NSFW_IMAGE_REQUEST"));
  }
});

test("local image request checks honor cancellation before classifier work", async () => {
  const controller = new AbortController();controller.abort(new Error("cancelled"));
  let calls = 0;
  const check = createLocalImageRequestCheck({ classify: async () => { calls++;return { status: "complete", label: "sfw", routingSafe: true }; } });
  await assert.rejects(check("A prompt", controller.signal), /cancelled/);
  assert.equal(calls, 0);
});
