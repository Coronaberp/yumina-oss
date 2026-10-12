import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { PromptBuilder, estimateTokens, type WorldDefinition } from "@yumina/engine";
import { worldForTurnMemoryPrompt, loadTurnMemoryBlocks } from "./turn-memory.js";

const world = {
  name: "Academy", variables: [], settings: {},
  entries: [
    { id: "rules", name: "Rules", role: "system", enabled: true, alwaysSend: true, content: "Preserve player agency.", keywords: [], conditions: [], section: "system" },
    { id: "mira", name: "Mira", role: "character", enabled: true, alwaysSend: true, content: "Mira studies fire magic. " + "Her childhood was spent in the mountains. ".repeat(100), keywords: [], conditions: [], section: "system", portrait: "mira.png" },
    { id: "ann", name: "Ann", role: "character", enabled: true, alwaysSend: true, content: "Ann keeps the royal archives.", keywords: [], conditions: [], section: "system", portrait: "ann.png" },
    { id: "anna", name: "Anna", role: "character", enabled: true, alwaysSend: true, content: "Anna captains the guard.", keywords: [], conditions: [], section: "system" },
  ],
} as unknown as WorldDefinition;

test("every turn lists the cast but unneeded biographies never enter the static prompt", () => {
  const original = structuredClone(world);
  const projected = worldForTurnMemoryPrompt(world, {});
  const system = new PromptBuilder().buildSystemMessages(projected, { variables: {}, metadata: {} } as any).map(m => m.content).join("\n");
  assert.match(system, /Mira/); assert.match(system, /Ann/); assert.match(system, /Anna/);
  assert.match(system, /Preserve player agency/);
  assert.doesNotMatch(system, /fire magic|royal archives|captains the guard/);
  assert.equal(projected.entries.find(e => e.id === "mira")?.portrait, "mira.png");
  assert.deepEqual(world, original);
});

test("fresh legacy recall adds only the named biography and respects its request budget", async () => {
  const turn = await loadTurnMemoryBlocks({ ownerUserId: "owner", sessionId: "session", session: {}, world, query: "Ask Anna about the guard.", deferRecall: true } as any);
  const { fillTurnRecallRequest } = await import("./story-recall-context.js");
  const prompt = await fillTurnRecallRequest({ turn, world, messages: [
    { role: "system", content: "Essential rules." },
    ...Array.from({ length: 10 }, () => ({ role: "assistant" as const, content: "An old event. ".repeat(80) })),
    { role: "user", content: "Ask Anna about the guard." },
  ], model: "custom/test", maxContext: 700, trim: { pinnedPrefix: 1, pinnedSuffix: 0, historyTokens: 1000 } });
  const text = prompt.map(m => m.content).join("\n");
  assert.match(text, /Anna captains the guard/);
  assert.doesNotMatch(text, /royal archives|fire magic/);
  assert.ok(prompt.some(m => m.role === "user" && m.content === "Ask Anna about the guard."));
  assert.ok(prompt.reduce((n,m) => n + estimateTokens(m.content as string, "custom/test"), 0) <= 700);
});

test('active scene IDs select a biography without a repeated character name', async () => {
  const turn=await loadTurnMemoryBlocks({ownerUserId:'owner',sessionId:'session',session:{},world,query:'Continue the lesson.',deferRecall:true});
  const {fillTurnRecallRequest}=await import('./story-recall-context.js');
  const messages=await fillTurnRecallRequest({turn,world,state:{variables:{sceneSprites:[{characterId:'anna'}]}} as any,model:'custom/test',maxContext:700,trim:{pinnedPrefix:1,pinnedSuffix:0},messages:[{role:'system',content:'Rules.'},{role:'user',content:'Continue the lesson.'}]});
  const text=messages.map(m=>m.content).join('\n');
  assert.match(text,/Anna captains the guard/);assert.doesNotMatch(text,/royal archives|fire magic/);
});
