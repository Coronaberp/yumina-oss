import assert from "node:assert/strict";
import test from "node:test";
import { defaultStudioImageWorkflow } from "./image-proposal.js";

const available = { anima: true, krea: true, codex: true };
for (const imageKind of ["sprite", "background"] as const) {
  test(`SFW ${imageKind} defaults to Codex for both first designs and referenced artwork`, () => {
    for (const hasReferences of [false, true]) assert.equal(defaultStudioImageWorkflow({
      contentRating: "sfw", imageKind, hasReferences, available, activeSource: "comfyui", animaPreferred: true,
    }), "codex");
  });
  test(`NSFW ${imageKind} automatically excludes a previously selected Codex workflow`, () => {
    assert.equal(defaultStudioImageWorkflow({ requested: "codex", contentRating: "nsfw", imageKind, hasReferences: true, available }), "krea");
    assert.equal(defaultStudioImageWorkflow({ requested: "codex", contentRating: "nsfw", imageKind, hasReferences: false,
      available: { anima: false, krea: false, codex: true } }), undefined);
  });
}

test("an explicit local workflow remains selected without changing its content rating", () => {
  for (const requested of ["anima", "krea"] as const) for (const contentRating of ["sfw", "nsfw"] as const)
    assert.equal(defaultStudioImageWorkflow({ requested, contentRating, imageKind: "sprite", hasReferences: false, available }), requested);
});
