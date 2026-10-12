import assert from "node:assert/strict";
import { test } from "node:test";
import { studioNamingRequest } from "./name-request.js";
import type { ChatMessage } from "../llm/types.js";

test("naming intent requires the generator but leaves identity, configuration and supplied renames alone", () => {
  const detect = (text: string) => studioNamingRequest([{ role: "user", content: text }]);
  for (const request of ["Generate 10 names", "Give me full names using the name generator", "Names please", "Name my NPC"])
    assert.deepEqual(detect(request), { required: true, namesOnly: true }, request);
  for (const request of ["What is your name?", "Rename Diane to Elena", "What should I add to the name generator?", "Configure my naming profiles"])
    assert.equal(detect(request).required, false, request);
  assert.deepEqual(detect("Create 3 characters and generate their names"), { required: true, namesOnly: false });
  assert.deepEqual(detect("Suggest names with backstories and descriptions"), { required: true, namesOnly: false });
});

test("a successful generator result satisfies only its current user request", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Give me names" },
    { role: "assistant", content: "", tool_calls: [{ id: "names", type: "function", function: { name: "generate_names", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "names", content: JSON.stringify({ source: "phonetic-generator", names: ["Karin"] }) },
  ];
  assert.equal(studioNamingRequest(messages).required, false);
  assert.equal(studioNamingRequest([...messages, { role: "user", content: "Give me 5 more names" }]).required, true);
});
