import assert from "node:assert/strict";
import { test } from "node:test";
import { assertNameInputsAuthored } from "./name-authorship.js";

test("Studio rejects model-invented surnames, affixes and custom syllable fragments", () => {
  const messages = [{ role: "user" as const, content: "Generate some names." }];
  for (const input of [{ surname: "InventedSurname" }, { particle: "InventedParticle" },
    { constraints: { prefix: "InventedPrefix" } }, { surnameConstraints: { suffix: "InventedSuffix" } },
    { phonetics: { starts: [["inventedfragment", 1]] } },
    { phonetics: { endings: { neutral: [["inventedfragment", 1]] } } },
  ]) assert.throws(() => assertNameInputsAuthored(input, messages, []), /creator-supplied/);
});

test("creator text and saved culture profiles authorize fixed family names and custom fragments", () => {
  const input = { surname: "Vale", particle: "de", constraints: { prefix: "Al" }, phonetics: { starts: [["ka", 1] as [string, number]] } };
  const messages = [{ role: "user" as const, content: 'Use surname Vale, particle de, prefix Al, and phonetic fragment "ka".' }];
  assert.doesNotThrow(() => assertNameInputsAuthored(input, messages, []));
  assert.doesNotThrow(() => assertNameInputsAuthored(input, [], [{ id: "saved", label: "Saved", ...input }]));
  assert.throws(() => assertNameInputsAuthored({ surname: "Vale" }, [{ role: "assistant", content: "I invented Vale." }], []), /creator-supplied/);
});
