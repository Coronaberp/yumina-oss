import assert from "node:assert/strict";
import test from "node:test";
import { getImageFilesFromTransfer } from "./clipboard-image";

const image = (lastModified = 1) => new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png", lastModified });
const transfer = (files: File[], items: Array<{ kind: string; type: string; getAsFile(): File | null }>) => ({ files, items }) as unknown as DataTransfer;

test("one pasted bitmap appears once even when its two clipboard File objects have different timestamps", () => {
  const file = image(1), itemFile = image(2);
  const result = getImageFilesFromTransfer(transfer([file], [{ kind: "file", type: "image/png", getAsFile: () => itemFile }]));
  assert.equal(result.length, 1);
  assert.equal(result[0], file);
});

test("a screenshot exposed only through clipboard items remains available", () => {
  const file = image();
  assert.deepEqual(getImageFilesFromTransfer(transfer([], [{ kind: "file", type: "image/png", getAsFile: () => file }])), [file]);
});

test("OS file copies work with blank item MIME types and preserve multiple actual files", () => {
  const first = image(), second = new File(["second"], "other.png", { type: "image/png" });
  assert.deepEqual(getImageFilesFromTransfer(transfer([first, second], [{ kind: "file", type: "", getAsFile: () => first }, { kind: "file", type: "", getAsFile: () => second }])), [first, second]);
});

test("text paste, null files and non-image files do not become attachments", () => {
  const text = new File(["text"], "draft.txt", { type: "text/plain" });
  assert.deepEqual(getImageFilesFromTransfer(transfer([text], [{ kind: "string", type: "text/plain", getAsFile: () => null }, { kind: "file", type: "text/plain", getAsFile: () => text }])), []);
  assert.deepEqual(getImageFilesFromTransfer(null), []);
});
