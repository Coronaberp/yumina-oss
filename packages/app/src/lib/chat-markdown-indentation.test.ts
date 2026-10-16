import assert from "node:assert/strict";
import test from "node:test";
import { ResponseParser } from "@yumina/engine";
import { restoreChatMarkdownIndentation } from "./chat-markdown-indentation";

test("Chat restores Markdown indentation lost by engine cleanup without changing saved content", () => {
  const raw = '[SPEAKER:Narrator:normal]\n1. Parent\n   - Nested\n     Continuation\n2. Next\n[gold: +1]';
  const parsed = new ResponseParser().parse(raw);
  assert.ok(parsed.cleanText.includes('\n - Nested'));
  const display = restoreChatMarkdownIndentation(parsed.cleanText, raw);
  assert.ok(display.includes('\n   - Nested\n     Continuation'));
  assert.ok(!display.includes('[gold:'));
  assert.deepEqual(parsed.effects, [{ variableId: 'gold', operation: 'add', value: 1 }]);
  assert.ok(parsed.cleanText.includes('\n - Nested'));
});

test("only indentation is recovered, never hidden or rewritten provider prose", () => {
  const raw = '<think>\n       - Nested\nHidden reasoning\n</think>\n1. Parent\n   - Nested\nDo not display this line.\n   Rewritten words';
  const display = '1. Parent\n - Nested\nDifferent words';
  assert.equal(restoreChatMarkdownIndentation(display, raw), '1. Parent\n   - Nested\nDifferent words');
});

test("repeated lines, tabs, CRLF and already-authored indentation retain their order", () => {
  const raw = '1. Parent\r\n\t- Same\r\n   - Same\r\n2. Next';
  const display = '1. Parent\r\n - Same\r\n - Same\r\n2. Next';
  assert.equal(restoreChatMarkdownIndentation(display, raw), raw);
  assert.equal(restoreChatMarkdownIndentation('1. Parent\n     - Same', raw), '1. Parent\n     - Same');
});
