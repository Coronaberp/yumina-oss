import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, studioConversations, agentRuns } from "../db/schema.js";
import { createScopedStudioRun, resumeScopedStudioApproval, writeScopedStudioWorldSchema } from "./studio-run-scope.js";

test("starting a second conversation preserves the first run; replacement affects only its own conversation", async () => {
  const uid=crypto.randomUUID(),wid=crypto.randomUUID(),a=crypto.randomUUID(),b=crypto.randomUUID();
  await db.insert(user).values({id:uid,email:`${uid}@example.test`,name:"Scope QA"});
  await db.insert(worlds).values({id:wid,creatorId:uid,name:"Scope QA",schema:{}});
  await db.insert(studioConversations).values([{id:a,worldId:wid,userId:uid,title:"A"},{id:b,worldId:wid,userId:uid,title:"B"}]);
  try {
    const start=(conversationId:string|null)=>createScopedStudioRun({worldId:wid,userId:uid,conversationId,model:"test",status:"running",messages:[],maxIterations:50});
    const first=await start(a),second=await start(b);
    assert.deepEqual(second.supersededIds,[]);
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id,first.run.id)))[0]!.status,"running");
    const replacement=await start(a);
    assert.deepEqual(replacement.supersededIds,[first.run.id]);
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id,second.run.id)))[0]!.status,"running");
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id,first.run.id)))[0]!.status,"error");
    const unnamed=await start(null);assert.deepEqual(unnamed.supersededIds,[]);
    const unnamedAgain=await start(null);assert.deepEqual(unnamedAgain.supersededIds,[unnamed.run.id]);
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id,replacement.run.id)))[0]!.status,"running");
  } finally {await db.delete(user).where(eq(user.id,uid));}
});

test("an invalid conversation cannot supersede an owned task",async()=>{
  const uid=crypto.randomUUID(),wid=crypto.randomUUID();
  await db.insert(user).values({id:uid,email:`${uid}@example.test`,name:"Scope QA"});
  await db.insert(worlds).values({id:wid,creatorId:uid,name:"Scope QA",schema:{}});
  try {
    const first=await createScopedStudioRun({worldId:wid,userId:uid,conversationId:null,model:"test",status:"running"});
    await assert.rejects(createScopedStudioRun({worldId:wid,userId:uid,conversationId:crypto.randomUUID(),model:"test",status:"running"}),/conversation/i);
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id,first.run.id)))[0]!.status,"running");
  }finally{await db.delete(user).where(eq(user.id,uid));}
});


test("independent chats serialize saves without losing edits, including held edits and stopped-worker fencing", async () => {
  const uid=crypto.randomUUID();
  await db.insert(user).values({id:uid,email:`${uid}@example.test`,name:"Scope QA"});
  try {
    for (const status of ["draft", "published"] as const) {
      const wid=crypto.randomUUID(), a=crypto.randomUUID(), b=crypto.randomUUID();
      const initial={name:"Concurrent card",entries:[],variables:[],description:"original"};
      await db.insert(worlds).values({id:wid,creatorId:uid,name:initial.name,status,schema:initial});
      await db.insert(studioConversations).values([{id:a,worldId:wid,userId:uid,title:"A"},{id:b,worldId:wid,userId:uid,title:"B"}]);
      const first=await createScopedStudioRun({worldId:wid,userId:uid,conversationId:a,model:"test"});
      const second=await createScopedStudioRun({worldId:wid,userId:uid,conversationId:b,model:"test"});
      const scopeA={worldId:wid,userId:uid,runId:first.run.id},scopeB={worldId:wid,userId:uid,runId:second.run.id};
      const changedA={...initial,description:"Written by A"};
      await writeScopedStudioWorldSchema({...scopeA,expectedSchema:initial,schema:changedA});
      await assert.rejects(writeScopedStudioWorldSchema({...scopeB,expectedSchema:initial,schema:{...initial,name:"Written by B"}}),/STALE_STUDIO_WORLD_SCHEMA/);
      const { captureStudioCreditWorldRevision }=await import("./studio-credit-checkpoint.js");
      const current=await captureStudioCreditWorldRevision(scopeB);
      assert.equal(current.schema.description,"Written by A");
      await writeScopedStudioWorldSchema({...scopeB,expectedSchema:current.schema,schema:{...current.schema,name:"Written by B"}});
      const final=await captureStudioCreditWorldRevision(scopeB);
      assert.equal(final.schema.description,"Written by A");assert.equal(final.schema.name,"Written by B");
      await createScopedStudioRun({worldId:wid,userId:uid,conversationId:a,model:"test"});
      await assert.rejects(writeScopedStudioWorldSchema({...scopeA,expectedSchema:final.schema,schema:initial}),/STUDIO_RUN_NO_LONGER_ACTIVE/);
    }
  } finally {await db.delete(user).where(eq(user.id,uid));}
});

test("approving a paused task checks only its own conversation", async () => {
  const uid=crypto.randomUUID(),wid=crypto.randomUUID(),a=crypto.randomUUID(),b=crypto.randomUUID();
  await db.insert(user).values({id:uid,email:`${uid}@example.test`,name:"Scope QA"});
  await db.insert(worlds).values({id:wid,creatorId:uid,name:"Scope QA",schema:{}});
  await db.insert(studioConversations).values([{id:a,worldId:wid,userId:uid,title:"A"},{id:b,worldId:wid,userId:uid,title:"B"}]);
  try {
    const first=await createScopedStudioRun({worldId:wid,userId:uid,conversationId:a,model:"test",status:"awaiting_approval"});
    const second=await createScopedStudioRun({worldId:wid,userId:uid,conversationId:b,model:"test"});
    const resumed=await resumeScopedStudioApproval({worldId:wid,userId:uid,runId:first.run.id});
    assert.equal(resumed.blocked,false);assert.equal(resumed.run?.status,"running");
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id,second.run.id)))[0]!.status,"running");
    const paused=await createScopedStudioRun({worldId:wid,userId:uid,conversationId:a,model:"test",status:"awaiting_approval"});
    await createScopedStudioRun({worldId:wid,userId:uid,conversationId:a,model:"test"});
    assert.equal((await resumeScopedStudioApproval({worldId:wid,userId:uid,runId:paused.run.id})).blocked,true);
  } finally {await db.delete(user).where(eq(user.id,uid));}
});


test("resuming a credit pause is independent of a running task in another conversation", async () => {
  const uid=crypto.randomUUID(),wid=crypto.randomUUID(),a=crypto.randomUUID(),b=crypto.randomUUID();
  await db.insert(user).values({id:uid,email:`${uid}@example.test`,name:"Scope QA"});
  await db.insert(worlds).values({id:wid,creatorId:uid,name:"Scope QA",schema:{name:"Scope QA"}});
  await db.insert(studioConversations).values([{id:a,worldId:wid,userId:uid,title:"A"},{id:b,worldId:wid,userId:uid,title:"B"}]);
  try {
    const {captureStudioCreditWorldRevision,claimStudioCreditResume}=await import("./studio-credit-checkpoint.js");
    const snapshot=await captureStudioCreditWorldRevision({worldId:wid,userId:uid});
    const first=await createScopedStudioRun({worldId:wid,userId:uid,conversationId:a,model:"test",status:"awaiting_credits",creditCheckpoint:{
      version:1,phase:"preflight",messages:[{role:"user",content:"Continue QA"}],iteration:0,worldRevision:snapshot.revision,requiredCredits:1,
    }});
    const second=await createScopedStudioRun({worldId:wid,userId:uid,conversationId:b,model:"test"});
    const resumed=await claimStudioCreditResume({worldId:wid,userId:uid,runId:first.run.id});
    assert.equal(resumed.ok,true);
    assert.equal((await db.select().from(agentRuns).where(eq(agentRuns.id,second.run.id)))[0]!.status,"running");
    await db.update(agentRuns).set({status:"awaiting_credits"}).where(eq(agentRuns.id,first.run.id));
    await createScopedStudioRun({worldId:wid,userId:uid,conversationId:a,model:"test"});
    const blocked=await claimStudioCreditResume({worldId:wid,userId:uid,runId:first.run.id});
    assert.equal(blocked.ok,false);if(!blocked.ok)assert.equal(blocked.code,"ACTIVE_RUN");
  }finally{await db.delete(user).where(eq(user.id,uid));}
});

test("answering an essential question preserves the original goal and its checklist",async()=>{
 const uid=crypto.randomUUID(),wid=crypto.randomUUID(),cid=crypto.randomUUID();
 await db.insert(user).values({id:uid,email:`${uid}@example.test`,name:"Scope QA"});
 await db.insert(worlds).values({id:wid,creatorId:uid,name:"QA",schema:{}});
 await db.insert(studioConversations).values({id:cid,worldId:wid,userId:uid,title:"QA"});
 try{
  const {createStudioTask,upsertTaskRequirements}=await import("./studio-task.js");
  const task=upsertTaskRequirements(createStudioTask("Fix every character role","work"),[{id:"roles",text:"All characters have character roles",checks:[]}]);task.status="needs_input";
  await createScopedStudioRun({worldId:wid,userId:uid,conversationId:cid,model:"test",status:"awaiting_user",context:{studioTask:task}});
  const next=await createScopedStudioRun({worldId:wid,userId:uid,conversationId:cid,model:"test",context:{}},"Only chapter two.");
  assert.equal((next.run.context!.studioTask as any).goal,task.goal);assert.equal((next.run.context!.studioTask as any).requirements.length,1);assert.equal((next.run.context!.studioTask as any).planRequired,true);assert.deepEqual((next.run.context!.studioTask as any).additionalRequests,["Only chapter two."]);
 }finally{await db.delete(user).where(eq(user.id,uid));}
});
