import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { migrateWorldDefinition, worldEntrySchema, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, agentRuns } from "../db/schema.js";
import type { LLMProvider } from "../lib/llm/types.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { streamAgentLoop } from "./agent.js";

test("agent can narrow a cast read to one character, then complete the requested card edit", async () => {
  const uid=crypto.randomUUID(),wid=crypto.randomUUID(),rid=crypto.randomUUID();
  const world=migrateWorldDefinition({id:wid,version:"19.0.0",name:"Read progress fixture",description:"",author:"test",
    entries:[{id:"sera",name:"Sera",role:"character",content:"Disciplined instructor.",enabled:true},{id:"ryu",name:"Ryu",role:"character",content:"Curious professor.",enabled:true}].map(entry=>worldEntrySchema.parse({section:"system-presets",...entry})),
    variables:[],rules:[],reactions:[],components:[],audioTracks:[],customUI:[],settings:{},
  } as unknown as WorldDefinition);
  await db.insert(user).values({id:uid,name:"Read progress",email:`${uid}@example.test`});
  await db.insert(worlds).values({id:wid,creatorId:uid,name:world.name,status:"draft",schema:world as unknown as Record<string,unknown>});
  await db.insert(agentRuns).values({id:rid,worldId:wid,userId:uid,model:"read-progress-fixture",status:"running"});
  let iterations=0;
  const provider:LLMProvider={listModels:async()=>[],async *generateStream() {
    const call=(name:string,args:unknown)=>({type:"tool_call_end" as const,content:"",toolCall:{id:`read-step-${iterations}`,type:"function" as const,function:{name,arguments:JSON.stringify(args)}}});
    iterations++;
    if(iterations===1)yield call("read_entities",{ids:["card-showcase","sera","ryu"]});
    else if(iterations===2)yield call("read_entities",{ids:["sera","ryu"]});
    else if(iterations===3)yield call("read_entities",{ids:["sera"]});
    else if(iterations===4)yield call("write_card_showcase",{html:'<section class="card-showcase"><h2>Sera and Ryu</h2></section>',css:".card-showcase { padding: 1rem; }"});
    else yield {type:"text",content:"Updated the character card."};
    yield {type:"done",content:"",stopReason:iterations<5?"tool_use":"end_turn"};
  }};
  const app=new Hono();
  app.get("/test",c=>streamAgentLoop(c,{runId:rid,conversationId:rid,worldId:wid,userId:uid,world,
    messages:[{role:"user",content:"Update the public card showcase using the character descriptions."}],model:"read-progress-fixture",provider,
    isByok:true,apiKeyTier:"byok",unlimited:true,iteration:0,maxIterations:6,tools:STUDIO_TOOLS}));
  try {
    const response=await app.request("/test");
    const events=await response.text();
    assert.doesNotMatch(events,/event: error|requested three times|Stopped:/);
    assert.equal(iterations,5);
    const saved=(await db.select().from(worlds).where(eq(worlds.id,wid)))[0]!.schema as unknown as WorldDefinition;
    assert.match(saved.cardShowcase!.html!,/Sera and Ryu/);
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id,rid)))[0]!.status,"completed");
  } finally {await db.delete(user).where(eq(user.id,uid));}
});
