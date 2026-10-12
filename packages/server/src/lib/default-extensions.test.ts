import "../test/database-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, userExtensions, extensionStats } from "../db/schema.js";
import { installDefaultExtensions } from "./default-extensions.js";
import { auth } from "./auth.js";

test("default guard installation backfills existing accounts and new signup without overriding explicit opt-outs", async () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids) await db.insert(user).values({ id, name: "Default guard test", email: `${id}@test.local` });
  await db.insert(userExtensions).values({ userId: ids[1]!, extensionKey: "state-update-guard", status: "uninstalled" });
  await db.insert(userExtensions).values({ userId: ids[2]!, extensionKey: "state-update-guard", status: "installed" });
  const before = (await db.select().from(extensionStats).where(eq(extensionStats.extensionKey, "state-update-guard")))[0]?.downloadCount ?? 0;
  const added = await installDefaultExtensions();
  assert.deepEqual(added.sort(), [ids[0]!]);
  assert.deepEqual(await installDefaultExtensions(), [], "Restart is idempotent");
  const rows = await db.select().from(userExtensions);
  assert.equal(rows.find(r => r.userId === ids[0])?.status, "installed");
  assert.equal(rows.find(r => r.userId === ids[1])?.status, "uninstalled");
  assert.equal(rows.find(r => r.userId === ids[2])?.status, "installed");
  const newId = crypto.randomUUID();
  await db.insert(user).values({ id: newId, name: "New signup", email: `${newId}@test.local` });
  // Actual BetterAuth session creation covers login retry and the direct
  // local/dev sign-in paths, without starting any provider or email request.
  const authContext = await auth.$context;
  await authContext.internalAdapter.createSession(newId);
  assert.deepEqual(await installDefaultExtensions(newId), []);
  assert.equal((await db.select().from(userExtensions).where(eq(userExtensions.userId, newId)))[0]?.status, "installed");
  assert.equal((await db.select().from(extensionStats).where(eq(extensionStats.extensionKey, "state-update-guard")))[0]?.downloadCount, before + 2);
});

test("a real signup has the guard installed before its first chat", async () => {
  const result = await auth.api.signUpEmail({ body: {
    name: "Fresh guard signup", email: `${crypto.randomUUID()}@test.local`,
    username: `guard${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    password: "test-only-guard-signup-password",
  } });
  const rows = await db.select().from(userExtensions).where(eq(userExtensions.userId, result.user.id));
  assert.equal(rows.find(row => row.extensionKey === "state-update-guard")?.status, "installed");
  assert.deepEqual(await installDefaultExtensions(result.user.id), [], "Signup installation is already complete");
});
