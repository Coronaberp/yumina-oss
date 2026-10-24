import { hydrateStoryWardrobePage, replayStoryWardrobePage } from "./story-sprite-page.js";
import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { estimateTokens, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages } from "../db/schema.js";
import { resolveStoryWardrobes, loadStoryWardrobeBranch, expandWardrobePlaceholder, snapshotStoryWardrobes } from "./story-sprite-wardrobe.js";
import { fillTurnRecallRequest } from "./story-recall-context.js";
import { createMemoryService } from "../memory/service.js";
import type { TurnMemory } from "./turn-memory.js";

const MODEL = "custom/test";
function world(description = "A blue battle coat."): WorldDefinition {
  return {
    id: "wardrobe-world", name: "Wardrobe fixture", version: "20.0.0", variables: [], worldbooks: [], loreUiBindings: [], settings: {},
    entries: [
      { id: "alice", name: "Alice (Alicia)", role: "character", enabled: true, keywords: [], conditions: [], content: "Alice studies magic. Clothing: {{sprite_wardrobe}}" },
      { id: "bob", name: "Bob", role: "character", enabled: true, keywords: [], conditions: [], content: "Bob keeps the archives." },
    ],
    rootComponent: { id: "root", interfaceId: "vn", entryFile: "index.tsx", files: {
      "sprites.ts": "export const sprites = {};\nexport const spriteTypes = {};\nexport const spriteConfig = " + JSON.stringify({types:{normal:"Normal",battle:"Battle",work:"Work"},emotions:{normal:"Normal"}}) + ";\nexport const spriteWardrobeDescriptions = " + JSON.stringify({"Alice (Alicia)":{normal:"A white academy uniform.",battle:description},Bob:{normal:"A brown archive robe."}}) + ";",
    } },
  } as unknown as WorldDefinition;
}
const assistant = (content: string) => ({ role: "assistant", content });
function alice(card: WorldDefinition, history: Array<{ role: string; content: string; rawContent?: string }> = [], state?: any) {
  return resolveStoryWardrobes({world:card,state,branchMessages:history}).find(item => item.entry.id === "alice")!;
}
function turn(sessionId = "fixture-session"): TurnMemory {
  return {sessionId,ownerUserId:"owner",freshStart:false,historyConditions:[],blocks:[],query:"Talk to Alice.",dispatch:{} as any};
}
function memoryContext(sessionId: string, accepted: Array<{id:string;role:string;content:string}> = []) {
  return {sessionId,ownerUserId:"owner",actingUserId:"owner",worldId:"wardrobe-world",mode:"solo",epoch:7,sourceHash:"accepted-prefix",cutoffMessageId:null,query:"Talk to Alice.",messages:accepted,charName:"Alice",userName:"Player",language:"English",castNames:[],canonicalLocation:"",loreEntries:[]};
}

test("wardrobe defaults, latest markers, persistent omission, aliases and case follow runtime semantics", () => {
  const card=world(), before=structuredClone(card);
  assert.equal(alice(card).description,"A white academy uniform.");
  assert.equal(alice(card,[assistant('[SPEAKER:Alice:normal:battle] "Ready."')]).description,"A blue battle coat.");
  assert.equal(alice(card,[assistant('[Name:aLiCiA:happy:BaTtLe] "Ready."')]).type,"battle");
  assert.equal(alice(card,[assistant('[SPEAKER:Alice:normal:battle] "Ready."\n[SPEAKER:Alice:happy] "Back."')]).type,"battle");
  assert.equal(alice(card,[assistant('[SPEAKER:Alice:normal:battle] "Ready."'),assistant('[SPEAKER:Alice:normal:work] "Work."')]).type,"work");
  assert.equal(alice(card,[assistant('[SPEAKER:Alice:normal:missing] "Ready."')]).type,"normal");
  assert.deepEqual(card,before);
  assert.equal(expandWardrobePlaceholder("{{sprite_wardrobe}} / {{ sprite_wardrobe }}","$& coat"),"$& coat / $& coat");
});

test("quoted examples, code, user text and NPC gender cannot select a character wardrobe", () => {
  const card=world();
  for(const content of ['`[SPEAKER:Alice:normal:battle]`','```text\n[SPEAKER:Alice:normal:battle]\n```','"[SPEAKER:Alice:normal:battle] is an example."','    [SPEAKER:Alice:normal:battle]','[SPEAKER:NPC:normal:male:clerk] "Hello."\n[SPEAKER:Narrator:normal:battle] *Quiet.*']) {
    assert.equal(alice(card,[assistant(content)]).observed,false,content);
  }
  assert.equal(alice(card,[{role:"user",content:'[SPEAKER:Alice:normal:battle]'}]).observed,false);
  assert.equal(alice(card,[assistant('[\u200BSPEAKER:Alice:normal:battle] "Ready."')]).type,"battle");
});

test("active raw structured segments preserve order and NPC fourth-field semantics", () => {
  const rawContent=JSON.stringify({segments:[{speaker:"Alice",text:"Ready.",emotion:"normal",spriteType:"battle"},{speaker:"NPC",text:"Halt.",emotion:"normal",npcGender:"male",spriteType:"work"}]});
  assert.equal(alice(world(),[{role:"assistant",content:"Cleaned response.",rawContent}]).type,"battle");
  const reset=JSON.stringify({segments:[{speaker:"Alice",text:"Ready.",spriteType:"battle"},{speaker:"Alice",text:"Rest."}]});
  assert.equal(alice(world(),[{role:"assistant",content:"Cleaned response.",rawContent:reset}]).type,"battle");
});

test("nested variant descriptions stay separate from base clothes and omission preserves a variant", () => {
  const card=world();
  card.rootComponent!.files['sprites.ts'] += '\nexport const spriteVariants = {battle:{formal:"Formal",missing:"Missing art"}};\nexport const spriteVariantSprites = {battle:{formal:{"Alice (Alicia)":{curious:"@asset:formal"}}}};\nexport const spriteVariantWardrobeDescriptions = {"Alice (Alicia)":{battle:{formal:"A silver formal coat."}}};';
  const selected=alice(card,[assistant('[SPEAKER:Alice:curious:battle:formal] "Ready."'),assistant('[SPEAKER:Alice:happy] "Still ready."')]);
  assert.equal(selected.variant,'formal');assert.equal(selected.description,'A silver formal coat.');
  assert.deepEqual(selected.expressions,['curious']);
  const invalid=alice(card,[assistant('[SPEAKER:Alice:curious:battle:formal] "Ready."'),assistant('[SPEAKER:Alice:happy:battle:unknown] "Still ready."')]);
  assert.equal(invalid.variant,'formal');
  const base=alice(card,[assistant('[SPEAKER:Alice:curious:battle:formal] "Ready."'),assistant('[SPEAKER:Alice:happy:battle] "Base."')]);
  assert.equal(base.variant,'');assert.equal(base.description,'A blue battle coat.');
  const absent=alice(card,[assistant('[SPEAKER:Alice:happy:battle:missing] "Missing."')]);
  assert.equal(absent.description,'');assert.deepEqual(absent.expressions,[]);
  assert.doesNotMatch(absent.promptDescription,/blue battle coat|white academy uniform/);
});

test("opening defaults seed current wardrobe and later explicit selections override them", () => {
  const card=world();
  card.rootComponent!.files['sprites.ts'] += '\nexport const spriteChapterDefaults = {greetingB:{"Alice (Alicia)":{type:"battle",variant:"formal"}}};\nexport const spriteVariants = {battle:{formal:"Formal"}};\nexport const spriteVariantWardrobeDescriptions = {"Alice (Alicia)":{battle:{formal:"A silver formal coat."}}};';
  const state={variables:{},activeGreetingId:'greetingB'};
  assert.equal(alice(card,[],state).variant,'formal');
  assert.equal(alice(card,[assistant('[SPEAKER:Alice:happy] "Hello."')],state).variant,'formal');
  assert.equal(alice(card,[assistant('[SPEAKER:Alice:happy:work] "Work."')],state).type,'work');
});

test("backward scan skips omitted wardrobe tags and stops at the selected opening boundary", async () => {
  const f=await sessionFixture();
  f.world.rootComponent!.files['sprites.ts'] += '\nexport const spriteChapterDefaults = {openingB:{"Alice (Alicia)":{type:"work"}}};';
  const old=f.row(0,'[SPEAKER:Alice:normal:battle] "Earlier."',{stateSnapshot:{activeGreetingId:'openingA'}});
  const current=f.row(1,'[SPEAKER:Alice:happy] "Now."',{stateSnapshot:{activeGreetingId:'openingB'}});
  await db.insert(messages).values([old,current]);
  const state={variables:{},activeGreetingId:'openingB'} as any;
  const branch=await loadStoryWardrobeBranch({...f,state,throughMessageId:current.id});
  assert.equal(alice(f.world,branch,state).type,'work');
  assert.equal(branch.length,0);
});

test("visibility gates exclude disabled, hidden and toggled-off characters", () => {
  for(const mode of ["disabled","hidden","toggled"] as const) {
    const card=world();
    if(mode==="disabled")card.entries[0]!.enabled=false;
    if(mode==="hidden")card.entries[0]!.memory={hidden:true};
    const state=mode==="toggled"?{variables:{},ruleState:{toggledEntries:{alice:false}}}:undefined;
    const result=resolveStoryWardrobes({world:card,state:state as any,branchMessages:[assistant('[SPEAKER:Alice:normal:battle] "Ready."')]});
    assert.ok(!result.some(item=>item.entry.id==="alice"));
  }
});

test("an unspecified selected outfit never borrows the normal outfit", async () => {
  const card=world(), selected=alice(card,[assistant('[SPEAKER:Alice:normal:work] "Work."')]);
  assert.equal(selected.description,"");assert.match(selected.promptDescription,/unspecified/i);
  const result=await fillTurnRecallRequest({turn:turn(),world:card,branchMessages:[assistant('[SPEAKER:Alice:normal:work] "Work."')],messages:[{role:"system",content:"Rules."},{role:"user",content:"Talk to Alice."}],model:MODEL,maxContext:1500,trim:{pinnedPrefix:1,pinnedSuffix:0}});
  const text=result.map(item=>item.content).join("\n");
  assert.match(text,/overrides conflicting clothing/);assert.match(text,/wardrobe work is unspecified/);
  assert.doesNotMatch(text,/white academy uniform|blue battle coat/);
});

test("a long CJK outfit still receives bounded current-clothing context", async () => {
  const description="蓝色外套与银色纽扣。".repeat(1000), card=world(description), before=structuredClone(card);
  assert.ok(estimateTokens(description,MODEL)>1500);
  const result=await fillTurnRecallRequest({turn:turn(),world:card,branchMessages:[assistant('[SPEAKER:Alice:normal:battle] "Ready."')],messages:[{role:"system",content:"Rules."},{role:"user",content:"Talk to Alice."}],model:MODEL,maxContext:1800,trim:{pinnedPrefix:1,pinnedSuffix:0}});
  const text=result.map(item=>item.content).join("\n");
  assert.match(text,/Current wardrobe: Alice/);
  assert.match(text,/type=battle/);
  assert.ok(result.reduce((n,item)=>n+estimateTokens(item.content as string,MODEL),0)<=1800);
  assert.deepEqual(card,before);
});

test("configured recall expands clothing only in copied candidates and uses destination budget", async () => {
  const card=world(), before=structuredClone(card), ctx=memoryContext("fixture-session");
  const loreEntry={id:card.id+":alice",name:card.entries[0]!.name,category:"character",content:card.entries[0]!.content,query_matched:true};
  const scope={profileId:"fixture",schemaName:"shm_"+"a".repeat(32),ownerUserId:"owner",sessionId:"fixture-session",charId:card.id};
  const repositories:any={facts:{context:{scope},getSceneState:async()=>({location:"",npcs:[]}),similarLive:async()=>[],reserved:async()=>[]},lore:{getAllOverridesForSession:async()=>({}),linksFor:async()=>[],byIds:async()=>[],chunksFor:async()=>[]},vectors:{searchLoreChunks:async()=>[]},clusters:{latestForSession:async()=>null,activeForSession:async()=>[]}};
  const service=createMemoryService({repositories,embedding:{embed:async()=>[1],embedQuery:async()=>[1]},model:{complete:async()=>{throw Error("Recall must not generate text");}}});
  let calls=0;
  const active=turn();active.storyhaven={context:ctx,input:{ownerUserId:"owner",actingUserId:"owner",sessionId:active.sessionId,world:card},adapter:{
    retrieveStoryhavenMemory:async (input:any)=>{calls++;assert.equal(input.world,card);assert.equal(input.loreWardrobeValues?.[card.id+":alice"],"A blue battle coat.");
      const result=await service.retrieveBlock({...ctx,loreEntries:[loreEntry],memoryBudgetTokens:input.memoryBudgetTokens,promptTokenCounter:(text:string)=>estimateTokens(text,MODEL),loreWardrobeValues:input.loreWardrobeValues});
      assert.doesNotMatch(result.block,/\{\{\s*sprite_wardrobe/);assert.match(result.block,/blue battle coat/);
      assert.ok(estimateTokens(result.block,MODEL)<=(input.memoryBudgetTokens??0));return{enabled:true,context:ctx,result};},
    ensureStoryhavenSnapshotCurrent:async()=>true,scheduleStoryhavenMemory:async()=>{},
  } as any};
  const prompt=await fillTurnRecallRequest({turn:active,world:card,branchMessages:[assistant('[SPEAKER:Alice:normal:battle] "Ready."')],messages:[{role:"system",content:"Rules."},{role:"user",content:"Talk to Alice."}],model:MODEL,maxContext:1500,trim:{pinnedPrefix:1,pinnedSuffix:0}});
  assert.equal(calls,1);assert.match(prompt.map(item=>item.content).join("\n"),/Current wardrobe: Alice/);
  assert.equal(loreEntry.content,before.entries[0]!.content);assert.deepEqual(card,before);
});

async function sessionFixture() {
  const owner=crypto.randomUUID(), wid=crypto.randomUUID(), card=world();card.id=wid;card.entries=card.entries.slice(0,1);
  await db.insert(user).values({id:owner,name:"Wardrobe fixture",email:owner+"@test.invalid"});
  await db.insert(worlds).values({id:wid,creatorId:owner,name:card.name,status:"draft",schema:card as unknown as Record<string,unknown>});
  const [session]=await db.insert(playSessions).values({userId:owner,worldId:wid,state:{variables:{},metadata:{}}}).returning();
  const active=turn(session!.id);active.ownerUserId=owner;
  const row=(index:number,content:string,extra:Record<string,unknown>={})=>({id:crypto.randomUUID(),sessionId:session!.id,role:"assistant" as const,content,createdAt:new Date(Date.UTC(2026,0,1)+index*1000),...extra});
  return{sessionId:session!.id,turn:active,world:card,row};
}

test("prefix scan finds a compacted wardrobe older than multiple recent pages", async () => {
  const f=await sessionFixture(), rows=[f.row(0,'[SPEAKER:Alice:normal:battle] "Ready."',{compacted:true}),...Array.from({length:270},(_,i)=>f.row(i+1,'[SPEAKER:Narrator:normal] *Time passes.*'))];
  await db.insert(messages).values(rows);
  const branch=await loadStoryWardrobeBranch({...f,throughMessageId:rows.at(-1)!.id});
  assert.equal(alice(f.world,branch).type,"battle");assert.equal(branch.length,1);
});

test("regeneration cutoff excludes target and future wardrobe changes", async () => {
  const f=await sessionFixture(), old=f.row(0,'[SPEAKER:Alice:normal:battle] "Ready."'), target=f.row(1,'[SPEAKER:Alice:normal:work] "Work."'),future=f.row(2,'[SPEAKER:Alice:normal] "Rest."');
  await db.insert(messages).values([old,target,future]);
  const branch=await loadStoryWardrobeBranch({...f,before:{id:target.id,createdAt:target.createdAt}});
  assert.equal(alice(f.world,branch).type,"battle");
});

test("prefix scan follows active raw swipe and ignores failed newer replies", async () => {
  const f=await sessionFixture(), selected=f.row(0,'Cleaned response.',{activeSwipeIndex:1,swipes:[{content:"Old.",rawContent:'[SPEAKER:Alice:normal:work] "Work."'},{content:"Cleaned response.",rawContent:JSON.stringify({segments:[{speaker:"Alice",text:"Ready.",spriteType:"battle"}]})}]}),failed=f.row(1,'[SPEAKER:Alice:normal] "Rest."',{status:"failed"});
  await db.insert(messages).values([selected,failed]);
  const branch=await loadStoryWardrobeBranch({...f,throughMessageId:failed.id});assert.equal(alice(f.world,branch).type,"battle");
});

test("current-run reset and freshStart stop outfits from previous stories", async () => {
  const f=await sessionFixture(),old=f.row(0,'[SPEAKER:Alice:normal:battle] "Ready."'),reset=f.row(1,'[CHARACTER_CREATE] A new story.'),latest=f.row(2,'[SPEAKER:Narrator:normal] *Quiet.*');
  await db.insert(messages).values([old,reset,latest]);
  assert.equal(alice(f.world,await loadStoryWardrobeBranch({...f,throughMessageId:latest.id})).type,"normal");
  f.turn.freshStart=true;assert.deepEqual(await loadStoryWardrobeBranch({...f}),[]);
});

test("accepted memory prefix prevents a later live wardrobe from leaking in", async () => {
  const f=await sessionFixture(),old=f.row(0,'[SPEAKER:Alice:normal:battle] "Ready."'),later=f.row(1,'[SPEAKER:Alice:normal:work] "Work."');await db.insert(messages).values([old,later]);
  const ctx=memoryContext(f.sessionId,[old]);let checks=0;
  f.turn.storyhaven={context:ctx,adapter:{ensureStoryhavenSnapshotCurrent:async()=>{checks++;return true;}} as any};
  const branch=await loadStoryWardrobeBranch({...f,throughMessageId:later.id});assert.equal(alice(f.world,branch).type,"battle");assert.equal(checks,2);
});


test("snapshot wardrobes preserve before and after independently of paged messages", () => {
 const card=world(), state={activeGreetingId:'opening',metadata:{}} as any;
 const saved=snapshotStoryWardrobes({world:card,beforeState:state,finalState:state,branchMessages:[assistant('[SPEAKER:Alice:normal:battle] Ready.')],content:'[SPEAKER:Alice:normal] First.\n[SPEAKER:Alice:normal:work] Later.'});
 const baseline=saved.metadata.vnSpriteWardrobes as any;
 assert.equal(baseline.before['Alice (Alicia)']!.type,'battle');
 assert.equal(baseline.after['Alice (Alicia)']!.type,'work');
 assert.deepEqual(state.metadata,{});
 const reset=snapshotStoryWardrobes({world:card,beforeState:state,finalState:{...state,activeGreetingId:'new'},branchMessages:[assistant('[SPEAKER:Alice:normal:battle] Ready.')],content:'[SPEAKER:Alice:normal] First.'});
 assert.equal((reset.metadata.vnSpriteWardrobes as any).before['Alice (Alicia)']!.type,'normal');
 const create=snapshotStoryWardrobes({world:card,beforeState:state,finalState:state,branchMessages:[assistant('[SPEAKER:Alice:normal:battle] Ready.')],content:'[CHARACTER_CREATE]\n[SPEAKER:Alice:normal] First.'});
 assert.equal((create.metadata.vnSpriteWardrobes as any).after['Alice (Alicia)']!.type,'normal');
});

test("continuation snapshots keep the original before map while replaying the original structured reply", () => {
 const card=world(), state={activeGreetingId:'opening',metadata:{}} as any;
 const saved=snapshotStoryWardrobes({world:card,beforeState:state,finalState:state,
  branchMessages:[assistant('[SPEAKER:Alice:normal:battle] Ready.')],
  previousReply:{role:'assistant',content:'First.',rawContent:JSON.stringify({segments:[{speaker:'Alice',text:'First.',spriteType:'work'}]})},
  content:'[SPEAKER:Alice:normal] More.'});
 const baseline=saved.metadata.vnSpriteWardrobes as any;
 assert.equal(baseline.before['Alice (Alicia)']!.type,'battle');
 assert.equal(baseline.after['Alice (Alicia)']!.type,'work');
});

test("read hydration restores pruned and compacted outfits before the earliest page, following active swipes only", async () => {
 const f=await sessionFixture();
 const rows=[f.row(0,'Cleaned reply.',{compacted:true,activeSwipeIndex:1,swipes:[{content:'Unused.',rawContent:'[SPEAKER:Alice:normal:work] Unused.'},{content:'Cleaned reply.',rawContent:'[SPEAKER:Alice:normal:battle] Selected.'}]}),
  ...Array.from({length:270},(_,i)=>f.row(i+1,'[SPEAKER:Alice:normal] Time passes.')),
  f.row(271,'[SPEAKER:Alice:normal] Early.\n[SPEAKER:Alice:normal:work] Later.'),
  f.row(272,'[SPEAKER:Alice:normal] Still here.'),
  f.row(273,'[SPEAKER:Alice:normal] Future reset.',{swipes:[{content:'Future.',rawContent:'[SPEAKER:Alice:normal:normal] Future.'}]})];
 const stored=await db.insert(messages).values(rows).returning();
 const page=await hydrateStoryWardrobePage({sessionId:f.sessionId,world:f.world,rows:stored.slice(271,273)});
 const first=page[0]!.spriteWardrobeSnapshot!, second=page[1]!.spriteWardrobeSnapshot!;
 assert.equal(first.before['Alice (Alicia)']!.type,'battle');
 assert.equal(first.after['Alice (Alicia)']!.type,'work');
 assert.equal(second.before['Alice (Alicia)']!.type,'work');
 assert.equal(page[0]!.stateSnapshot,null);
 assert.equal(stored[271]!.stateSnapshot,null);
});

test("pure historical page replay clears wardrobe state at a saved opening boundary", () => {
 const card=world();card.rootComponent!.files['sprites.ts']+='\nexport const spriteChapterDefaults={openingB:{"Alice (Alicia)":{type:"work"}}};';
 const page=replayStoryWardrobePage({world:card,openingId:'openingA',initialSelections:{'Alice (Alicia)':{type:'battle',variant:''}},rows:[
  {id:'a',role:'assistant',content:'[SPEAKER:Alice:normal] Old.',createdAt:null,stateSnapshot:{activeGreetingId:'openingA'}},
  {id:'b',role:'assistant',content:'[SPEAKER:Alice:normal] New.',createdAt:null,stateSnapshot:{activeGreetingId:'openingB'}},
 ]});
 assert.equal(page[0]!.spriteWardrobeSnapshot!.before['Alice (Alicia)']!.type,'battle');
 assert.equal(page[1]!.spriteWardrobeSnapshot!.before['Alice (Alicia)']!.type,'work');
});

test("read hydration ignores stale stored before and after maps after an earlier accepted outfit change", async () => {
 const f=await sessionFixture();
 const stale={version:1,openingId:null,before:{'Alice (Alicia)':{type:'work',variant:''}},after:{'Alice (Alicia)':{type:'work',variant:''}}};
 const stored=await db.insert(messages).values([
  f.row(0,'Selected alternate.',{activeSwipeIndex:1,swipes:[{content:'Old.',rawContent:'[SPEAKER:Alice:normal:work] Old.'},{content:'Selected alternate.',rawContent:'[SPEAKER:Alice:normal:battle] Changed.'}]}),
  f.row(1,'[SPEAKER:Alice:normal] Omitted.',{stateSnapshot:{metadata:{vnSpriteWardrobes:stale}}}),
  f.row(2,'[SPEAKER:Alice:normal] Later.',{stateSnapshot:{metadata:{vnSpriteWardrobes:stale}}}),
 ]).returning();
 const page=await hydrateStoryWardrobePage({sessionId:f.sessionId,world:f.world,rows:stored.slice(2)});
 assert.equal(page[0]!.spriteWardrobeSnapshot!.before['Alice (Alicia)']!.type,'battle');
 assert.equal(page[0]!.spriteWardrobeSnapshot!.after['Alice (Alicia)']!.type,'battle');
 const replay=replayStoryWardrobePage({world:f.world,openingId:null,initialSelections:{'Alice (Alicia)':{type:'battle',variant:''}},rows:stored.slice(1)});
 assert.equal(replay[0]!.spriteWardrobeSnapshot!.before['Alice (Alicia)']!.type,'battle');
 assert.equal(replay[1]!.spriteWardrobeSnapshot!.after['Alice (Alicia)']!.type,'battle');
});
