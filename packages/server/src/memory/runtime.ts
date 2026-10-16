import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { env, IS_LOCAL_EDITION } from "../lib/env.js";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { encryptApiKey, decryptApiKey } from "../lib/crypto.js";
import { resolveStoryProviderForModel, isProtectedStorySession } from "../lib/story-provider.js";
import { decorateStoryProvider } from "../lib/story-content-routing.js";
import { resolveSavedProfileProvider } from "../lib/saved-profile-provider.js";
import { resolveAdminContentProvider } from "../lib/admin-content-defaults.js";
import { recordUsageLog } from "../lib/usage-log.js";
import { usageObservation } from "../lib/usage-observation.js";
import { createMemoryDatabase } from "./database.js";
import { ensureRegistry, ensureProfileSchema } from "./schema.js";
import { ProfileRepository } from "./profiles.js";
import { MemoryJobs } from "./jobs.js";
import { createEmbeddingClient } from "./embeddings.js";
import {
  reindexProfile,
  captureProfileTest,
  completeProfileTest,
  captureReindexCredentials,
} from "./profile-reindex.js";
import type { LLMProvider, StreamChunk } from "../lib/llm/types.js";
import type { EmbeddingProfile, MemoryModel, MemoryDatabase } from "./types.js";

export const memoryEncryptionKey = () =>
  createHash("sha256")
    .update(env.ENCRYPTION_KEY ?? env.BETTER_AUTH_SECRET)
    .digest();
export function samePostgresDatabase(
  appUrl: string,
  memoryUrl: string,
): boolean {
  const identity = (value: string) => {
    const url = new URL(value);
    let host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (["localhost", "127.0.0.1", "[::1]"].includes(host)) host = "loopback";
    return JSON.stringify([
      host,
      url.port || "5432",
      decodeURIComponent(url.pathname.slice(1) || url.username),
    ]);
  };
  return identity(appUrl) === identity(memoryUrl);
}
let runtime: ReturnType<typeof initialize> | undefined;
async function initialize() {
  const dataDir =
    env.MEMORY_PGLITE_DATA_DIR ?? resolve(env.YUMINA_DATA_DIR, "memory");
  if (env.MEMORY_DATABASE_URL && env.DATABASE_URL) {
    if (samePostgresDatabase(env.DATABASE_URL, env.MEMORY_DATABASE_URL))
      throw new Error("Memory requires a separate database");
  }
  if (
    !env.MEMORY_DATABASE_URL &&
    dataDir !== "memory://" &&
    resolve(dataDir) === resolve(env.PGLITE_DATA_DIR)
  )
    throw new Error("Memory requires a separate database directory");
  const database = await createMemoryDatabase(
    env.MEMORY_DATABASE_URL ? { url: env.MEMORY_DATABASE_URL } : { dataDir },
  );
  await ensureRegistry(database);
  const profiles: ProfileRepository = new ProfileRepository(database, {
    encrypt: (value) => JSON.stringify(encryptApiKey(value)),
    decrypt: (value) => {
      const r = JSON.parse(value) as {
        encrypted: string;
        iv: string;
        tag: string;
      };
      const plain = decryptApiKey(r.encrypted, r.iv, r.tag);
      if (plain === null) throw new Error("Memory credential unavailable");
      return plain;
    },
  }, {
    source: async reader => {
      if (!IS_LOCAL_EDITION || !env.YUMINA_ADMIN_ACCOUNT_ID) return null;
      const admin = (await db.execute(sql`SELECT id FROM "user" WHERE id=${env.YUMINA_ADMIN_ACCOUNT_ID} AND role='admin'`)).rows[0];
      if (!admin) return null;
      const profile = await profiles.getOwnActive(String(admin.id), reader);
      return profile?.status === "ready" && !profile.inheritedFrom ? profile : null;
    },
    prepare: profile => ensureProfileSchema(database, profile),
  });
  const jobs = new MemoryJobs(database);
  await jobs.initialize();
  return { database, profiles, jobs, key: memoryEncryptionKey() };
}
export function getMemoryRuntime() {
  return (runtime ??= initialize().catch((error) => {
    runtime = undefined;
    throw error;
  }));
}
export async function closeMemoryRuntime(): Promise<void> {
  if (runtime) {
    const current = await runtime;
    await current.database.close();
    runtime = undefined;
  }
}
export async function testMemoryProfile(
  profile: EmbeddingProfile,
): Promise<void> {
  const r = await getMemoryRuntime();
  if (profile.inheritedFrom && !(await r.profiles.inheritedSourceCurrent(profile)))
    throw new Error("Admin embedding default changed; reindex to update it");
  const captured = await captureProfileTest(r.database, profile);
  try {
    await ensureProfileSchema(r.database, profile);
    await createEmbeddingClient(
      profile,
      await r.profiles.getCredential(profile.userId, profile.id),
    ).embed("StoryHaven memory connection test");
    await completeProfileTest(r.database, profile, captured, true);
  } catch (error) {
    await completeProfileTest(r.database, profile, captured, false);
    throw error;
  }
}
export async function activateMemoryProfile(
  profile: EmbeddingProfile,
  ensureCurrent?: (database?: MemoryDatabase) => Promise<boolean>,
): Promise<void> {
  const r = await getMemoryRuntime();
  await testMemoryProfile(profile);
  const active = await r.profiles.getOwnActive(profile.userId);
  const current = async (database?: MemoryDatabase) => (!ensureCurrent || await ensureCurrent(database)) && await r.profiles.inheritedSourceCurrent(profile, database);
  if (active && active.id !== profile.id) {
    const expectedCredentialHashes = await captureReindexCredentials(
      r.database,
      profile.userId,
      active,
      profile,
    );
    await reindexProfile({
      db: r.database,
      profiles: r.profiles,
      ownerUserId: profile.userId,
      source: active,
      target: profile,
      key: r.key,
      embedding: createEmbeddingClient(
        profile,
        await r.profiles.getCredential(profile.userId, profile.id),
      ),
      ensureCurrent: current,
      expectedCredentialHashes,
    });
  } else {
    if (!(await current()))
      throw new Error("profile_changed");
    await r.profiles.activate(profile.userId, profile.id, profile.revision);
  }
}
/** Explicit migration keeps provider work out of status/fork transactions. */
export async function updateAdminMemoryDefault(profile: EmbeddingProfile): Promise<EmbeddingProfile> {
  if (!profile.inheritedFrom) throw new Error("Not an admin embedding default");
  const r = await getMemoryRuntime();
  if (!(await r.profiles.isActiveInheritedSource(profile))) throw new Error("Embedding selection changed");
  const target = await r.profiles.prepareAdminDefault(profile.userId);
  if (!target) throw new Error("Admin embedding default unavailable");
  await activateMemoryProfile(target, async reader =>
    await r.profiles.isActiveInheritedSource(profile, reader)
      && (await db.execute(sql`SELECT 1 FROM "user" WHERE id=${profile.userId}`)).rows.length === 1);
  return (await r.profiles.getActive(profile.userId))!;
}
export const MEMORY_INVOCATION_DDL = `CREATE TABLE IF NOT EXISTS memory_registry.model_invocations(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('started','ready','failed','cancelled')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ, generation_time_ms BIGINT,
  prompt_tokens BIGINT, completion_tokens BIGINT, total_tokens BIGINT,
  token_measurement TEXT, provider_cost_usd NUMERIC(24,12), provider_request_id TEXT)`;
export interface RecordedMemoryModelOptions {
  database: MemoryDatabase;
  provider: Pick<LLMProvider, "generateStream">;
  userId: string;
  sessionId: string;
  model: string;
  apiKeyTier: string;
  recordUsage?: typeof recordUsageLog;
}
/** Provider attempts are durable independently of whether a worker accepts their output. */
export function createRecordedMemoryModel(
  options: RecordedMemoryModelOptions,
): MemoryModel {
  let ready: Promise<unknown> | undefined;
  const write = async (sql: string, values?: unknown[]) => {
    try {
      return await options.database.query(sql, values);
    } catch {
      return options.database.query(sql, values);
    }
  };
  const counter = (value: unknown) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : null;
  return {
    async complete(prompt, callOptions) {
      await (ready ??= options.database.query(MEMORY_INVOCATION_DDL));
      const invocationId = randomUUID(),
        started = Date.now();
      await write(
        `INSERT INTO memory_registry.model_invocations(id,user_id,session_id,model,status) VALUES($1,$2,$3,$4,'started') ON CONFLICT(id) DO NOTHING`,
        [invocationId, options.userId, options.sessionId, options.model],
      );
      let actualModel = options.model;
      let text = "",
        completed = false,
        usage: StreamChunk["usage"];
      try {
        for await (const chunk of options.provider.generateStream({
          conversationId: `play:${options.sessionId}`,
          model: options.model,
          messages: [{ role: "user", content: prompt }],
          maxTokens: 4096,
          disableReasoning: true,
          singleAttempt: true,
          signal: callOptions?.signal,
        })) {
          if (chunk.model) actualModel = chunk.model;
          if (chunk.type === "text") text += chunk.content;
          if (chunk.usage) usage = chunk.usage;
          if (chunk.type === "error")
            throw new Error("memory_model_request_failed");
        }
        completed = true;
        return text;
      } finally {
        const observation = usage
          ? usageObservation(usage)
          : {
              providerCostUsd: null,
              providerRequestId: null,
              tokenMeasurement: null,
            };
        const status = callOptions?.signal?.aborted
          ? "cancelled"
          : completed
            ? "ready"
            : "failed";
        const receipts: Promise<unknown>[] = [
          write(
            `UPDATE memory_registry.model_invocations SET status=$2,finished_at=now(),generation_time_ms=$3,prompt_tokens=$4,completion_tokens=$5,total_tokens=$6,token_measurement=$7,provider_cost_usd=$8,provider_request_id=$9,model=$10 WHERE id=$1`,
            [
              invocationId,
              status,
              Date.now() - started,
              counter(usage?.promptTokens),
              counter(usage?.completionTokens),
              counter(usage?.totalTokens),
              observation.tokenMeasurement,
              observation.providerCostUsd,
              observation.providerRequestId,
              actualModel,
            ],
          ),
        ];
        // Existing usage_logs counters are NOT NULL. Unknown measurements belong only
        // to the invocation receipt; never invent a zero charge or token count there.
        if (usage)
          receipts.push(
            (options.recordUsage ?? recordUsageLog)(
              {
                ...usageObservation(usage),
                id: invocationId,
                userId: options.userId,
                sessionId: options.sessionId,
                model: actualModel,
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens,
                endpoint: "storyhaven-memory",
                apiKeyTier: options.apiKeyTier,
                generationTimeMs: Date.now() - started,
              },
              { strict: true },
            ),
          );
        const results = await Promise.allSettled(receipts);
        if (results.some((result) => result.status === "rejected"))
          throw new Error("memory_invocation_receipt_unavailable");
      }
    },
  };
}
/** Parsing retries belong to the source core; every complete() is one provider attempt. */
export async function createMemoryModel(
  userId: string,
  sessionId: string,
  model: string,
  profileId?: string,
): Promise<MemoryModel> {
  const protectedWorld = await isProtectedStorySession(userId, sessionId);
  let resolved = await resolveStoryProviderForModel(userId, model, { allowOfficialFallback: false, forceOfficial: protectedWorld });
  if (!protectedWorld && profileId && resolved?.profileId !== profileId) {
    // A model ID alone cannot identify a custom endpoint. Only resolve the
    // captured owned profile or an explicitly shared administrator default.
    resolved = await resolveSavedProfileProvider(userId, profileId, model);
    if (!resolved) {
      for (const kind of ["sfw", "nsfw"] as const) {
        const shared = await resolveAdminContentProvider(kind);
        if (shared?.profileId === profileId && shared.model === model) { resolved = shared; break; }
      }
    }
  } else if (!protectedWorld && !profileId) {
    // Older sessions predate route provenance. Their last served fallback
    // model must use that configured fallback connection, never the SFW URL.
    const account = (await db.execute(sql`SELECT preferences FROM "user" WHERE id=${userId}`)).rows[0];
    const fallbackId = (account?.preferences as { nsfwApiKeyId?: string } | undefined)?.nsfwApiKeyId;
    const fallback = fallbackId ? await resolveSavedProfileProvider(userId, fallbackId) : await resolveAdminContentProvider("nsfw");
    if (fallback?.model === model) resolved = fallback;
  }
  if (!resolved?.isByok) throw new Error("memory_model_unavailable");
  const runtime = await getMemoryRuntime();
  return createRecordedMemoryModel({
    database: runtime.database,
    provider: decorateStoryProvider({ userId, protectedWorld, selected: { resolved, model: resolved.model } }),
    userId,
    sessionId,
    model: resolved.model,
    apiKeyTier: resolved.apiKeyTier,
  });
}
