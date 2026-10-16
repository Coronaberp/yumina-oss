import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeVnText, resolveVnText, vnTextCss, readVnTextDefaults, writeVnTextDefaults } from "../../../shared/src/vn-text-style";

test("personal VN choices inherit each unspecified property from the card", () => {
  assert.deepEqual(resolveVnText({ dialogue: { font: "serif", size: 30, color: "#ffddaa" }, narration: { size: 24 } }, { dialogue: { size: 20 } }), {
    dialogue: { font: "serif", size: 20, color: "#ffddaa" }, narration: { size: 24 },
  });
  assert.deepEqual(resolveVnText({ dialogue: { size: 30 } }, {}), { dialogue: { size: 30 }, narration: {} });
});
test("unsafe fonts, CSS colors and invalid sizes never enter VN CSS", () => {
  assert.deepEqual(normalizeVnText({ dialogue: { font: "url(https://invalid)", color: "red;}body{display:none}", size: Infinity }, narration: { size: -1 }, extra: true }), { dialogue: {}, narration: {} });
  assert.deepEqual(normalizeVnText({ dialogue: { color: "#ABCDEF", size: 28 } }), { dialogue: { color: "#abcdef", size: 28 }, narration: {} });
});
test("empty preferences preserve layout defaults; CSS affects only VN reading text", () => {
  assert.equal(vnTextCss({}, {}), "");
  const css = vnTextCss({ narration: { size: 25 } }, { dialogue: { font: "serif", color: "#abcdef", size: 32 } });
  assert.match(css, /\.vn \.vn-text:not\(\.vn-action\)/);
  assert.match(css, /\.vn \.vn-log-copy/);
  assert.match(css, /\.vn \.vn-narration/);
  assert.match(css, /font-size:32px!important/);
  assert.match(css, /font-size:25px!important/);
  assert.doesNotMatch(css, /\.chat|\.vn-name|\.vn-setting/);
});
test("creator data round-trips without evaluating custom card source", () => {
  const values = { dialogue: { font: "georgia", size: 30 }, narration: { color: "#abc123" } };
  assert.deepEqual(readVnTextDefaults(writeVnTextDefaults(values)), values);
  assert.deepEqual(readVnTextDefaults(undefined), { dialogue: {}, narration: {} });
  assert.throws(() => readVnTextDefaults('export const vnTextDefaults = (() => { throw new Error("execute"); })();'), /custom code/i);
});
