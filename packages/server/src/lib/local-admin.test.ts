import "../test/database-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";
import { ensureLocalAdminAccount, adminIdentityForGitHub } from "./local-admin.js";

test("promotion retains the existing account and only the pinned GitHub identity can claim it", async () => {
  const owner=crypto.randomUUID(),other=crypto.randomUUID();
  const preferences={activeApiKeyId:"existing-key",personaId:"existing-persona"};
  await db.insert(user).values([{id:owner,name:"Local player",email:"owner@yumina.local",username:"local",preferences},{id:other,name:"Other",email:"other@example.test"}]);
  await ensureLocalAdminAccount(owner);
  const read=async(id:string)=>(await db.select().from(user).where(eq(user.id,id)))[0]!;
  const row=await read(owner);
  assert.equal(row.id,owner);assert.equal(row.role,"admin");assert.equal(row.email,"owner@yumina.local");assert.equal(row.username,"local");assert.deepEqual(row.preferences,preferences);
  assert.equal((await read(other)).role,"user");
  const config={accountId:owner,githubId:"123456"};
  assert.deepEqual(await adminIdentityForGitHub(123456,config),{email:"owner@yumina.local",emailVerified:true});
  assert.deepEqual(await adminIdentityForGitHub("654321",config),{});
  assert.deepEqual(await adminIdentityForGitHub(undefined,config),{});
  assert.deepEqual(await adminIdentityForGitHub(123456,{accountId:other,githubId:"123456"}),{});
});
