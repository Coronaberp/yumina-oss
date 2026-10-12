import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, account, session } from "../db/schema.js";
import { env } from "../lib/env.js";
import { ensureLocalAdminAccount } from "../lib/local-admin.js";

test("GitHub OAuth reuses the pinned admin account, creates separate normal accounts, and blocks password sign-in", async () => {
  const owner=crypto.randomUUID();
  await db.insert(user).values({id:owner,name:"Local player",email:"local@yumina.local",username:"local",preferences:{personaId:"kept"}});
  await db.insert(session).values({id:"legacy-shared",token:"fake-old-token",userId:owner,expiresAt:new Date(Date.now()+60000)});
  env.YUMINA_EDITION="local";env.YUMINA_AUTH_MODE="multi-user";env.YUMINA_SIGN_IN_METHOD="github";
  env.GITHUB_CLIENT_ID="test-client";env.GITHUB_CLIENT_SECRET="test-oauth-secret";
  env.YUMINA_ADMIN_ACCOUNT_ID=owner;env.YUMINA_ADMIN_GITHUB_ID="123456";
  await ensureLocalAdminAccount(owner,true);
  assert.equal((await db.select().from(session)).length,0);
  const {auth}=await import("../lib/auth.js");
  const {authRoutes}=await import("./auth.js");
  const {Hono}=await import("hono");const app=new Hono();app.route("/api/auth",authRoutes);
  let profileId=123456;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async input=>{
    const url=String(input instanceof Request?input.url:input);
    const email=`github-${profileId}@example.test`;
    if(url.startsWith("https://github.com/login/oauth/access_token"))return Response.json({access_token:"fake-oauth-token",token_type:"bearer",scope:"read:user user:email"});
    if(url==="https://api.github.com/user/emails")return Response.json([{email,primary:true,verified:true}]);
    if(url==="https://api.github.com/user")return Response.json({id:profileId,login:`github${profileId}`,name:"GitHub user",email,avatar_url:"https://example.test/avatar.png"});
    throw new Error("Unexpected network request in OAuth fixture");
  };
  try {
    const login=async()=>{
      const response=await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/social",{method:"POST",headers:{"Content-Type":"application/json",Origin:"http://localhost:3000"},body:JSON.stringify({provider:"github",callbackURL:"/app/library"})}));
      assert.equal(response.status,200);
      const body=await response.json() as {url:string};const state=new URL(body.url).searchParams.get("state");assert.ok(state);
      const cookie=response.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
      const callback=await auth.handler(new Request(`http://localhost:3000/api/auth/callback/github?code=fake-code&state=${encodeURIComponent(state)}`,{headers:{cookie}}));
      assert.equal(callback.status,302);assert.ok(!callback.headers.get("location")?.includes("error"),callback.headers.get("location")||"");
      const sessionCookie=callback.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
      const authenticated=await auth.api.getSession({headers:new Headers({cookie:sessionCookie})});assert.ok(authenticated);
      return authenticated.user.id;
    };
    assert.equal(await login(),owner);
    const [retained]=await db.select().from(user).where(eq(user.id,owner));assert.equal(retained!.role,"admin");assert.deepEqual(retained!.preferences,{personaId:"kept"});
    assert.equal((await db.select().from(account).where(eq(account.userId,owner)))[0]!.accountId,"123456");
    const count=(await db.select().from(session)).length;await ensureLocalAdminAccount(owner,true);assert.equal((await db.select().from(session)).length,count);
    profileId=654321;const other=await login();assert.notEqual(other,owner);assert.equal((await db.select().from(user).where(eq(user.id,other)))[0]!.role,"user");
    for(const path of ["sign-in/email","sign-in/username","sign-up/email","set-password","request-password-reset"]){const denied=await app.request(`/api/auth/${path}`,{method:"POST",headers:{"Content-Type":"application/json",Origin:"http://localhost:3000"},body:"{}"});assert.equal(denied.status,403,path);}
  } finally {globalThis.fetch=originalFetch;}
});
