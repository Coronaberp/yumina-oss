import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../db/index.js";
import { user, apiKeys } from "../db/schema.js";
import { encryptApiKey } from "./crypto.js";
import { resolveSavedProfileProvider } from "./saved-profile-provider.js";
import { createStoryContentRouter } from "./story-content-routing.js";
import { loadTurnMemoryBlocks } from "./turn-memory.js";
import { fillTurnRecallRequest } from "./story-recall-context.js";
import { estimateTokens, type WorldDefinition } from "@yumina/engine";

test("selecting the NSFW endpoint directly still enforces its saved context window", async t => {
  const owner = crypto.randomUUID(), profile = crypto.randomUUID();
  await db.insert(user).values({ id: owner, name: "Context test", email: `${owner}@test.invalid`, preferences: { activeApiKeyId: profile, nsfwApiKeyId: profile } });
  const key = encryptApiKey("fixture-only");
  await db.insert(apiKeys).values({ id: profile, userId: owner, provider: "custom", baseUrl: "https://context.example/v1", encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag, metadata: { defaultModel: "qwen3.8", contextWindow: 65536 } });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No upstream requests are permitted"); });
  const selected = await resolveSavedProfileProvider(owner, profile); assert.ok(selected);
  const router = createStoryContentRouter({ async classify() { throw new Error("The selected NSFW endpoint does not need classification"); } });
  const small = await router.prepare({ userId: owner, selected: { resolved: selected, model: selected.model }, maxContext: 200000, maxTokens: 12000, messages: [{ role: "user", content: "Continue the lesson." }] });
  assert.equal(small.maxContext, 45505);
  await assert.rejects(router.prepare({ userId: owner, selected: { resolved: selected, model: selected.model }, maxContext: 200000, maxTokens: 12000,
    messages: [{ role: "system", content: "World facts. ".repeat(60000) }, { role: "user", content: "Continue the lesson." }] }), /context window/);
});

test("the selected endpoint composes recall before checking the complete request", async t => {
  const owner = crypto.randomUUID(), profile = crypto.randomUUID();
  await db.insert(user).values({ id: owner, name: "Context test", email: `${owner}@test.invalid`, preferences: { activeApiKeyId: profile, nsfwApiKeyId: profile } });
  const key = encryptApiKey("fixture-only");
  await db.insert(apiKeys).values({ id: profile, userId: owner, provider: "custom", baseUrl: "https://context.example/v1", encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag, metadata: { defaultModel: "test", contextWindow: 2048 } });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No upstream requests are permitted"); });
  const selected = await resolveSavedProfileProvider(owner, profile); assert.ok(selected);
  const world = { entries: [{id:"mira",name:"Mira",role:"character",enabled:true,alwaysSend:true,keywords:[],content:"Mira is the fire tutor."}],variables:[] } as unknown as WorldDefinition;
  const turn = await loadTurnMemoryBlocks({ownerUserId:owner,sessionId:"fixture-session",session:{},world,query:"Talk to Mira.",deferRecall:true} as any);
  const router = createStoryContentRouter({ async classify() { throw new Error("Direct NSFW profile"); } });
  const routed = await router.prepare({userId:owner,selected:{resolved:selected,model:selected.model},maxContext:700,maxTokens:256,
    messages:[{role:"system",content:"Rules."},{role:"assistant",content:"Old event. ".repeat(2000)},{role:"user",content:"Talk to Mira."}],
    fitContext:(messages,model,maxContext)=>fillTurnRecallRequest({turn,world,messages,model,maxContext,trim:{pinnedPrefix:1,pinnedSuffix:0}}),
  });
  assert.match(routed.messages.map(m=>m.content).join('\n'),/Mira is the fire tutor/);
  assert.ok(routed.messages.some(m=>m.role==='user'&&m.content==='Talk to Mira.'));
  assert.ok(routed.messages.reduce((n,m)=>n+estimateTokens(m.content as string,routed.model),0)<=700);
});

test("switching to a smaller NSFW endpoint repacks biographies and history before transport", async t => {
  const owner=crypto.randomUUID(),sfw=crypto.randomUUID(),nsfw=crypto.randomUUID();
  await db.insert(user).values({id:owner,name:"Player",email:`${owner}@test.invalid`,preferences:{activeApiKeyId:sfw,nsfwApiKeyId:nsfw}});
  const key=encryptApiKey("fixture-only");
  await db.insert(apiKeys).values([sfw,nsfw].map((id,i)=>({id,userId:owner,provider:"custom",baseUrl:`https://${i?'nsfw':'sfw'}.example/v1`,encryptedKey:key.encrypted,keyIv:key.iv,keyTag:key.tag,metadata:{defaultModel:"test",contextWindow:i?1024:8192}})));
  let sent:{url:string;body:any}|undefined;
  t.mock.method(globalThis,"fetch",async (url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    assert.ok(String(url).endsWith('/chat/completions'));
    sent={url:String(url),body:JSON.parse(String(init?.body))};
    return new Response('data: {"choices":[{"delta":{"content":"Fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  });
  const selected=await resolveSavedProfileProvider(owner,sfw);assert.ok(selected);
  const world={entries:[{id:'mira',name:'Mira',role:'character',enabled:true,alwaysSend:true,keywords:[],content:'Mira is the fire tutor.'}],variables:[]} as unknown as WorldDefinition;
  const turn=await loadTurnMemoryBlocks({ownerUserId:owner,sessionId:'fixture',session:{},query:'Describe a sexual scene with Mira.',world,deferRecall:true});
  const trim={pinnedPrefix:1,pinnedSuffix:1,historyTokens:7000};
  const routed=await createStoryContentRouter({classify:async()=>{throw new Error('Explicit guard must route this request');}}).prepare({userId:owner,selected:{resolved:selected,model:selected.model},maxContext:7000,maxTokens:256,trim,
    messages:[{role:'system',content:'Essential rules.'},...Array.from({length:10},()=>({role:'assistant' as const,content:'An old event. '.repeat(100)})),{role:'user',content:'Describe a sexual scene with Mira.'},{role:'system',content:'Current scene and format.'}],
    fitContext:(messages,model,maxContext)=>fillTurnRecallRequest({turn,world,messages,model,maxContext,trim}),
  });
  assert.ok(routed.rerouted);
  for await(const _chunk of routed.resolved.provider.generateStream({model:routed.model,messages:routed.messages,maxTokens:256})){}
  assert.equal(sent!.url,'https://nsfw.example/v1/chat/completions');
  const content=sent!.body.messages.map((m:any)=>m.content).join('\n');
  assert.match(content,/Mira is the fire tutor/);assert.match(content,/Describe a sexual scene with Mira/);assert.match(content,/Current scene and format/);
  assert.ok(sent!.body.messages.reduce((n:number,m:any)=>n+estimateTokens(m.content,routed.model),0)+256<=1024);
});
