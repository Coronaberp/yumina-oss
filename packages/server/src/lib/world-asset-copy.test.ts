import assert from "node:assert/strict";
import test from "node:test";
import { prepareWorldAssetCopy } from "./world-asset-copy.js";

test("registered banner image refs remap independently without altering portrait or custom content", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const prepared = await prepareWorldAssetCopy([{
    id, worldId: "source", type: "image", filename: "banner.png", url: "https://example.invalid/banner.png",
    sizeBytes: 10, mimeType: "image/png", createdAt: new Date(0),
  }], "copy", []);
  const remapped = prepared.remap({
    bannerImageUrl: `@asset:${id}`, bannerCrop: { x: 0, y: 0, zoom: 1, fit: "contain" },
    portrait: "@asset:22222222-2222-4222-8222-222222222222", customSource: "export default () => <Chat />", entries: [{ content: "Original story" }],
  });
  assert.notEqual(prepared.rows[0]!.id, id);
  assert.equal(prepared.rows[0]!.worldId, "copy");
  assert.equal(remapped.bannerImageUrl, `@asset:${prepared.rows[0]!.id}`);
  assert.deepEqual(remapped.bannerCrop, { x: 0, y: 0, zoom: 1, fit: "contain" });
  assert.equal(remapped.portrait, "@asset:22222222-2222-4222-8222-222222222222");
  assert.equal(remapped.customSource, "export default () => <Chat />");
  assert.deepEqual(remapped.entries, [{ content: "Original story" }]);
});
