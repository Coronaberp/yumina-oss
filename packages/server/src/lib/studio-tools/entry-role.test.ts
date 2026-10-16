import test from "node:test";
import assert from "node:assert/strict";
import { worldEntrySchema, type WorldDefinition } from "@yumina/engine";
import { executeApplyChanges, toolCallsToSchemaChanges } from "./tool-executor.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { getSkillContent } from "../studio-skills/index.js";
import { STUDIO_TOOLS } from "./tools.js";

function world(): WorldDefinition {
  return {id:"entry-role-fixture",version:"19.0.0",name:"Entry role fixture",description:"",author:"test",entries:[],variables:[],rules:[],reactions:[],components:[],audioTracks:[],customUI:[],settings:{maxTokens:4000,temperature:1}} as WorldDefinition;
}
function parseWrite(base:WorldDefinition,args:Record<string,unknown>) {
  const parsed=toolCallsToSchemaChanges([{id:"entry-write",function:{name:"write_entry",arguments:JSON.stringify(args)}}],base);
  assert.ok(parsed[0]?.change,parsed[0]?.error);
  return parsed[0].change;
}

test("a new Characters-tagged write becomes a real character before name checks and persistence",()=>{
  for(const tags of [["Characters"],[" character "],["NPCs","CHARACTERS"]]) {
    const base=world();
    const change=parseWrite(base,{id:"mei-amery",name:"Mei Amery",content:"An academy student.",tags,section:"system-presets"});
    assert.equal(change.data?.role,"character","Name validation must see the effective role before saving");
    const result=executeApplyChanges(base,[change]);
    assert.equal(result.success,true);
    const entry=result.world.entries[0]!;
    assert.equal(entry.role,"character");
    assert.equal(entry.portrait,undefined,"A character can expose its upload field before a picture exists");
    assert.deepEqual(entry.tags,tags);
  }
});
test("batch entry creation applies the same fallback without requiring the write_entry parser",()=>{
  const result=executeApplyChanges(world(),[{action:"create",entityType:"entry",id:"mei",data:{name:"Mei",tags:["Characters"],section:"chat-history",keywords:["Mei"]}}]);
  assert.equal(result.success,true);
  assert.equal(result.world.entries[0]!.role,"character");
  assert.equal(result.world.entries[0]!.section,"chat-history");
});
test("explicit roles and generic lore stay as authored",()=>{
  for(const role of ["character","custom","lore","greeting"] as const) {
    const base=world();
    const result=executeApplyChanges(base,[parseWrite(base,{id:"authored",name:"Authored",role,tags:["Characters"],content:"Keep this text."})]);
    assert.equal(result.success,true);assert.equal(result.world.entries[0]!.role,role);
  }
  const base=world();
  const result=executeApplyChanges(base,[parseWrite(base,{id:"faction",name:"Acolyte War",content:"World lore."})]);
  assert.equal(result.world.entries[0]!.role,"custom");
});
test("partial updates keep the existing role, content and portrait unless explicitly changed",()=>{
  for(const role of ["custom","character","lore"] as const) {
    const base=world();
    const entry=worldEntrySchema.parse({id:"existing",name:"Existing",content:"Original prose.",role,tags:["Characters"],section:"system-presets",portrait:"@asset:existing"});
    base.entries=[entry];
    const change=parseWrite(base,{id:"existing",name:"Updated name"});
    assert.equal(change.data?.role,undefined);
    const result=executeApplyChanges(base,[change]);
    assert.equal(result.success,true);
    assert.deepEqual(result.world.entries[0],{...entry,name:"Updated name"});
  }
});
test("character-role instructions reach both deferred-skill and full-context endpoints",()=>{
  const context={inventory:"",preloadedEntities:"",tokenEstimate:0,truncated:false,lorebookHealth:{alwaysCount:0,alwaysTokens:0,pseudoAlwaysCount:0,pseudoAlwaysTokens:0,totalTokens:0,topEntries:[],overBudget:false,reasons:[]}};
  for(const contextWindow of [65_536,1_050_000]) {
    const prompt=buildSystemPrompt(context,{contextWindow});
    assert.match(prompt.static,/role: "character"/);
    assert.match(prompt.static,/portrait/);
    assert.doesNotMatch(prompt.static,/\*\*role\*\* — auto-derived from tags/);
  }
  const skill=getSkillContent("entries")!;
  assert.match(skill,/role: "character"/);
  assert.doesNotMatch(skill,/First tag auto-sets the `role`/);
  const role=STUDIO_TOOLS.find(tool=>tool.function.name==="write_entry")!.function.parameters as {properties:{role:{description?:string}}};
  assert.match(role.properties.role.description??"",/character/);
});
