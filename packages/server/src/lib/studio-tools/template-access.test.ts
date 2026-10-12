import assert from "node:assert/strict";
import { test } from "node:test";
import * as skills from "../studio-skills/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { STUDIO_TOOLS, READ_TOOL_NAMES, WRITE_TOOL_NAMES, CONTROL_TOOL_NAMES } from "./tools.js";

test("Studio exposes the official template catalog as an automatic read tool", () => {
  const tool = STUDIO_TOOLS.find((entry) => entry.function.name === "list_templates");
  assert.ok(tool, "Studio needs a callable list_templates tool, not only an HTTP route");
  assert.ok(READ_TOOL_NAMES.has("list_templates"));
  assert.ok(!WRITE_TOOL_NAMES.has("list_templates"));
  assert.ok(!CONTROL_TOOL_NAMES.has("list_templates"));
  assert.ok((tool.function.parameters.properties as Record<string, unknown>).id);
});

test("Studio can discover and read the real VN template without changing a world", () => {
  assert.equal(typeof skills.executeListTemplates, "function");
  const catalog = skills.executeListTemplates({});
  assert.match(catalog.summary ?? "", /vn-scene-engine/);
  const template = skills.executeListTemplates({ id: "vn-scene-engine" });
  assert.equal(template.error, undefined);
  assert.equal(template.id, "vn-scene-engine");
  assert.equal(template.meta?.name, "Visual Novel Scene Engine");
  assert.equal(template.meta?.surface, "custom-component");
  assert.equal(template.content, skills.readTemplateContent("vn-scene-engine"));
  assert.match(template.content ?? "", /function handleAdvance\(/);
});

test("template reads reject unknown IDs and paths instead of inventing source", () => {
  assert.equal(typeof skills.executeListTemplates, "function");
  for (const id of ["not-an-official-template", "../../.env", "", 42]) {
    const result = skills.executeListTemplates({ id });
    assert.ok(result.error);
    assert.equal(result.content, undefined);
  }
});

test("Studio prompt distinguishes official templates from personal assets and explains retrieval", () => {
  const parts = buildSystemPrompt({ inventory: "", preloadedEntities: "", tokenEstimate: 0, truncated: false,
    lorebookHealth: { alwaysCount: 0, alwaysTokens: 0, pseudoAlwaysCount: 0,
      pseudoAlwaysTokens: 0, totalTokens: 0, topEntries: [], overBudget: false, reasons: [] } });
  assert.match(parts.static, /vn-scene-engine/);
  assert.match(parts.static, /list_templates\(id\?\)/);
  assert.match(parts.static, /separate from the creator's asset library/);
});
