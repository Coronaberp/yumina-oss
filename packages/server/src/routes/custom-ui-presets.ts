import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { userCustomUiPresets } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { AppEnv } from "../lib/types.js";

const customUiPresetRoutes = new Hono<AppEnv>();
customUiPresetRoutes.use("/*", authMiddleware);
customUiPresetRoutes.use("/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
customUiPresetRoutes.use("/*", bodyLimit({ maxSize: 3 * 1024 * 1024 }));

const fileName = z.string().refine(name => !name.startsWith("/") && !name.includes("\\") && name.split("/").every(part => part && part !== "." && part !== "..") && /\.(tsx?|jsx?)$/.test(name), "Invalid UI file name");
const saveSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().transform(name => Array.from(name.trim()).slice(0, 50).join("")).pipe(z.string().min(1)),
  entryFile: fileName,
  files: z.record(fileName, z.string()),
}).strict().superRefine((value, ctx) => {
  if (!Object.hasOwn(value.files, value.entryFile)) ctx.addIssue({ code: "custom", message: "Entry file is missing" });
  if (Object.keys(value.files).length > 200 || Buffer.byteLength(JSON.stringify(value.files), "utf8") > 2 * 1024 * 1024) ctx.addIssue({ code: "custom", message: "UI files are too large" });
});

customUiPresetRoutes.get("/", async (c) => {
  const rows = await db.select().from(userCustomUiPresets).where(eq(userCustomUiPresets.userId, c.get("user").id)).orderBy(desc(userCustomUiPresets.createdAt));
  return c.json({ data: rows });
});

customUiPresetRoutes.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid custom UI files" }, 400);
  const userId = c.get("user").id;
  const id = parsed.data.id ?? crypto.randomUUID();
  const [saved] = await db.insert(userCustomUiPresets).values({ ...parsed.data, id, userId }).onConflictDoNothing().returning();
  if (saved) return c.json({ data: saved }, 201);
  const [existing] = await db.select().from(userCustomUiPresets).where(and(eq(userCustomUiPresets.id, id), eq(userCustomUiPresets.userId, userId)));
  if (!existing) return c.json({ error: "Custom UI save ID already used" }, 409);
  return c.json({ data: existing }, 201);
});

customUiPresetRoutes.delete("/:id", async (c) => {
  const [removed] = await db.delete(userCustomUiPresets).where(and(eq(userCustomUiPresets.id, c.req.param("id")), eq(userCustomUiPresets.userId, c.get("user").id))).returning();
  if (!removed) return c.json({ error: "Custom UI not found" }, 404);
  return c.json({ data: { id: removed.id } });
});

export { customUiPresetRoutes };
