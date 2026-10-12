import "../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { sql, eq } from "drizzle-orm";
import { estimateTokens, migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { db, ensureStoryhavenMemoryTables } from "../db/index.js";
import { user, worlds, playSessions } from "../db/schema.js";
import { getMemoryRuntime, closeMemoryRuntime } from "./runtime.js";
import { ensureProfileSchema, ensureIdentity } from "./schema.js";
import { createMemoryRepositories } from "./repositories/index.js";
import { reconcileAuthoredLore, type AuthoredLoreEntry } from "./authored-lore.js";
import { loadStoryhavenTurnContext } from "./yumina-adapter.js";
import { loadTurnMemoryBlocks, worldForTurnMemoryPrompt } from "../lib/turn-memory.js";
import { fillTurnRecallRequest } from "../lib/story-recall-context.js";

test("StoryHaven biography recall uses current authored text, name relevance and the remaining prompt space", async t => {
  await ensureStoryhavenMemoryTables();
  const owner="character-recall-owner",worldId="character-recall-world",sessionId="character-recall-session";
  let world=migrateWorldDefinition({version:"1.0.0",name:"Academy",entries:[
    {id:"mira",name:"Mira",role:"character",section:"system-presets",enabled:true,alwaysSend:true,content:"Mira teaches OLD_FIRE_MAGIC. "+"Her first lesson concerns flames. ".repeat(100),keywords:[]},
    {id:"ann",name:"Ann",role:"character",section:"system-presets",enabled:true,alwaysSend:true,content:"Ann's UNUSED_ARCHIVE_BIOGRAPHY.",keywords:[]},
  ],variables:[],rules:[],settings:{}} as unknown as WorldDefinition);
  await db.insert(user).values({id:owner,name:"Player",email:`${owner}@fixture.invalid`});
  await db.insert(worlds).values({id:worldId,creatorId:owner,name:"Academy",schema:world as unknown as Record<string,unknown>});
  await db.insert(playSessions).values({id:sessionId,userId:owner,worldId});
  await db.execute(sql`INSERT INTO storyhaven_memory_sessions(session_id,backend) VALUES(${sessionId},'storyhaven') ON CONFLICT(session_id) DO UPDATE SET backend='storyhaven'`);
  const runtime=await getMemoryRuntime();
  t.after(closeMemoryRuntime);
  const profile=await runtime.profiles.create(owner,{baseUrl:"https://embedding.fixture.invalid/v1",model:"fixture-embedding",dimensions:3});
  await ensureProfileSchema(runtime.database,profile);
  await runtime.profiles.setStatus(owner,profile.id,"ready");
  await runtime.profiles.activate(owner,profile.id,profile.revision);
  t.mock.method(globalThis,"fetch",async (input: Parameters<typeof fetch>[0],init?: RequestInit)=>{
    assert.ok(String(input).endsWith("/embeddings"),"Recall must not call a story-writing or extraction model");
    assert.ok(JSON.parse(String(init?.body)).input);
    return Response.json({data:[{embedding:[1,0,0]}]});
  });
  const ctx=await loadStoryhavenTurnContext({ownerUserId:owner,actingUserId:owner,sessionId,world});
  assert.deepEqual(ctx.loreEntries.map(e=>e.category),["character","character"]);
  assert.ok(ctx.loreEntries.every(e=>e.always===false));
  const scope={profileId:profile.id,schemaName:profile.schemaName,ownerUserId:owner,sessionId,charId:worldId};
  await ensureIdentity(runtime.database,scope);
  await reconcileAuthoredLore({repositories:createMemoryRepositories(runtime.database,scope,runtime.key),embedding:{embed:async text=>text.includes("UNUSED_ARCHIVE_BIOGRAPHY")?[0,1,0]:[1,0,0],embedQuery:async()=>[1,0,0]},model:{complete:async()=>{throw new Error("Visible biographies need no text generation");}},entries:ctx.loreEntries as AuthoredLoreEntry[],worldId});
  async function request() {
    const turn=await loadTurnMemoryBlocks({ownerUserId:owner,actingUserId:owner,sessionId,session:{},world,query:"Ask Mira about her lesson.",deferRecall:true,model:"custom/test"});
    return fillTurnRecallRequest({turn,world,model:"custom/test",maxContext:1000,trim:{pinnedPrefix:1,pinnedSuffix:0,historyTokens:500},messages:[{role:"system",content:"Rules and current state."},{role:"user",content:"Ask Mira about her lesson."}]});
  }
  const first=await request();
  assert.match(first.map(m=>m.content).join("\n"),/OLD_FIRE_MAGIC/);
  assert.doesNotMatch(first.map(m=>m.content).join("\n"),/UNUSED_ARCHIVE_BIOGRAPHY/);
  world=structuredClone(world);world.entries[0]!.content="Mira now teaches NEW_ICE_MAGIC. "+"Her current lesson concerns ice. ".repeat(100);
  await db.update(worlds).set({schema:world as unknown as Record<string,unknown>}).where(eq(worlds.id,worldId));
  const fresh=await request();
  const text=fresh.map(m=>m.content).join("\n");
  assert.match(text,/NEW_ICE_MAGIC/);assert.doesNotMatch(text,/OLD_FIRE_MAGIC|UNUSED_ARCHIVE_BIOGRAPHY/);
  assert.ok(fresh.reduce((n,m)=>n+estimateTokens(m.content as string,"custom/test"),0)<=1000);
  await db.update(user).set({preferences:{aiConfig:{memoryBudgetTokens:30}}}).where(eq(user.id,owner));
  const capped=await request();
  const recall=capped.filter(m=>m.role==='system'&&String(m.content).startsWith('<story-recall>')).map(m=>m.content).join('\n');
  assert.ok(!recall || estimateTokens(recall,'custom/test')<=70,'An explicit memory ceiling still applies inside the endpoint budget');
  await db.update(user).set({preferences:{aiConfig:{memoryBudgetTokens:null}}}).where(eq(user.id,owner));
  assert.match((await request()).map(m=>m.content).join('\n'),/NEW_ICE_MAGIC/);
  world.entries[1]!.enabled=false;
  await db.update(worlds).set({schema:world as unknown as Record<string,unknown>}).where(eq(worlds.id,worldId));
  const state={variables:{},ruleState:{toggledEntries:{ann:true}}} as any;
  const activated=await loadTurnMemoryBlocks({ownerUserId:owner,actingUserId:owner,sessionId,session:{},world,query:'Ask Ann about the archives.',deferRecall:true,model:'custom/test'});
  const roster=(worldForTurnMemoryPrompt as any)(world,activated,state).entries.find((e:any)=>e.id==='__story_character_roster__')?.content;
  assert.match(roster,/Ann/,'Runtime-enabled names stay in the roster');
  const active=await fillTurnRecallRequest({turn:activated,world,state,model:'custom/test',maxContext:1000,trim:{pinnedPrefix:1,pinnedSuffix:0},messages:[{role:'system',content:'Rules.'},{role:'user',content:'Ask Ann about the archives.'}]});
  assert.match(active.map(m=>m.content).join('\n'),/UNUSED_ARCHIVE_BIOGRAPHY/,'Runtime-enabled biographies remain retrievable');
});

test("StoryHaven semantically retrieves an unnamed instructor without sending a 100-character cast's biographies", async t => {
  await ensureStoryhavenMemoryTables();
  const owner = "semantic-cast-owner", worldId = "semantic-cast-world", sessionId = "semantic-cast-session";
  const world = migrateWorldDefinition({ version: "1.0.0", name: "Academy", entries: [
    { id: "sera", name: "Sera (Seraphine)", role: "character", enabled: true, alwaysSend: true, section: "system-presets", keywords: [], content: "Seraphine is a 247-year-old divine combat instructor who leads academy orientation." },
    { id: "liora", name: "Liora", role: "character", enabled: true, alwaysSend: true, section: "system-presets", keywords: [], content: "Liora is the librarian who leads visitors through the underground archive." },
    ...Array.from({ length: 100 }, (_, i) => ({ id: `archive-${i}`, name: `Archivist ${i}`, role: "character", enabled: true, alwaysSend: true, section: "system-presets", keywords: [], content: `UNNEEDED_ARCHIVE_PROFILE_${i}: tends a remote library.` })),
    { id: "hidden", name: "Hidden Instructor", role: "character", enabled: true, alwaysSend: true, section: "system-presets", keywords: [], memory: { hidden: true }, content: "HIDDEN_INSTRUCTOR_SECRET leads academy orientation." },
    { id: "disabled", name: "Disabled Instructor", role: "character", enabled: false, alwaysSend: true, section: "system-presets", keywords: [], content: "DISABLED_INSTRUCTOR_SECRET leads academy orientation." },
  ], variables: [], rules: [], settings: {} } as unknown as WorldDefinition);
  await db.insert(user).values({ id: owner, name: "Player", email: `${owner}@fixture.invalid` });
  await db.insert(worlds).values({ id: worldId, creatorId: owner, name: "Academy", schema: world as unknown as Record<string, unknown> });
  await db.insert(playSessions).values({ id: sessionId, userId: owner, worldId });
  await db.execute(sql`INSERT INTO storyhaven_memory_sessions(session_id,backend) VALUES(${sessionId},'storyhaven') ON CONFLICT(session_id) DO UPDATE SET backend='storyhaven'`);
  const runtime = await getMemoryRuntime();
  t.after(closeMemoryRuntime);
  const profile = await runtime.profiles.create(owner, { baseUrl: "https://embedding.fixture.invalid/v1", model: "fixture-embedding", dimensions: 3 });
  await ensureProfileSchema(runtime.database, profile);
  await runtime.profiles.setStatus(owner, profile.id, "ready");
  await runtime.profiles.activate(owner, profile.id, profile.revision);
  t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    assert.ok(String(url).endsWith("/embeddings"), "Retrieval must not call a story-writing model");
    return Response.json({ data: [{ embedding: String(init?.body).includes("librarian") ? [0, 1, 0] : [1, 0, 0] }] });
  });
  const context = await loadStoryhavenTurnContext({ ownerUserId: owner, actingUserId: owner, sessionId, world });
  const scope = { profileId: profile.id, schemaName: profile.schemaName, ownerUserId: owner, sessionId, charId: worldId };
  await ensureIdentity(runtime.database, scope);
  const vector = async (text: string) => text.includes("orientation") ? [1, 0, 0] : text.includes("librarian") ? [0, 1, 0] : [0, 0, 1];
  await reconcileAuthoredLore({ repositories: createMemoryRepositories(runtime.database, scope, runtime.key), embedding: { embed: vector, embedQuery: async () => [1, 0, 0] }, model: { complete: async () => "[]" }, entries: context.loreEntries as AuthoredLoreEntry[], worldId });
  const query = "Observe the combat instructor leading academy orientation.";
  const turn = await loadTurnMemoryBlocks({ ownerUserId: owner, actingUserId: owner, sessionId, session: {}, world, query, deferRecall: true, model: "custom/test" });
  const result = await fillTurnRecallRequest({ turn, world, state: { variables: {}, ruleState: {} } as any, messages: [{ role: "system", content: "Rules." }, { role: "user", content: query }], model: "custom/test", maxContext: 700, trim: { pinnedPrefix: 1, pinnedSuffix: 0 } });
  const text = result.map(message => message.content).join("\n");
  assert.match(text, /247-year-old divine combat instructor/);
  assert.doesNotMatch(text, /UNNEEDED_ARCHIVE_PROFILE_|HIDDEN_INSTRUCTOR_SECRET|DISABLED_INSTRUCTOR_SECRET/);
  assert.ok(result.reduce((tokens, message) => tokens + estimateTokens(message.content as string, "custom/test"), 0) <= 700);
  for (const text of ["Follow the librarian to the archive.", "Ask Sera to accompany the librarian."]) {
    const turn = await loadTurnMemoryBlocks({ ownerUserId: owner, actingUserId: owner, sessionId, session: {}, world, query: text, deferRecall: true, model: "custom/test" });
    const prompt = await fillTurnRecallRequest({ turn, world, state: { variables: {}, ruleState: {} } as any, messages: [{ role: "system", content: "Rules." }, { role: "user", content: text }], model: "custom/test", maxContext: 700, trim: { pinnedPrefix: 1, pinnedSuffix: 0 } });
    assert.match(prompt.map(m => m.content).join("\n"), /Liora is the librarian/);
    if (text.includes("Sera")) assert.match(prompt.map(m => m.content).join("\n"), /247-year-old/);
  }
});
