import assert from "node:assert/strict";
import test from "node:test";
import { decodeStudioSnapshotMaterial, encodeStudioSnapshotMaterial } from "./studio-world-material.js";

const schema = {
  id: "custom-world", version: "21.0.0", name: "Custom world", entries: [],
  kind: "user-kind", schema: { custom: true }, thumbnailUrl: "user custom field",
  __studioSnapshotMaterial: { keep: "user-owned custom value" },
};

test("material snapshot wraps the entire custom schema without reserved-field collisions", () => {
  const encoded = encodeStudioSnapshotMaterial(schema, "@asset:chosen-image");
  assert.deepEqual(encoded, { kind: "studio-world-material", version: 1, schema, thumbnailUrl: "@asset:chosen-image" });
  const decoded = decodeStudioSnapshotMaterial(encoded);
  assert.deepEqual(decoded, { schema, thumbnailUrl: "@asset:chosen-image" });
  assert.equal(decoded.schema, schema);
});

test("explicit null clears a portrait while legacy snapshots omit the sidecar", () => {
  assert.deepEqual(decodeStudioSnapshotMaterial(encodeStudioSnapshotMaterial(schema, null)), { schema, thumbnailUrl: null });
  const legacy = decodeStudioSnapshotMaterial(schema);
  assert.deepEqual(legacy, { schema });
  assert.equal(Object.hasOwn(legacy, "thumbnailUrl"), false);
});

test("lookalike and malformed envelopes remain ordinary user schemas", () => {
  const wrapper = encodeStudioSnapshotMaterial(schema, null);
  for (const value of [
    { ...wrapper, id: "user-world" }, { ...wrapper, version: 2 }, { ...wrapper, custom: true },
    { ...wrapper, thumbnailUrl: 5 }, { ...wrapper, schema: [] }, { ...wrapper, schema: null },
  ]) assert.deepEqual(decodeStudioSnapshotMaterial(value), { schema: value });
});
