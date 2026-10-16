import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, ensureStoryhavenMemoryTables } from "../db/index.js";
import { encryptApiKey } from "../lib/crypto.js";
import { createMemoryModel, closeMemoryRuntime } from "./runtime.js";
import { loadStoryhavenTurnContext, rememberStoryhavenModelRoute } from "./yumina-adapter.js";

test("background memory follows the story model and endpoint with the active embedding profile unchanged", async t => {
  await ensureStoryhavenMemoryTables();
  t.after(closeMemoryRuntime);
  const key=encryptApiKey('fixture-only');
  await db.execute(sql`INSERT INTO "user"(id,name,email,preferences) VALUES('route-u','Player','route@example.test','{"activeApiKeyId":"route-sfw","nsfwApiKeyId":"route-nsfw","aiConfig":{"selectedModel":"custom/fast-model"}}'::jsonb)`);
  for(const [id,model,url] of [['route-sfw','fast-model','https://sfw.example.test/v1'],['route-nsfw','story-model','https://nsfw.example.test/v1']]) {
    await db.execute(sql`INSERT INTO api_keys(id,user_id,provider,encrypted_key,key_iv,key_tag,base_url,metadata) VALUES(${id},'route-u','custom',${key.encrypted},${key.iv},${key.tag},${url},${JSON.stringify({defaultModel:model})}::jsonb)`);
  }
  await db.execute(sql`INSERT INTO worlds(id,creator_id,name,schema) VALUES('route-w','route-u','Story','{"name":"Story","entries":[],"variables":[]}'::jsonb)`);
  await db.execute(sql`INSERT INTO play_sessions(id,user_id,world_id) VALUES('route-s','route-u','route-w')`);
  await db.execute(sql`INSERT INTO messages(id,session_id,role,content,model) VALUES('route-a','route-s','assistant','A quiet room.','custom/story-model')`);
  const input={ownerUserId:'route-u',actingUserId:'route-u',sessionId:'route-s'};
  assert.equal((await loadStoryhavenTurnContext(input)).model,'custom/story-model','existing sessions use the last actual reply, not the unrelated free-model fallback');
  await rememberStoryhavenModelRoute('route-s','route-u','custom/story-model','route-nsfw');
  const ctx=await loadStoryhavenTurnContext(input);
  assert.equal(ctx.model,'custom/story-model');assert.equal(ctx.modelProfileId,'route-nsfw');
  const original=globalThis.fetch,requests:Array<{url:string;model:string}>=[];
  globalThis.fetch=(async(url,init)=>{
    const body=JSON.parse(String(init?.body));requests.push({url:String(url),model:body.model});
    return new Response('data: {"choices":[{"delta":{"content":"{\\"facts\\":[]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=original;});
  const model=await createMemoryModel('route-u','route-s',ctx.model,ctx.modelProfileId);
  assert.equal(await model.complete('Return no facts.'),'{"facts":[]}');
  assert.deepEqual(requests,[{url:'https://nsfw.example.test/v1/chat/completions',model:'story-model'}]);
  await assert.rejects(createMemoryModel('route-u','route-s','custom/story-model','someone-elses-profile'),/memory_model_unavailable/);
  assert.equal(requests.length,1,'an inaccessible profile cannot silently substitute the active endpoint');
});
