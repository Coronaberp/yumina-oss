import "../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import {eq} from "drizzle-orm";
import {migrateWorldDefinition,worldEntrySchema,type WorldDefinition} from "@yumina/engine";
import {db} from "../db/index.js";
import {agentRuns,worlds,user,studioConversations} from "../db/schema.js";
import {createStudioTask,upsertTaskRequirements,evaluateStudioTask} from "./studio-task.js";
import {claimStudioTaskResume} from "./studio-task-resume.js";
import {runAgentLoop} from "../routes/agent.js";
import {STUDIO_TOOLS} from "./studio-tools/tools.js";
import type {LLMProvider} from "./llm/types.js";

async function fixture(t:test.TestContext){
 const uid=crypto.randomUUID(),wid=crypto.randomUUID(),rid=crypto.randomUUID(),a=crypto.randomUUID(),b=crypto.randomUUID();
 await db.insert(user).values({id:uid,name:"Task resume QA",email:`${uid}@test.local`});
 const schema=migrateWorldDefinition({id:wid,version:"21.0.0",name:"Task resume QA",entries:[worldEntrySchema.parse({id:"mei",name:"Mei",role:"custom",content:"A guide.",section:"system-presets"})],variables:[],rules:[],reactions:[],components:[],audioTracks:[],customUI:[],settings:{}} as unknown as WorldDefinition);
 await db.insert(worlds).values({id:wid,creatorId:uid,name:schema.name,schema:schema as unknown as Record<string,unknown>});
 await db.insert(studioConversations).values([{id:a,worldId:wid,userId:uid,title:"A"},{id:b,worldId:wid,userId:uid,title:"B"}]);
 let task=upsertTaskRequirements(createStudioTask("Keep {{user}} and make Mei a real character","work",3),[{id:"mei",text:"Mei is a character",checks:[{kind:"entity",collection:"entries",id:"mei",field:"role",operator:"eq",value:"character"}]}]);
 task=evaluateStudioTask(task,schema,()=>[]);task.status="budget_paused";task.steps=3;
 await db.insert(agentRuns).values({id:rid,worldId:wid,userId:uid,conversationId:a,model:"old-model",status:"awaiting_user",messages:[{role:"user",content:task.goal}],context:{studioTask:task,studioTaskRunner:true}});
 await db.insert(agentRuns).values({worldId:wid,userId:uid,conversationId:b,model:"other-model",status:"running"});
 t.after(()=>db.delete(user).where(eq(user.id,uid)));
 return{uid,wid,rid,a,task,schema,scope:{worldId:wid,userId:uid,runId:rid}};
}
test("Continue claims a fresh fenced worker, preserves its checklist and supports a different provider",async t=>{
 const f=await fixture(t),claimed=await claimStudioTaskResume(f.scope,"new-model");assert.ok(claimed.ok);if(!claimed.ok)return;
 assert.notEqual(claimed.run.id,f.rid);assert.equal(claimed.run.model,"new-model");assert.equal((claimed.run.context!.studioTask as any).goal,f.task.goal);assert.equal((claimed.run.context!.studioTask as any).maxSteps,6);
 assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id,f.rid)))[0]!.status,"awaiting_user");
 assert.equal((await claimStudioTaskResume(f.scope,"new-model")).ok,false);
 let calls=0;const provider:LLMProvider={listModels:async()=>[],async *generateStream(params){
  assert.match(JSON.stringify(params.messages),/Keep \{\{user\}\} and make Mei/);
  if(calls++===0)yield{type:"tool_call_end",content:"",toolCall:{id:"fix-mei",type:"function",function:{name:"write_entry",arguments:'{"id":"mei","role":"character"}'}}};
  else yield{type:"text",content:"Mei is now a character."};
  yield{type:"done",content:"",stopReason:"end_turn"};
 }};
 await runAgentLoop({runId:claimed.run.id,worldId:f.wid,userId:f.uid,conversationId:f.a,world:migrateWorldDefinition(claimed.schema as unknown as WorldDefinition),messages:claimed.run.messages as any,context:claimed.run.context as any,model:"new-model",provider,isByok:true,apiKeyTier:"byok",iteration:0,maxIterations:50,tools:STUDIO_TOOLS,unlimited:true},{writeSSE:async()=>{},onAbort:()=>{}});
 const [saved]=await db.select().from(agentRuns).where(eq(agentRuns.id,claimed.run.id));assert.equal(saved!.status,"completed");assert.equal((saved!.context!.studioTask as any).met,true);
});
test("double Continue dispatches one worker and never claims a foreign task",async t=>{
 const f=await fixture(t);assert.equal((await claimStudioTaskResume({...f.scope,userId:"foreign"},"test")).ok,false);
 const results=await Promise.all([claimStudioTaskResume(f.scope,"test"),claimStudioTaskResume(f.scope,"test")]);assert.equal(results.filter(result=>result.ok).length,1);
});
