import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions } from "../db/schema.js";
import { worldRoutes } from "./worlds.js";
import { sessionRoutes } from "./sessions.js";
import { worldEditLockMiddleware } from "../lib/world-edit-lock.js";
import type { AppEnv } from "../lib/types.js";
import { env } from "../lib/env.js";

test("installation examples are visible and playable without opening other private cards or writes", async t => {
  env.YUMINA_EDITION="local";
  const owner=crypto.randomUUID(), viewer=crypto.randomUUID();
  const vn=crypto.randomUUID(), chat=crypto.randomUUID(), privateId=crypto.randomUUID();
  await db.insert(user).values([{id:owner,name:"Creator",email:owner+"@test.invalid"},{id:viewer,name:"Viewer",email:viewer+"@test.invalid"}]);
  const schema={id:vn,version:"1.0.0",name:"Academy example",entries:[],variables:[],rules:[],settings:{}};
  await db.insert(worlds).values([
    {id:vn,creatorId:owner,name:"VN example",schema,editingLocked:true},
    {id:chat,creatorId:owner,name:"Chat example",schema,editingLocked:true},
    {id:privateId,creatorId:owner,name:"Private locked story",schema,editingLocked:true},
  ]);
  process.env.YUMINA_SHARED_WORLD_IDS=`${vn},${chat}`;
  let actor:string|null=viewer;
  const app=new Hono<AppEnv>();
  app.use("*",async(c,next)=>{ if(actor)c.set("user",{id:actor,name:"Viewer"} as AppEnv["Variables"]["user"]);await next(); });
  app.use("/api/*",worldEditLockMiddleware);
  for (const [method,path] of [["GET","/"],["GET","/:id"],["GET","/:id/context-requirement"],["PATCH","/:id/editing-lock"]]) {
    const route=worldRoutes.routes.filter(r=>r.method===method&&r.path===path).at(-1);
    assert.ok(route);
    app.on(method!,"/api/worlds"+(path==="/"?"":path),route.handler);
  }
  const createSession=sessionRoutes.routes.filter(r=>r.method==="POST"&&r.path==="/").at(-1);
  assert.ok(createSession);app.post("/api/sessions",createSession.handler);
  let writes=0;
  app.patch("/api/worlds/:id",c=>{writes++;return c.json({ok:true});});
  await t.test("both configured examples appear, even though they remain drafts",async()=>{
    const response=await app.request("/api/worlds");assert.equal(response.status,200);
    const {data}=await response.json() as { data: any };
    assert.deepEqual(data.map((w:any)=>w.id).sort(),[vn,chat].sort());
    assert.ok(data.every((w:any)=>w.sharedInLibrary===true&&w.editingLocked===true));
  });
  await t.test("a viewer can inspect the full source while the card stays locked",async()=>{
    for(const id of [vn,chat]){
      const response=await app.request(`/api/worlds/${id}?forEdit=1`);assert.equal(response.status,200);
      const {data}=await response.json() as { data: any };assert.deepEqual(data.schema,schema);assert.equal(data.editingLocked,true);assert.equal(data.sharedInLibrary,true);
    }
    assert.equal((await app.request(`/api/worlds/${privateId}?forEdit=1`)).status,404);
    actor=null;assert.equal((await app.request(`/api/worlds/${vn}?forEdit=1`)).status,404);actor=viewer;
  });
  await t.test("viewers can start their own playthrough without changing the example",async()=>{
    const response=await app.request("/api/sessions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({worldId:vn})});
    assert.equal(response.status,201);
    const {data}=await response.json() as { data: any };
    assert.equal(data.userId,viewer);assert.equal(data.worldId,vn);assert.equal(data.ephemeral,false);
    assert.equal((await db.select().from(playSessions).where(eq(playSessions.id,data.id))).length,1);
    const denied=await app.request("/api/sessions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({worldId:privateId})});
    assert.equal(denied.status,403);
  });
  await t.test("the existing lock blocks edits and cannot be removed by viewers",async()=>{
    assert.equal((await app.request(`/api/worlds/${vn}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Changed"})})).status,403);
    assert.equal(writes,0);
    assert.equal((await app.request(`/api/worlds/${vn}/editing-lock`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({locked:false})})).status,404);
    const [world]=await db.select().from(worlds).where(eq(worlds.id,vn));assert.equal(world!.editingLocked,true);assert.deepEqual(world!.schema,schema);
  });
});
