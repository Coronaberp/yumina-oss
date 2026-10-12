import assert from "node:assert/strict";
import test from "node:test";
import { dialogueSpans as chatSpans } from "../../../sandbox/chat/dialogue-spans";

for (const [name, spans] of [["chat", chatSpans]] as const) {
  test(`${name} possessives preserve text and do not consume subsequent markers`, () => {
    for (const apostrophe of ["'", "‘", "’"]) {
      const text = `{{user}}${apostrophe}s eyes held steady. {{char}}${apostrophe}s quill paused at the Adventurers${apostrophe} Guild.\n[SPEAKER:NPC:normal:male:academy-clerk]\n"Rank F."\n[SCENE: courtyard]`;
      const parsed = spans(text);
      assert.equal(parsed.map(span => span.text).join(""), text);
      assert.deepEqual(parsed.filter(span => span.kind === "dialogue").map(span => span.text), ['"Rank F."']);
    }
  });

  test(`${name} still supports single-quoted dialogue and contractions inside it`, () => {
    const parsed = spans("‘You don't need to lose your documents.’ 'Wait.'");
    assert.deepEqual(parsed.filter(span => span.kind === "dialogue").map(span => span.text), ["‘You don't need to lose your documents.’", "'Wait.'"]);
  });
}
