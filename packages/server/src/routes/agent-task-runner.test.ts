import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, worldEntrySchema, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, agentRuns } from "../db/schema.js";
import type { LLMProvider, ToolCall } from "../lib/llm/types.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { streamAgentLoop } from "./agent.js";

async function fixture(goal: string, next: (step: number) => { name: string; args: unknown } | string, options: { serialized?: boolean; maxSteps?: number; maxIterations?: number } = {}) {
  const uid=crypto.randomUUID(),wid=crypto.randomUUID(),rid=crypto.randomUUID();
  const world=migrateWorldDefinition({id:wid,version:"21.0.0",name:"Task fixture",description:"",author:"test",entries:[worldEntrySchema.parse({id:"mei",name:"Mei",role:"custom",content:"A guide.",enabled:true,section:"system-presets"})],variables:[{id:"progress",name:"Progress",type:"number",defaultValue:0}],rules:[],reactions:[],components:[],audioTracks:[],customUI:[],settings:{}} as unknown as WorldDefinition);
  const context={studioTaskRunner:true,studioUserMessage:goal,...(options.maxSteps?{studioTaskMaxSteps:options.maxSteps}:{})};
  await db.insert(user).values({id:uid,name:"Task runner",email:`${uid}@example.test`});
  await db.insert(worlds).values({id:wid,creatorId:uid,name:world.name,status:"draft",schema:world as unknown as Record<string,unknown>});
  await db.insert(agentRuns).values({id:rid,worldId:wid,userId:uid,model:"task-fixture",status:"running",context});
  let calls=0;
  const provider:LLMProvider={listModels:async()=>[],async *generateStream(params) {
    assert.notEqual(params.responseFormat?.type,"json_schema", "task runner must not require proprietary structured output");
    const result=next(calls++);
    if(typeof result==="string")yield {type:"text",content:result};
    else {
      const tool:ToolCall={id:`step-${calls}`,type:"function",function:{name:result.name,arguments:JSON.stringify(result.args)}};
      if(options.serialized)yield {type:"text",content:JSON.stringify({tool_calls:[{name:result.name,arguments:result.args}]})};
      else yield {type:"tool_call_end",content:"",toolCall:tool};
    }
    yield {type:"done",content:"",stopReason:typeof result==="string"?"end_turn":"tool_use"};
  }};
  const app=new Hono();app.get("/test",c=>streamAgentLoop(c,{runId:rid,conversationId:rid,worldId:wid,userId:uid,world,messages:[{role:"user",content:goal}],model:"task-fixture",provider,isByok:true,apiKeyTier:"byok",unlimited:true,context,iteration:0,maxIterations:options.maxIterations??50,tools:STUDIO_TOOLS}));
  try {
    const events=await (await app.request("/test")).text();
    const run=(await db.select().from(agentRuns).where(eq(agentRuns.id,rid)))[0]!;
    const saved=(await db.select().from(worlds).where(eq(worlds.id,wid)))[0]!.schema as unknown as WorldDefinition;
    return {events,run,saved,calls};
  } finally {await db.delete(user).where(eq(user.id,uid));}
}
const rolePlan={name:"update_task_plan",args:{requirements:[{id:"mei",text:"Mei must be a real character",checks:[{kind:"entity",collection:"entries",id:"mei",field:"role",operator:"eq",value:"character"}]}]}};
test("shared task runner continues past 50 useful steps and verifies the saved outcome",async()=>{
  const result=await fixture("Update progress to 52",step=>step===0?{name:"update_task_plan",args:{requirements:[{id:"counter",text:"Progress reaches 52",checks:[{kind:"entity",collection:"variables",id:"progress",field:"defaultValue",operator:"eq",value:52}]}]}}:step<=52?{name:"write_variable",args:{id:"progress",name:"Progress",type:"number",defaultValue:step}}:step===53?{name:"check_task_progress",args:{}}:"Done.",{maxIterations:3});
  assert.equal(result.run.status,"completed");assert.equal((result.run.context?.studioTask as any)?.met,true);
  assert.equal(result.saved.variables[0]!.defaultValue,52);assert.ok(result.calls>50);assert.ok(result.run.maxIterations>50);
});
test("repeated reads recover without the old three-read stop, then finish the actual edit",async()=>{
  const result=await fixture("Make Mei a character",step=>step===0?rolePlan:step<=7?{name:"read_entities",args:{ids:["mei"]}}:step===8?{name:"write_entry",args:{id:"mei",role:"character"}}:"Done.");
  assert.equal(result.saved.entries[0]!.role,"character");assert.equal(result.run.status,"completed");
  assert.doesNotMatch(result.events,/requested three times|Stopped:/);assert.ok(result.calls>=10);
});
test("repeated failed writes end as a resumable stall, never completion",async()=>{
  const result=await fixture("Make Mei a character",step=>step===0?rolePlan:{name:"write_entry",args:null});
  assert.equal(result.run.status,"awaiting_user");assert.equal((result.run.context?.studioTask as any)?.status,"stalled");
  assert.equal((result.run.context?.studioTask as any)?.met,false);assert.equal(result.saved.entries[0]!.role,"custom");
});
test("strict text-serialized calls use the same task checks on non-native tool endpoints",async()=>{
  const result=await fixture("Make Mei a character",step=>step===0?rolePlan:step===1?{name:"write_entry",args:{id:"mei",role:"character"}}:"Done.",{serialized:true});
  assert.equal(result.run.status,"completed");assert.equal(result.saved.entries[0]!.role,"character");assert.equal((result.run.context?.studioTask as any)?.met,true);
});
test("an explicit task budget pauses unfinished work without claiming success",async()=>{
  const result=await fixture("Make Mei a character",step=>step===0?rolePlan:{name:"read_entities",args:{ids:["mei"]}},{maxSteps:3});
  assert.equal(result.run.status,"awaiting_user");assert.equal((result.run.context?.studioTask as any)?.status,"budget_paused");assert.equal(result.calls,3);
});

test("an unsupported completion claim cannot finish a task whose saved checks fail",async()=>{
 const result=await fixture("Make Mei a character",step=>step===0?rolePlan:"Done, everything is complete.");
 assert.equal(result.run.status,"awaiting_user");assert.equal((result.run.context?.studioTask as any).status,"stalled");assert.equal(result.saved.entries[0]!.role,"custom");assert.ok(result.calls<20);
});
test("ordinary how-to questions remain answers without a mutation checklist",async()=>{
 const result=await fixture("How should I create chapters?",()=>"Create a chapter and link its opening.");
 assert.equal(result.run.status,"completed");assert.equal(result.calls,1);assert.equal((result.run.context?.studioTask as any).mode,"answer");
});
test("an essential question pauses for the creator without pretending to finish",async()=>{
 const result=await fixture("Make Mei a character",step=>step===0?rolePlan:{name:"ask_user",args:{question:"Which Mei should I update?"}});
 assert.equal(result.run.status,"awaiting_user");assert.equal((result.run.context?.studioTask as any).status,"needs_input");assert.equal((result.run.context?.studioTask as any).met,false);
});
