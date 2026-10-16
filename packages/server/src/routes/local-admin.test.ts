import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";
import type { AppEnv } from "../lib/types.js";
import { createLocalAdminRoutes } from "./local-admin.js";

test("admin GitHub settings reject ordinary users and cross-site writes without exposing secrets", async () => {
  const owner=crypto.randomUUID(),other=crypto.randomUUID();
  await db.insert(user).values([{id:owner,name:"Admin",email:"admin@example.test",role:"admin"},{id:other,name:"Other",email:"other@example.test"}]);
  const dir=mkdtempSync(join(tmpdir(),"yumina-admin-route-")),file=join(dir,".env");
  writeFileSync(file,"GITHUB_CLIENT_SECRET=hidden-existing-secret\n");
  const app=new Hono<AppEnv>();
  app.route("/api/admin",createLocalAdminRoutes({file,publicOrigin:"http://localhost:5173",adminAccountId:owner,resolveIdentity:async()=>({id:123,login:"Owner"}),authenticate:async(c,next)=>{c.set("user",{id:c.req.header("x-test-user")||other} as AppEnv["Variables"]["user"]);await next();}}));
  try {
    assert.equal((await app.request("/api/admin/authentication")).status,403);
    const response=await app.request("/api/admin/authentication",{headers:{"x-test-user":owner}});assert.equal(response.status,200);assert.ok(!(await response.text()).includes("hidden-existing-secret"));
    const body=JSON.stringify({clientId:"client",clientSecret:"private-new-secret",adminGitHubLogin:"owner"});
    const patch=(origin:string,id=owner)=>app.request("/api/admin/authentication",{method:"PATCH",headers:{"content-type":"application/json",origin,"x-test-user":id},body});
    assert.equal((await patch("https://foreign.example")).status,403);assert.equal((await patch("http://localhost:5173",other)).status,403);
    assert.equal(readFileSync(file,"utf8"),"GITHUB_CLIENT_SECRET=hidden-existing-secret\n");
    const saved=await patch("http://localhost:5173");assert.equal(saved.status,200);assert.ok(!(await saved.text()).includes("private-new-secret"));
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("admin can persistently pause and resume local image generation without changing authentication", async () => {
  const owner=crypto.randomUUID(),other=crypto.randomUUID();
  await db.insert(user).values([{id:owner,name:"Image admin",email:`${owner}@example.test`,role:"admin"},{id:other,name:"Other",email:`${other}@example.test`}]);
  const dir=mkdtempSync(join(tmpdir(),"yumina-image-admin-")),file=join(dir,".env"),imageGenerationFile=join(dir,"image-generation.json");
  writeFileSync(file,"GITHUB_CLIENT_SECRET=keep-existing-secret\n");
  const makeApp=()=>new Hono<AppEnv>().route("/api/admin",createLocalAdminRoutes({file,imageGenerationFile,publicOrigin:"http://localhost:5173",authenticate:async(c,next)=>{c.set("user",{id:c.req.header("x-test-user")||other} as AppEnv["Variables"]["user"]);await next();}}));
  const headers={"content-type":"application/json",origin:"http://localhost:5173","x-test-user":owner};
  try {
    const app=makeApp();
    assert.equal((await app.request("/api/admin/image-generation")).status,403);
    const initial=await app.request("/api/admin/image-generation",{headers});
    assert.equal(initial.status,200);
    assert.equal(initial.headers.get("Cache-Control"),"no-store");
    assert.deepEqual(await initial.json(),{data:{enabled:true}});
    for(const rejected of [{...headers,origin:"https://foreign.example"},{...headers,"x-test-user":other}]) {
      assert.equal((await app.request("/api/admin/image-generation",{method:"PATCH",headers:rejected,body:JSON.stringify({enabled:false})})).status,403);
    }
    assert.equal((await app.request("/api/admin/image-generation",{method:"PATCH",headers,body:JSON.stringify({enabled:"false"})})).status,400);
    const paused=await app.request("/api/admin/image-generation",{method:"PATCH",headers,body:JSON.stringify({enabled:false})});
    assert.equal(paused.status,200);
    assert.deepEqual(await paused.json(),{data:{enabled:false}});
    assert.deepEqual(await (await makeApp().request("/api/admin/image-generation",{headers})).json(),{data:{enabled:false}});
    const resumed=await makeApp().request("/api/admin/image-generation",{method:"PATCH",headers,body:JSON.stringify({enabled:true})});
    assert.deepEqual(await resumed.json(),{data:{enabled:true}});
    assert.equal(readFileSync(file,"utf8"),"GITHUB_CLIENT_SECRET=keep-existing-secret\n");
  } finally {rmSync(dir,{recursive:true,force:true});}
});
