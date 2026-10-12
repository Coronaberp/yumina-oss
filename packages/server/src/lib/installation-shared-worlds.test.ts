import assert from "node:assert/strict";
import test from "node:test";
import { env } from "./env.js";
import { installationSharedWorldIds, isInstallationSharedWorld } from "./installation-shared-worlds.js";

test("sharing is an explicit local whitelist and never exposes withdrawn or review drafts", () => {
  const oldEdition=env.YUMINA_EDITION, oldIds=process.env.YUMINA_SHARED_WORLD_IDS;
  const vn="844c4662-5847-4795-b630-a184bacd0ed9", chat="70f47871-1cc7-4b82-8ff9-2b3adb27e6ce";
  try {
    env.YUMINA_EDITION="local";
    process.env.YUMINA_SHARED_WORLD_IDS=`${vn}, ${chat}\n${vn}, invalid`;
    assert.deepEqual(installationSharedWorldIds(),[vn,chat]);
    assert.equal(isInstallationSharedWorld(vn,"draft"),true);
    assert.equal(isInstallationSharedWorld(chat,"published"),true);
    assert.equal(isInstallationSharedWorld(crypto.randomUUID(),"draft"),false);
    for(const status of ["unpublished","pending_review","rejected"]) assert.equal(isInstallationSharedWorld(vn,status),false);
    env.YUMINA_EDITION="hosted";
    assert.deepEqual(installationSharedWorldIds(),[]);
    assert.equal(isInstallationSharedWorld(vn,"draft"),false);
  } finally {
    env.YUMINA_EDITION=oldEdition;
    if(oldIds===undefined)delete process.env.YUMINA_SHARED_WORLD_IDS;else process.env.YUMINA_SHARED_WORLD_IDS=oldIds;
  }
});
