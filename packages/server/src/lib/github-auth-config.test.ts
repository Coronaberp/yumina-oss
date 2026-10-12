import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitHubAuthConfig, saveGitHubAuthConfig } from "./github-auth-config.js";

test("GitHub configuration preserves unrelated secrets, pins the owner ID, and never returns the client secret", async () => {
  const dir=mkdtempSync(join(tmpdir(),"yumina-github-config-")),file=join(dir,".env");
  try {
    writeFileSync(file,'BETTER_AUTH_SECRET=existing-stable-secret\nOTHER_SETTING=keep\nGITHUB_CLIENT_SECRET=prior-private-secret\n');
    const options={adminAccountId:"existing-owner",publicOrigin:"https://vn.example.test",resolveIdentity:async()=>({id:123456,login:"Owner"})};
    const saved=await saveGitHubAuthConfig(file,{clientId:"oauth-client",clientSecret:"new-private-secret",adminGitHubLogin:"owner"},options);
    assert.equal(saved.secretConfigured,true);assert.equal(saved.ownerGitHubId,"123456");assert.equal(saved.callbackUrl,"https://vn.example.test/api/auth/callback/github");
    assert.ok(!JSON.stringify(saved).includes("private-secret"));
    const data=readFileSync(file,"utf8");assert.ok(data.includes("BETTER_AUTH_SECRET=existing-stable-secret"));assert.ok(data.includes("OTHER_SETTING=keep"));assert.ok(data.includes('YUMINA_AUTH_MODE="multi-user"'));assert.ok(data.includes('YUMINA_SIGN_IN_METHOD="github"'));
    assert.equal(statSync(file).mode&0o777,0o600);
    await saveGitHubAuthConfig(file,{clientId:"new-client",clientSecret:"",adminGitHubLogin:"owner"},options);
    assert.ok(readFileSync(file,"utf8").includes('GITHUB_CLIENT_SECRET="new-private-secret"'));
    assert.equal(readGitHubAuthConfig(file).clientId,"new-client");
    const before=readFileSync(file,"utf8");
    await assert.rejects(saveGitHubAuthConfig(file,{clientId:"injected\nSETTING=bad",adminGitHubLogin:"owner"},options));
    assert.equal(readFileSync(file,"utf8"),before);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
