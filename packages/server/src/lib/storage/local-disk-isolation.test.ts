import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getLocalDiskStorage } from "../s3.js";

test("the isolated test runner keeps actual asset writes outside installation data", async () => {
  const storage = getLocalDiskStorage();
  const relative = path.relative(os.tmpdir(), storage.root);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "tests must use a temporary asset root");
  const key = "worlds/storage-isolation/probe.webp";
  await storage.putObject(key, Buffer.from("isolated test bytes"), "image/webp");
  assert.equal((await storage.getObjectBuffer(key)).buffer.toString(), "isolated test bytes");
  await storage.deleteObject(key);
});
