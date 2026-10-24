import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {createRequire,syncBuiltinESMExports} from "node:module";
import {CodexProvider,stopCodexConversation,leaseCodexConversation} from "./codex.js";
import type {ChatMessage,GenerateParams,StreamChunk,ToolDefinition} from "./types.js";
const tool=(name:string,description=name,properties:Record<string,unknown>={}):ToolDefinition=>({type:"function",function:{name,description,parameters:{type:"object",properties,additionalProperties:false}}});
const core=tool("request_tools"),media=tool("write_world_media","Card artwork",{bannerAssetRef:{type:"string"}});
const initial:ChatMessage[]=[{role:"system",content:"Current Studio instructions"},{role:"user",content:"Set the banner"}];
const result=(id:string,value:unknown):ChatMessage=>({role:"tool",tool_call_id:id,content:JSON.stringify(value)});
const called=(id:string,name:string):ChatMessage=>({role:"assistant",content:"",tool_calls:[{id,type:"function",function:{name,arguments:"{}"}}]});
async function collect(provider:CodexProvider,p:Partial<GenerateParams>={}){const chunks:StreamChunk[]=[];for await(const c of provider.generateStream({model:"codex/gpt-6-luna",messages:initial,tools:[core],...p}))chunks.push(c);return chunks;}
const noErrors=(chunks:StreamChunk[])=>assert.deepEqual(chunks.filter(c=>c.type==="error"),[]);
async function fixture(t:test.TestContext,mode:string){
 const dir=await mkdtemp(join(tmpdir(),"yumina-codex-selection-"));const command=join(dir,"codex"),script=join(dir,"fixture.mjs"),log=join(dir,"rpc.jsonl"),stderr=join(dir,"stderr.log");
 t.after(async()=>{try{const diagnostic=await readFile(stderr,"utf8");if(diagnostic)t.diagnostic(diagnostic);}catch{}await rm(dir,{recursive:true,force:true});});
 await writeFile(script,String.raw`#!${process.execPath}
import readline from 'node:readline';import{appendFileSync}from'node:fs';
const mode=${JSON.stringify(mode)},log=${JSON.stringify(log)},threadId='thread-'+process.pid;
if(mode==='rotate-stop')process.on('SIGTERM',()=>{appendFileSync(log,JSON.stringify({closing:process.pid})+'\n');setTimeout(()=>process.exit(0),100);});
let schemas=[],acks=[];const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
const usage=(i,o)=>send({method:'thread/tokenUsage/updated',params:{threadId,tokenUsage:{total:{inputTokens:i,outputTokens:o,totalTokens:i+o,reasoningOutputTokens:0}}}});
const done=text=>{send({method:'item/agentMessage/delta',params:{threadId,delta:text}});send({method:'turn/completed',params:{threadId,turn:{id:'turn-'+process.pid,status:'completed'}}});};
const call=(id,name,callId,args={})=>send({id,method:'item/tool/call',params:{threadId,turnId:'turn-'+process.pid,callId,tool:name,arguments:args}});
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),p=m.params;appendFileSync(log,JSON.stringify({pid:process.pid,...m})+'\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'chatgpt'}}});
 else if(m.method==='config/read')send({id:m.id,result:{config:{}}});
 else if(m.method==='model/list')send({id:m.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'max'}]}]}});
 else if(m.method==='thread/start'){schemas=p.dynamicTools;send({id:m.id,result:{thread:{id:threadId},model:'gpt-6-luna'}});}
 else if(m.method==='turn/steer')send({id:m.id,result:{turnId:'turn-'+process.pid}});
 else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn-'+process.pid}}});
  if(mode==='once'){done('Finished');return;}
  if(mode.startsWith('rotate')){
   if(schemas.some(t=>t.name==='write_world_media')){const h=JSON.parse(p.input.find(x=>x.type==='text').text);if(!h.some(x=>x.role==='tool'&&x.tool_call_id==='discover'&&JSON.parse(x.content).activated==='write_world_media')||!h.some(x=>x.role==='assistant'&&x.tool_calls?.some(c=>c.id==='discover'))){send({method:'error',params:{threadId,error:{message:'Completed receipt missing'},willRetry:false}});return;}if(mode==='rotate-usage-after'){call(202,'write_world_media','media',{bannerAssetRef:'@asset:00000000-0000-0000-0000-000000000001'});usage(20,4);}else{usage(20,4);call(202,'write_world_media','media',{bannerAssetRef:'@asset:00000000-0000-0000-0000-000000000001'});}}
   else{if(mode==='rotate-usage-after'){call(101,'request_tools','discover',{names:['write_world_media']});usage(10,3);}else{usage(10,3);call(101,'request_tools','discover',{names:['write_world_media']});}if(mode==='rotate-usage-late')setTimeout(()=>usage(12,5),80);}
  }else if(mode==='parallel'){call(103,'read_entities','read');call(104,'validate_world','validate');}
  else if(mode==='schema')call(105,'read_entities',schemas[0]?.description==='v2'?'read-v2':'read-v1',{version:schemas[0]?.description==='v2'?2:1});
  else if(mode==='policy'){if(!schemas.length)done('No tools');else call(106,'read_entities','read');}
 }else if(!m.method&&m.result){acks.push(m.id);if(mode==='parallel'&&acks.length<2)return;if(mode.startsWith('rotate'))usage(22,7);done('Receipts completed once');}
});
`,{mode:0o700});
 const quote=(value:string)=>"\'"+value.replaceAll("\'","\'\\\'\'")+"\'";
 await writeFile(command,"#!/bin/sh\nunset NODE_TEST_CONTEXT NODE_OPTIONS\nexec "+quote(process.execPath)+" "+quote(script)+' "$@" 2>'+quote(stderr)+"\n",{mode:0o700});
 const checked=spawnSync(process.execPath,["--check",script],{encoding:"utf8"});assert.equal(checked.status,0,checked.stderr);
 return{command,rows:async()=>(await readFile(log,"utf8")).trim().split("\n").map(x=>JSON.parse(x)) as any[]};
}
const starts=(rows:any[])=>rows.filter(x=>x.method==="thread/start");

test("Codex registers only selected schemas even with the full compatibility catalog",async t=>{
 const f=await fixture(t,"once");noErrors(await collect(new CodexProvider(f.command,1500),{availableTools:[core,media,tool("generate_image")]}));
 assert.deepEqual(starts(await f.rows())[0].params.dynamicTools,[{type:"function",name:core.function.name,description:core.function.description,inputSchema:core.function.parameters}]);
});
for(const choice of ["none",{type:"function",function:{name:"read_entities"}}] as const)test(`Codex registration respects ${typeof choice==="string"?choice:"forced-name"} policy`,async t=>{
 const f=await fixture(t,"once"),all=[tool("read_entities"),tool("validate_world")];noErrors(await collect(new CodexProvider(f.command,1500),{tools:all,availableTools:all,toolChoice:choice}));
 assert.deepEqual(starts(await f.rows())[0].params.dynamicTools.map((x:any)=>x.name),choice==="none"?[]:["read_entities"]);
});
for(const usageMode of ["rotate","rotate-usage-after","rotate-usage-late"])test(`Codex rotates schemas with chronological receipts and fresh usage deltas: ${usageMode}`,async t=>{
 const f=await fixture(t,usageMode),conversationId=crypto.randomUUID(),generationId="rotation";t.after(()=>stopCodexConversation(conversationId,generationId));
 const first=await collect(new CodexProvider(f.command,1500),{conversationId,generationId});noErrors(first);assert.equal(first.find(c=>c.type==="tool_call_end")?.toolCall?.id,"discover");
 if(usageMode==="rotate-usage-late")await new Promise(resolve=>setTimeout(resolve,120));
 const messages:ChatMessage[]=[...initial,called("discover","request_tools"),result("discover",{activated:"write_world_media"}),{role:"user",content:[{type:"text",text:"Keep portrait"},{type:"image_url",image_url:{url:"data:image/png;base64,Zml4dHVyZQ=="}}]}];
 const second=await collect(new CodexProvider(f.command,1500),{conversationId,generationId,tools:[core,media],messages});noErrors(second);
 assert.deepEqual(second.filter(c=>c.type==="tool_call_end").map(c=>c.toolCall),[{id:"media",type:"function",function:{name:"write_world_media",arguments:'{"bannerAssetRef":"@asset:00000000-0000-0000-0000-000000000001"}'}}]);
 assert.equal(leaseCodexConversation(conversationId,generationId),true);
 const final=await collect(new CodexProvider(f.command,1500),{conversationId,generationId,tools:[core,media],messages:[...messages,called("media","write_world_media"),result("media",{status:"OK"})]});noErrors(final);assert.equal(final.at(-1)?.stopReason,"end_turn");
 const rows=await f.rows(),threads=starts(rows),turns=rows.filter(x=>x.method==="turn/start");assert.equal(threads.length,2);assert.equal(new Set(threads.map(x=>x.pid)).size,2);
 assert.deepEqual(threads.map(x=>x.params.dynamicTools.map((y:any)=>y.name)),[["request_tools"],["request_tools","write_world_media"]]);
 assert.equal(rows.filter(x=>x.id===202&&x.result).length,1);assert.equal(rows.filter(x=>x.id===101&&x.result).length,0);
 assert.match(threads[1].params.developerInstructions,/historical|completed.*tool/i);assert.equal(turns[1].params.input.find((x:any)=>x.type==="image").url,"data:image/png;base64,Zml4dHVyZQ==");
 assert.deepEqual([first,second,final].map(c=>c.at(-1)?.usage?.totalTokens),[13,usageMode==="rotate-usage-late"?28:24,5]);
});
test("unchanged schemas reuse the same parallel turn despite irrelevant object or tool ordering",async t=>{
 const f=await fixture(t,"parallel"),conversationId=crypto.randomUUID();t.after(()=>stopCodexConversation(conversationId));
 const read=tool("read_entities","read",{a:{type:"string"},b:{type:"number"}}),validate=tool("validate_world");noErrors(await collect(new CodexProvider(f.command,1500),{conversationId,tools:[read,validate]}));
 const final=await collect(new CodexProvider(f.command,1500),{conversationId,tools:[validate,tool("read_entities","read",{b:{type:"number"},a:{type:"string"}})],messages:[...initial,result("read",{ok:true}),result("validate",{ok:true})]});noErrors(final);assert.equal(final.at(-1)?.stopReason,"end_turn");
 const rows=await f.rows();assert.equal(starts(rows).length,1);assert.deepEqual(rows.filter(x=>x.result&&[103,104].includes(x.id)).map(x=>x.id).sort(),[103,104]);
});
test("schema description and argument changes rotate even when the tool name stays unchanged",async t=>{
 const f=await fixture(t,"schema"),conversationId=crypto.randomUUID();t.after(()=>stopCodexConversation(conversationId));
 noErrors(await collect(new CodexProvider(f.command,1500),{conversationId,tools:[tool("read_entities","v1",{version:{const:1}})]}));
 const next=await collect(new CodexProvider(f.command,1500),{conversationId,tools:[tool("read_entities","v2",{version:{const:2}})],messages:[...initial,called("read-v1","read_entities"),result("read-v1",{ok:true})]});noErrors(next);assert.equal(next.find(c=>c.type==="tool_call_end")?.toolCall?.id,"read-v2");
 const threads=starts(await f.rows());assert.equal(threads.length,2);assert.deepEqual(threads[1].params.dynamicTools[0].inputSchema.properties.version,{const:2});
});
test("schema rotation verifies every pending parallel result before any replacement",async t=>{
 const f=await fixture(t,"parallel"),conversationId=crypto.randomUUID();t.after(()=>stopCodexConversation(conversationId));
 noErrors(await collect(new CodexProvider(f.command,1500),{conversationId,tools:[tool("read_entities"),tool("validate_world")]}));
 const next=await collect(new CodexProvider(f.command,1500),{conversationId,tools:[core],messages:[...initial,result("read",{ok:true})]});assert.equal(next.at(-1)?.type,"error");assert.match(next.at(-1)!.content,/pending.*result/i);assert.equal(starts(await f.rows()).length,1);
 const expired=await collect(new CodexProvider(f.command,1500),{conversationId,tools:[core],messages:[...initial,result("read",{ok:true}),result("validate",{ok:true})]});assert.equal(expired.at(-1)?.type,"error");assert.match(expired.at(-1)!.content,/expired|stopped/);assert.equal(starts(await f.rows()).length,1);
});
test("stop and cancellation still own the rotated pending thread",async t=>{
 const f=await fixture(t,"rotate"),conversationId=crypto.randomUUID(),generationId="stop";t.after(()=>stopCodexConversation(conversationId,generationId));
 noErrors(await collect(new CodexProvider(f.command,1500),{conversationId,generationId}));const messages=[...initial,called("discover","request_tools"),result("discover",{activated:"write_world_media"})];
 noErrors(await collect(new CodexProvider(f.command,1500),{conversationId,generationId,tools:[core,media],messages}));assert.equal(leaseCodexConversation(conversationId,generationId),true);await stopCodexConversation(conversationId,generationId);
 const stopped=await collect(new CodexProvider(f.command,1500),{conversationId,generationId,tools:[core,media],messages:[...messages,result("media",{status:"OK"})]});assert.match(stopped.at(-1)!.content,/expired|stopped/);
 const controller=new AbortController();controller.abort();await assert.rejects(collect(new CodexProvider(f.command,1500),{signal:controller.signal}),{name:"AbortError"});
});
test("a no-tools continuation removes dynamic schemas rather than only changing policy text",async t=>{
 const f=await fixture(t,"policy"),conversationId=crypto.randomUUID();t.after(()=>stopCodexConversation(conversationId));noErrors(await collect(new CodexProvider(f.command,1500),{conversationId,tools:[tool("read_entities")]}));
 const final=await collect(new CodexProvider(f.command,1500),{conversationId,tools:[tool("read_entities")],toolChoice:"none",messages:[...initial,result("read",{ok:true})]});noErrors(final);assert.equal(final.filter(c=>c.type==="tool_call_end").length,0);
 const threads=starts(await f.rows());assert.equal(threads.length,2);assert.deepEqual(threads[1].params.dynamicTools,[]);
});


test("stopping during schema replacement prevents starting a new native turn",async t=>{
 const f=await fixture(t,"rotate-stop"),conversationId=crypto.randomUUID(),generationId="stop-between-threads";t.after(()=>stopCodexConversation(conversationId,generationId));
 noErrors(await collect(new CodexProvider(f.command,1500),{conversationId,generationId}));
 const continued=collect(new CodexProvider(f.command,1500),{conversationId,generationId,tools:[core,media],messages:[...initial,called("discover","request_tools"),result("discover",{activated:"write_world_media"})]});
 let closing=false;
 for(let attempt=0;attempt<100&&!closing;attempt++){closing=(await f.rows()).some(row=>row.closing);if(!closing)await new Promise(resolve=>setTimeout(resolve,5));}
 assert.equal(closing,true,"old suspended process entered intentional close");
 await stopCodexConversation(conversationId,generationId);
 const chunks=await continued;assert.equal(chunks.at(-1)?.type,"error");assert.match(chunks.at(-1)!.content,/stopped/);
 assert.equal(starts(await f.rows()).length,1);assert.equal(leaseCodexConversation(conversationId,generationId),false);
});


test("stop during replacement directory allocation cannot resurrect a retired conversation",async t=>{
 const f=await fixture(t,"rotate"),conversationId=crypto.randomUUID(),generationId="stop-at-allocation";t.after(()=>stopCodexConversation(conversationId,generationId));
 noErrors(await collect(new CodexProvider(f.command,1500),{conversationId,generationId}));
 const fs=createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises"),original=fs.mkdtemp;
 let release!:()=>void,allocated!:(path:string)=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<string>(resolve=>{allocated=resolve;});
 fs.mkdtemp=(async(...args:Parameters<typeof mkdtemp>)=>{const path=await original(...args);allocated(String(path));await gate;return path;}) as typeof mkdtemp;
 syncBuiltinESMExports();
 try{
  const continued=collect(new CodexProvider(f.command,1500),{conversationId,generationId,tools:[core,media],messages:[...initial,called("discover","request_tools"),result("discover",{activated:"write_world_media"})]});
  const directory=await ready;await stopCodexConversation(conversationId,generationId);release();
  const chunks=await continued;assert.equal(chunks.at(-1)?.type,"error");assert.match(chunks.at(-1)!.content,/stopped/);assert.equal(starts(await f.rows()).length,1);
  await assert.rejects(readFile(join(directory,"unused")),(e:unknown)=>typeof e==="object"&&e!==null&&"code" in e&&e.code==="ENOENT");
  // stat the directory itself, so an empty leaked allocation cannot pass.
  await assert.rejects(fs.stat(directory),(e:unknown)=>typeof e==="object"&&e!==null&&"code" in e&&e.code==="ENOENT");
  assert.equal(leaseCodexConversation(conversationId,generationId),false);
 }finally{release();fs.mkdtemp=original;syncBuiltinESMExports();}
});
