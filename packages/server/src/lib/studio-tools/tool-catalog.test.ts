import test from "node:test";
import assert from "node:assert/strict";
import { STUDIO_TOOLS } from "./tools.js";
import { CORE_TOOL_NAMES, TOOL_FAMILIES, readToolSelectionState, seedStudioToolSelection,
  selectStudioTools, requestStudioTools, buildToolSelectionInstructions, skillNamesForTools, contextNeedsForTools, pinnedStudioToolNames } from "./tool-catalog.js";
import type { ChatMessage, ToolCall } from "../llm/types.js";
const names = (tools: typeof STUDIO_TOOLS) => tools.map(tool => tool.function.name);
const empty = () => readToolSelectionState(undefined);

test("ordinary requests advertise only eight core tools and retain the canonical registry", () => {
  assert.ok(STUDIO_TOOLS.length > 40);
  const selected = selectStudioTools(STUDIO_TOOLS, empty());
  assert.deepEqual(names(selected).sort(), [...CORE_TOOL_NAMES].sort()); assert.equal(selected.length, 8);
  assert.ok(JSON.stringify(selected).length < JSON.stringify(STUDIO_TOOLS).length / 4);
  assert.equal(STUDIO_TOOLS.some(tool => tool.function.name === "write_world_media"), true);
});

test("every enabled tool is reachable through a paged family catalog or explicit names", () => {
  const seen = new Set<string>(); let offset = 0;
  for (;;) {
    const { state, result } = requestStudioTools({ limit: 3, offset }, STUDIO_TOOLS, empty());
    assert.deepEqual(state, empty()); assert.ok(result.items.length <= 3);
    for (const item of result.items) {
      assert.equal(item.kind, "family");
      const activated = requestStudioTools({ families: [item.name] }, STUDIO_TOOLS, empty());
      for (const name of names(selectStudioTools(STUDIO_TOOLS, activated.state))) seen.add(name);
    }
    if (result.nextOffset === null) break;
    assert.ok(result.nextOffset > offset); offset = result.nextOffset;
  }
  assert.deepEqual([...seen].sort(), names(STUDIO_TOOLS).sort());
  for (const tool of STUDIO_TOOLS) {
    const { state } = requestStudioTools({ names: [tool.function.name] }, STUDIO_TOOLS, empty());
    assert.ok(names(selectStudioTools(STUDIO_TOOLS, state)).includes(tool.function.name));
  }
  assert.ok(TOOL_FAMILIES.length > 10);
});

test("catalog search stays bounded and never returns full tool schemas", () => {
  const result = requestStudioTools({ browse: "tools", query: "world_media", limit: 1 }, STUDIO_TOOLS, empty()).result;
  assert.equal(result.total, 1); assert.equal(result.items[0]!.name, "write_world_media");
  assert.equal(result.nextOffset, null); assert.equal(result.hasMore, false);
  assert.doesNotMatch(JSON.stringify(result), /"parameters"|"properties"/);
  assert.ok(result.items[0]!.description.length <= 200);
  for (const input of [{ limit: 11 }, { offset: -1 }, { names: Array(9).fill("write_entry") }, { families: Array(4).fill("content") }, { unknown: true }]) {
    assert.throws(() => requestStudioTools(input, STUDIO_TOOLS, empty()));
  }
});

test("activation is atomic, explicit replacement retains pins, and capabilities never expand", () => {
  const first = requestStudioTools({ names: ["write_entry"] }, STUDIO_TOOLS, empty()).state;
  const before = JSON.stringify(first);
  assert.throws(() => requestStudioTools({ names: ["write_variable", "invented_tool"], replace: true }, STUDIO_TOOLS, first));
  assert.equal(JSON.stringify(first), before);
  const next = requestStudioTools({ names: ["write_world_media"], replace: true }, STUDIO_TOOLS, first).state;
  const selected = names(selectStudioTools(STUDIO_TOOLS, next, { pinnedNames: ["write_entry", "edit_custom_ui"] }));
  for (const required of ["write_world_media", "list_assets", "view_image", "write_entry", "edit_custom_ui"]) assert.ok(selected.includes(required), required);
  const restricted = STUDIO_TOOLS.filter(tool => !["generate_image", "generate_images"].includes(tool.function.name));
  assert.throws(() => requestStudioTools({ names: ["generate_image"] }, restricted, first));
  const family = requestStudioTools({ families: ["image_generation"] }, restricted, first).state;
  assert.ok(!names(selectStudioTools(restricted, family, { pinnedNames: ["generate_image"] })).includes("generate_image"));
});

test("summary and naming modes, persisted selection and retry names retain existing behavior", () => {
  const state = requestStudioTools({ families: ["mechanics"] }, STUDIO_TOOLS, empty()).state;
  assert.deepEqual(selectStudioTools(STUDIO_TOOLS, state, { mode: "summary", pinnedNames: ["write_entry"] }), []);
  assert.deepEqual(names(selectStudioTools(STUDIO_TOOLS, state, { mode: "naming", pinnedNames: ["write_entry"] })), ["generate_names"]);
  assert.deepEqual(readToolSelectionState(JSON.parse(JSON.stringify(state))), state);
  assert.deepEqual(readToolSelectionState({ version: 9, names: ["write_entry"] }), empty());
  assert.deepEqual(readToolSelectionState({ version: 1, names: ["write_entry", "write_entry", false] }), { version: 1, names: ["write_entry"] });
});

test("intent and panel hints never prevent explicit cross-domain activation", () => {
  const media = seedStudioToolSelection(STUDIO_TOOLS, { activePanel: "variables", userMessage: "Set the card cover and page banner from my library" });
  const selected = names(selectStudioTools(STUDIO_TOOLS, media));
  assert.ok(selected.includes("write_world_media")); assert.ok(!selected.includes("generate_image"));
  const cross = requestStudioTools({ families: ["audio"] }, STUDIO_TOOLS, media).state;
  assert.ok(names(selectStudioTools(STUDIO_TOOLS, cross)).includes("write_audio"));
  assert.deepEqual(seedStudioToolSelection(STUDIO_TOOLS, { activePanel: "sprites", userMessage: "Set the card cover" }, empty()), empty());
  assert.ok(seedStudioToolSelection(STUDIO_TOOLS, { userMessage: "Read the official VN template" }).names.includes("list_templates"));
  assert.ok(!seedStudioToolSelection(STUDIO_TOOLS, { userMessage: "Explain this story template" }).names.includes("list_templates"));
});

test("retry pins retain unfinished failures and pending/checkpoint calls without historical successes", () => {
  const call = (id: string, name: string): ToolCall => ({ id, type: "function", function: { name, arguments: "{}" } });
  const history: ChatMessage[] = [
    { role: "assistant", content: "", tool_calls: [call("ok", "write_entry"), call("bad", "write_variable"), call("open", "write_audio")] },
    { role: "tool", tool_call_id: "ok", content: JSON.stringify({ status: "OK" }) },
    { role: "tool", tool_call_id: "bad", content: JSON.stringify({ error: "Retry after reading the target" }) },
  ];
  assert.deepEqual(pinnedStudioToolNames(history, [call("pending", "write_world_media")], [call("checkpoint", "edit_custom_ui")]).sort(),
    ["write_variable", "write_audio", "write_world_media", "edit_custom_ui"].sort());
  const recovered: ChatMessage[] = [...history, { role: "assistant", content: "", tool_calls: [call("retry", "write_variable")] },
    { role: "tool", tool_call_id: "retry", content: JSON.stringify({ status: "OK" }) },
    { role: "tool", tool_call_id: "open", content: "saved" }];
  assert.deepEqual(pinnedStudioToolNames(recovered, [call("open", "write_audio")]), []);
  assert.deepEqual(pinnedStudioToolNames([{ role: "tool", tool_call_id: "pending", content: JSON.stringify({ error: "Failed in prelude" }) }], [call("pending", "write_world_media")]), ["write_world_media"]);
});

test("selected guides retain mandatory naming/ask/result rules and defer unrelated instructions/context", () => {
  const basic = names(selectStudioTools(STUDIO_TOOLS, empty()));
  const guide = buildToolSelectionInstructions(basic);
  assert.match(guide, /request_tools/); assert.match(guide, /generate_names/); assert.match(guide, /ask_user.*alone/i);
  assert.match(guide, /failed/i); assert.match(guide, /result/i);
  assert.doesNotMatch(guide, /Krea|ComfyUI|enumValues|write_world_media/);
  assert.deepEqual(skillNamesForTools(basic), []);
  assert.deepEqual(contextNeedsForTools(basic), { includeAssetInventory: false, includeMediaInventory: false });
  const media = names(selectStudioTools(STUDIO_TOOLS, requestStudioTools({ families: ["card_media"] }, STUDIO_TOOLS, empty()).state));
  assert.match(buildToolSelectionInstructions(media), /write_world_media/);
  assert.deepEqual(contextNeedsForTools(media), { includeAssetInventory: true, includeMediaInventory: true });
  assert.deepEqual(skillNamesForTools(["write_variable"]), ["variables"]);
});
