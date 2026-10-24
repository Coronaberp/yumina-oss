import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { VN_BACKGROUND_TEMPLATE, migrateWorldDefinition, readVnAssetMap, worldEntrySchema, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, agentRuns, userAssets } from "../db/schema.js";
import type { ChatMessage, GenerateParams, LLMProvider } from "../lib/llm/types.js";
import { STUDIO_TOOLS } from "../lib/studio-tools/tools.js";
import { CORE_TOOL_NAMES } from "../lib/studio-tools/tool-catalog.js";
import { runAgentLoop } from "./agent.js";
after(async () => { if ("close" in db.$client && typeof db.$client.close === "function") await db.$client.close(); });
const names = (r: GenerateParams) => {
 assert.deepEqual(r.availableTools,r.tools,"Persistent providers receive exactly the advertised schemas");
 return (r.tools ?? []).map(t => t.function.name);
};
const call = (id: string, name: string, args: unknown) => ({ type: "tool_call_end" as const, content: "", toolCall: { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } } });
const resultFor = (r: GenerateParams, id: string) => {
 const m=r.messages.find(m => m.role === "tool" && m.tool_call_id === id); assert.ok(m, id); return JSON.parse(String(m.content));
};
async function fixture(context: Record<string, unknown> = {}, pending?: Array<Record<string, unknown>>) {
 const uid=crypto.randomUUID(), worldId=crypto.randomUUID(), runId=crypto.randomUUID(), assetId=crypto.randomUUID();
 const world=migrateWorldDefinition({ id:worldId,version:"19.0.0",name:"Selection fixture",description:"",author:"test",
 entries:[worldEntrySchema.parse({id:"presentation",name:"Presentation",role:"system",content:"Preserve authored content.",enabled:true,section:"system-presets"})],variables:[],rules:[],reactions:[],components:[],audioTracks:[],customUI:[],settings:{},
 rootComponent:{id:"root",name:"VN",interfaceId:"vn",entryFile:"index.tsx",updatedAt:"before",files:{"index.tsx":"export default function Stage(){return <div style={{color:'blue'}}><Chat /></div>;}","scenes.ts":VN_BACKGROUND_TEMPLATE,"sprites.ts":"export const sprites = {};"}}} as unknown as WorldDefinition);
 await db.insert(user).values({id:uid,name:"Selection",email:`${uid}@test.local`});
 await db.insert(worlds).values({id:worldId,creatorId:uid,name:world.name,status:"draft",schema:world as unknown as Record<string,unknown>});
 await db.insert(agentRuns).values({id:runId,worldId,userId:uid,model:"selection-test",status:"running",context:{preserveSibling:true,...context},pendingToolCalls:pending});
 await db.insert(userAssets).values({id:assetId,userId:uid,type:"image",filename:"garden.png",url:"fixture/garden.png"});
 return {uid,worldId,runId,assetId,world};
}
async function run(f: Awaited<ReturnType<typeof fixture>>,provider:LLMProvider,messages:ChatMessage[]=[{role:"user",content:"Make the requested adjustments."}]) {
 const events:Array<{event:string;data:string}>=[];
 await runAgentLoop({runId:f.runId,conversationId:f.runId,worldId:f.worldId,userId:f.uid,world:f.world,messages,model:"selection-test",provider,isByok:true,apiKeyTier:"byok",unlimited:true,iteration:0,maxIterations:8,tools:STUDIO_TOOLS},{writeSSE:async e=>{events.push(e);},onAbort:()=>{}});
 assert.deepEqual(events.filter(e=>e.event==="error"),[]); return events;
}

test("core discovers VN/content/interface tools, writes native scene and mounted theme then validates",async()=>{
 const f=await fixture();let turn=0;
 const provider:LLMProvider={listModels:async()=>[],async *generateStream(r){turn++;
  if(turn===1){assert.deepEqual(names(r).sort(),[...CORE_TOOL_NAMES].sort());yield call("discover","request_tools",{families:["vn_assets","content","interface"],replace:true});}
  else if(turn===2){for(const n of ["edit_vn_assets","write_entry","edit_custom_ui"])assert.ok(names(r).includes(n)); assert.ok(!names(r).includes("generate_image")); assert.ok(resultFor(r,"discover").activeNames.includes("edit_vn_assets"));yield call("scenes","list_vn_assets",{kind:"backgrounds"});yield call("manual","load_skill",{name:"entries"});}
  else if(turn===3){assert.equal(resultFor(r,"scenes").editable,true);assert.match(JSON.stringify(r.messages),/\[SCENE:configured-id\]/);yield call("scene","edit_vn_assets",{kind:"backgrounds",action:"assign",name:"garden",variant:"day",assetRef:`@asset:${f.assetId}`});yield call("theme","edit_custom_ui",{id:"index.tsx",old_code:"color:'blue'",new_code:"color:'purple'"});yield call("directive","write_entry",{id:"presentation",content:"<variable-updates>Emit nothing if no tracked value changed.</variable-updates>\n<vn-scene-presentation>Emit [SCENE:garden] only on arrival at garden, even when tracked values do not change.</vn-scene-presentation>"});}
  else if(turn===4){for(const id of ["scene","theme","directive"])assert.equal(resultFor(r,id).status,"OK",JSON.stringify(resultFor(r,id)));yield call("validate","validate_world",{});}
  else {assert.equal(turn,5);assert.equal(resultFor(r,"validate").issues.filter((i:{severity:string})=>i.severity==="error").length,0);yield {type:"text",content:"Saved the scene directive and mounted theme; source validation passed."};}
  yield {type:"done",content:"",stopReason:turn<5?"tool_use":"end_turn"};}};
 try{await run(f,provider);const [row]=await db.select().from(worlds).where(eq(worlds.id,f.worldId));const saved=row!.schema as unknown as WorldDefinition;
  const garden=readVnAssetMap(saved.rootComponent!.files["scenes.ts"]!,"backgrounds").garden;
  assert.ok(garden && typeof garden!=="string");assert.equal(garden.day,`@asset:${f.assetId}`);
  assert.match(saved.rootComponent!.files["index.tsx"]!,/color:'purple'/);assert.match(saved.entries[0]!.content,/\[SCENE:garden\]/);
  const [r]=await db.select().from(agentRuns).where(eq(agentRuns.id,f.runId));assert.equal(r!.context!.preserveSibling,true);assert.ok((r!.context!.studioToolSelection as {names:string[]}).names.includes("edit_custom_ui"));
 }finally{await db.delete(user).where(eq(user.id,f.uid));}
});

test("resumed selection and pending calls survive replacement while disabled generation stays unavailable",async()=>{
 const pending=call("pending","write_world_media",{bannerAssetRef:null}).toolCall;
 const f=await fixture({studioToolSelection:{version:1,names:["edit_custom_ui"]}},[pending]);let turn=0;
 const provider:LLMProvider={listModels:async()=>[],async *generateStream(r){turn++;
  if(turn===1){assert.ok(names(r).includes("edit_custom_ui"));assert.ok(names(r).includes("write_world_media"));assert.ok(!names(r).includes("generate_image"));yield call("replace","request_tools",{names:["write_entry"],replace:true});yield call("disabled","request_tools",{names:["generate_image"]});}
  else {assert.equal(turn,2);assert.ok(names(r).includes("write_entry"));assert.ok(names(r).includes("write_world_media"));assert.ok(!names(r).includes("edit_custom_ui"));assert.ok(!names(r).includes("generate_image"));assert.match(resultFor(r,"disabled").error,/unavailable/);yield {type:"text",content:"Selection restored."};}
  yield {type:"done",content:"",stopReason:turn===1?"tool_use":"end_turn"};}};
 try{await run(f,provider);const [r]=await db.select().from(agentRuns).where(eq(agentRuns.id,f.runId));assert.deepEqual((r!.context!.studioToolSelection as {names:string[]}).names,["write_entry"]);assert.equal(r!.context!.preserveSibling,true);}
 finally{await db.delete(user).where(eq(user.id,f.uid));}
});

test("initial hints seed media tools once and an explicitly cleared selection stays empty on recovery",async()=>{
 const f=await fixture();let turn=0;
 const provider:LLMProvider={listModels:async()=>[],async *generateStream(r){turn++;
  if(turn===1){assert.ok(names(r).includes("write_world_media"));assert.ok(!names(r).includes("edit_vn_assets"));assert.ok(!names(r).includes("generate_image"));assert.match(JSON.stringify(r.messages),/CARD MEDIA/);yield call("clear","request_tools",{names:[],replace:true});}
  else{assert.equal(turn,2);assert.deepEqual(names(r).sort(),[...CORE_TOOL_NAMES].sort());assert.doesNotMatch(JSON.stringify(r.messages[0]),/CARD MEDIA|ASSET LIBRARY|<asset-handling>/);yield {type:"text",content:"Selection cleared."};}
  yield {type:"done",content:"",stopReason:turn===1?"tool_use":"end_turn"};}};
 try{await run(f,provider,[{role:"user",content:"Set the card cover and page banner from my library"}]);
  await db.update(agentRuns).set({status:"running"}).where(eq(agentRuns.id,f.runId));
  let recovered=0;const recovery:LLMProvider={listModels:async()=>[],async *generateStream(r){recovered++;assert.deepEqual(names(r).sort(),[...CORE_TOOL_NAMES].sort());yield {type:"text",content:"Saved empty selection restored."};yield {type:"done",content:"",stopReason:"end_turn"};}};
  await run(f,recovery,[{role:"user",content:"Set the card cover and page banner from my library"}]);assert.ok(recovered>0);
  const [row]=await db.select().from(agentRuns).where(eq(agentRuns.id,f.runId));assert.deepEqual(row!.context!.studioToolSelection,{version:1,names:[]});
 }finally{await db.delete(user).where(eq(user.id,f.uid));}
});

test("successful historical tools retire while failed and unfinished calls retain retry schemas",async()=>{
 const f=await fixture({studioToolSelection:{version:1,names:[]}});let turns=0;
 const history:ChatMessage[]=[{role:"user",content:"Continue the requested adjustments."},
  {role:"assistant",content:"",tool_calls:[call("success","edit_custom_ui",{}).toolCall,call("failure","write_world_media",{}).toolCall,call("unfinished","edit_vn_assets",{}).toolCall]},
  {role:"tool",tool_call_id:"success",content:JSON.stringify({status:"OK"})},
  {role:"tool",tool_call_id:"failure",content:JSON.stringify({error:"Read the current media before retrying."})}];
 const provider:LLMProvider={listModels:async()=>[],async *generateStream(r){turns++;assert.ok(!names(r).includes("edit_custom_ui"));for(const name of ["write_world_media","edit_vn_assets","list_assets","view_image","list_vn_assets"])assert.ok(names(r).includes(name),name);yield {type:"text",content:"Retry schemas restored."};yield {type:"done",content:"",stopReason:"end_turn"};}};
 try{await run(f,provider,history);assert.ok(turns>0);}finally{await db.delete(user).where(eq(user.id,f.uid));}
});

test("naming requests advertise only generate_names despite restored specialist tools",async()=>{
 const f=await fixture({studioToolSelection:{version:1,names:["write_world_media","edit_vn_assets"]}});let turns=0;
 const provider:LLMProvider={listModels:async()=>[],async *generateStream(r){turns++;assert.deepEqual(names(r),["generate_names"]);assert.deepEqual(r.toolChoice,{type:"function",function:{name:"generate_names"}});yield call("names","generate_names",{style:"nordic",count:2,seed:"lean-selection"});yield {type:"done",content:"",stopReason:"tool_use"};}};
 try{await run(f,provider,[{role:"user",content:"Give me two Nordic names"}]);assert.equal(turns,1);}finally{await db.delete(user).where(eq(user.id,f.uid));}
});

test("summary requests advertise no tools despite restored specialist tools",async()=>{
 const f=await fixture({studioToolSelection:{version:1,names:["write_world_media","edit_vn_assets"]},studioUserMessage:{content:"/summarize"}});let turns=0;
 const provider:LLMProvider={listModels:async()=>[],async *generateStream(r){turns++;assert.deepEqual(names(r),[]);yield {type:"text",content:"The creator is working on the fixture and requested a compact handoff."};yield {type:"done",content:"",stopReason:"end_turn"};}};
 try{await run(f,provider,[{role:"user",content:"/summarize"}]);assert.equal(turns,1);}finally{await db.delete(user).where(eq(user.id,f.uid));}
});
