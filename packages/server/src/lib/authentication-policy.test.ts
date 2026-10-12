import assert from "node:assert/strict";
import test from "node:test";
import { authenticationMethodBlocked, resolveAuthenticationPolicy } from "./authentication-policy.js";

test("GitHub-only policy rejects every password entry point and other social providers", () => {
  for (const path of ["/sign-in/email", "/sign-in/username", "/sign-up/email", "/change-password", "/set-password", "/request-password-reset", "/reset-password", "/forget-password"]) {
    assert.equal(authenticationMethodBlocked(path, "github"), true, path);
    assert.equal(authenticationMethodBlocked(path, "password"), false, path);
  }
  assert.equal(authenticationMethodBlocked("/callback/google", "github"), true);
  for (const path of ["/sign-in/social", "/callback/github", "/get-session", "/sign-out", "/list-accounts"]) assert.equal(authenticationMethodBlocked(path, "github"), false, path);
  assert.deepEqual(resolveAuthenticationPolicy("multi-user", "github", {github:true,google:true,discord:true}), {mode:"multi-user",emailPassword:false,socialProviders:["github"]});
  assert.deepEqual(resolveAuthenticationPolicy("multi-user", "github", {}), {mode:"multi-user",emailPassword:false,socialProviders:[]});
});
