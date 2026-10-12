import { getCatalogImageSupport, ensureOpenRouterCatalog } from "../lib/llm/model-catalog.js";
import { Hono } from "hono";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { db, flagWrite } from "../db/index.js";
import { apiKeys, user } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { encryptApiKey, decryptApiKey } from "../lib/crypto.js";
import { createProvider } from "../lib/llm/provider-factory.js";
import type { ProviderName } from "../lib/llm/provider-factory.js";
import type { AppEnv } from "../lib/types.js";
import type { ApiKeyMetadata, PromptPostProcessing, OpenRouterProviderEndpoint } from "@yumina/shared";
import { MAX_API_KEY_LABEL, PROFILE_SAMPLING_DEFAULTS } from "@yumina/shared";
import { stripZeroWidthSpaces } from "@yumina/engine";
import { CustomProvider } from "../lib/llm/custom.js";
import { customEndpointFailure, verifyCustomConnection } from "../lib/llm/custom-connection.js";
import { isStrataLocalEndpoint, validateCustomEndpointUrl } from "../lib/ssrf.js";
import { IS_LOCAL_EDITION } from "../lib/env.js";
import { invalidateModelCacheForUser } from "./messages.js";
import { mergePrivateCatalog, privateCatalogIsFresh } from "../lib/private-model-catalog.js";
import { readContentEndpoints } from "../lib/content-endpoints.js";
import { readPublicAdminContentDefaults } from '../lib/admin-content-defaults.js';
import { readStudioProfileChoices, canSelectStudioProfile } from "../lib/studio-nsfw-provider.js";

const apiKeyRoutes = new Hono<AppEnv>();

apiKeyRoutes.use("/*", authMiddleware);

// Public connection identity only. Codex credentials remain in its own store.
apiKeyRoutes.get("/studio-provider", async c => {
  const userId = c.get("user").id;
  c.header("Cache-Control", "no-store");
  const data = await readStudioProfileChoices(userId);
  return data ? c.json({ data }) : c.json({ error: "User not found" }, 404);
});

const studioProfilePatch = z.union([
  z.object({ source: z.literal("default") }).strict(),
  z.object({ source: z.literal("nsfw") }).strict(),
  z.object({ source: z.literal("profile"), profileId: z.string().min(1).max(128) }).strict(),
]);
apiKeyRoutes.patch("/studio-provider", async c => {
  const selected = studioProfilePatch.safeParse(await c.req.json().catch(() => null));
  if (!selected.success) return c.json({ error: "Choose an agent profile" }, 400);
  const userId = c.get("user").id;
  if (!await canSelectStudioProfile(userId, selected.data)) return c.json({ error: "This profile is unavailable or has no configured model and credentials" }, 400);
  await db.update(user).set({
    preferences: sql`coalesce(${user.preferences}, '{}'::jsonb) || ${JSON.stringify({ studioEndpoint: selected.data })}::jsonb`,
    updatedAt: new Date(),
  }).where(eq(user.id, userId));
  await flagWrite(userId);
  c.header("Cache-Control", "no-store");
  return c.json({ data: await readStudioProfileChoices(userId) });
});

const endpointSelectionPatch = z.object({
  sfwApiKeyId: z.string().min(1).max(128).nullable().optional(),
  nsfwApiKeyId: z.string().min(1).max(128).nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0);

apiKeyRoutes.get("/content-endpoints", async c => {
  const userId = c.get("user").id;
  const [account] = await db.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId));
  if (!account) return c.json({ error: "User not found" }, 404);
  const profiles = await db.select({ id: apiKeys.id, provider: apiKeys.provider }).from(apiKeys)
    .where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt));
  const admin = await readPublicAdminContentDefaults();
  const defaults = admin && admin.ownerId !== userId ? admin.defaults : null;
  c.header("Cache-Control", "no-store");
  return c.json({ data: { ...readContentEndpoints(account.preferences, profiles, !!defaults && admin!.inheritSfwDefault), ...(defaults ? { defaults } : {}) } });
});

apiKeyRoutes.patch("/content-endpoints", async c => {
  const parsed = endpointSelectionPatch.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Choose a saved endpoint profile or null" }, 400);
  const userId = c.get("user").id;
  const admin = await readPublicAdminContentDefaults();
  const defaults = admin && admin.ownerId !== userId ? admin.defaults : null;
  const result = await db.transaction(async tx => {
    const [account] = await tx.select({ preferences: user.preferences }).from(user).where(eq(user.id, userId)).for("update");
    if (!account) return { error: "User not found", status: 404 as const };
    const profiles = await tx.select({ id: apiKeys.id, provider: apiKeys.provider }).from(apiKeys)
      .where(eq(apiKeys.userId, userId)).orderBy(desc(apiKeys.createdAt)).for("share");
    const selection = { ...readContentEndpoints(account.preferences, profiles, !!defaults && admin!.inheritSfwDefault), ...parsed.data };
    for (const id of [selection.sfwApiKeyId, selection.nsfwApiKeyId]) {
      if (id !== null && !profiles.some(row => row.id === id)) return { error: "Endpoint profile is unavailable", status: 400 as const };
    }
    const preferences = { ...account.preferences };
    delete preferences.studioApiKeyId;
    await tx.update(user).set({
      // Pin legacy inherited selections before editing another slot. Each use
      // may choose any owned profile, including the same one as another use.
      preferences: { ...preferences, activeApiKeyId: selection.sfwApiKeyId, nsfwApiKeyId: selection.nsfwApiKeyId,
        ...(parsed.data.sfwApiKeyId ? { preferredProvider: "private" } : {}),
      },
      updatedAt: new Date(),
    }).where(eq(user.id, userId));
    return { data: selection };
  });
  if ("error" in result) return c.json({ error: result.error }, result.status!);
  await flagWrite(userId);
  await invalidateModelCacheForUser(userId);
  c.header("Cache-Control", "no-store");
  return c.json({ data: { ...result.data, ...(defaults ? { defaults } : {}) } });
});

const POST_PROC_VALUES: PromptPostProcessing[] = [
  "none", "merge", "merge_tools", "semi", "semi_tools", "strict", "strict_tools", "single",
];

const openRouterModelId = z.string().max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:~+-]*$/);
const openRouterProviderSlug = z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/);
const openRouterProvidersSchema = z.record(openRouterModelId, z.array(openRouterProviderSlug).min(1).max(64)
  .transform(slugs => [...new Set(slugs)]))
  .refine(value => Object.keys(value).length <= 256, "Maximum 256 model provider selections");

interface MetadataInput {
  temperature?: number | null;
  topP?: number | null;
  topK?: number | null;
  openRouterProviders?: ApiKeyMetadata["openRouterProviders"];
  reasoningEffort?: ApiKeyMetadata["reasoningEffort"];
  contextWindow?: number | null;
  models?: string[];
  includeBody?: Record<string, unknown>;
  excludeBody?: string[];
  includeHeaders?: Record<string, string>;
  promptPostProcessing?: PromptPostProcessing;
  defaultModel?: string;
}

/** Validate metadata input from a client. Returns either a sanitized partial or an error. */
function validateMetadata(input: MetadataInput): { ok: true; value: Partial<ApiKeyMetadata> } | { ok: false; error: string } {
  const out: Partial<ApiKeyMetadata> = {};

  const samplingSchema = z.object({
    temperature: z.number().finite().min(0).max(2).nullable().optional(),
    topP: z.number().finite().gt(0).max(1).nullable().optional(),
    topK: z.number().int().min(0).max(100_000).nullable().optional(),
  });
  const sampling = samplingSchema.safeParse(input);
  if (!sampling.success) return { ok: false, error: "Temperature must be 0–2, top P greater than 0 and at most 1, and top K a whole number from 0–100000; use null to restore defaults." };
  for (const key of ["temperature", "topP", "topK"] as const) {
    if (sampling.data[key] !== undefined) out[key] = sampling.data[key];
  }

  if (input.openRouterProviders !== undefined) {
    const parsed = openRouterProvidersSchema.safeParse(input.openRouterProviders);
    if (!parsed.success) return { ok: false, error: "openRouterProviders must map model IDs to 1–64 provider slugs (maximum 256 models). Remove a model entry to use account defaults." };
    out.openRouterProviders = parsed.data;
  }

  if (input.reasoningEffort !== undefined) {
    if (!["minimal", "low", "medium", "high"].includes(input.reasoningEffort)) {
      return { ok: false, error: "reasoningEffort must be minimal, low, medium or high" };
    }
    out.reasoningEffort = input.reasoningEffort;
  }

  if (input.contextWindow !== undefined) {
    if (input.contextWindow !== null && (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 512 || input.contextWindow > 2_000_000)) {
      return { ok: false, error: "contextWindow must be a whole number from 512 to 2000000 tokens, or null for automatic detection" };
    }
    out.contextWindow = input.contextWindow;
  }

  if (input.models !== undefined) {
    if (!Array.isArray(input.models) || !input.models.every((m) => typeof m === "string")) {
      return { ok: false, error: "models must be an array of strings" };
    }
    if (input.models.length > 500 || input.models.some((m) => m.length > 256)) {
      return { ok: false, error: "models: max 500 entries, each ≤ 256 chars" };
    }
    out.models = input.models;
  }

  if (input.includeBody !== undefined) {
    if (input.includeBody === null || typeof input.includeBody !== "object" || Array.isArray(input.includeBody)) {
      return { ok: false, error: "includeBody must be a JSON object" };
    }
    if (JSON.stringify(input.includeBody).length > 4096) {
      return { ok: false, error: "includeBody: payload too large (>4 KiB)" };
    }
    out.includeBody = input.includeBody;
  }

  if (input.excludeBody !== undefined) {
    if (!Array.isArray(input.excludeBody) || !input.excludeBody.every((s) => typeof s === "string")) {
      return { ok: false, error: "excludeBody must be an array of strings" };
    }
    if (input.excludeBody.length > 64) {
      return { ok: false, error: "excludeBody: max 64 entries" };
    }
    out.excludeBody = input.excludeBody;
  }

  if (input.includeHeaders !== undefined) {
    if (input.includeHeaders === null || typeof input.includeHeaders !== "object" || Array.isArray(input.includeHeaders)) {
      return { ok: false, error: "includeHeaders must be a JSON object of string→string" };
    }
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.includeHeaders)) {
      if (typeof v !== "string") return { ok: false, error: `includeHeaders.${k} must be a string` };
      if (/[\r\n\0]/.test(k) || /[\r\n\0]/.test(v)) return { ok: false, error: "header names/values cannot contain CR/LF/NUL" };
      if (k.length > 128 || v.length > 1024) return { ok: false, error: "header names ≤ 128 chars, values ≤ 1024 chars" };
      if (k.toLowerCase() === "authorization") return { ok: false, error: "Authorization header is managed by the stored key — do not override" };
      safe[k] = v;
    }
    if (Object.keys(safe).length > 32) return { ok: false, error: "includeHeaders: max 32 entries" };
    out.includeHeaders = safe;
  }

  if (input.promptPostProcessing !== undefined) {
    if (!POST_PROC_VALUES.includes(input.promptPostProcessing)) {
      return { ok: false, error: `promptPostProcessing must be one of: ${POST_PROC_VALUES.join(", ")}` };
    }
    out.promptPostProcessing = input.promptPostProcessing;
  }

  if (input.defaultModel !== undefined) {
    if (typeof input.defaultModel !== "string" || input.defaultModel.length > 256) {
      return { ok: false, error: "defaultModel must be a string ≤ 256 chars" };
    }
    out.defaultModel = input.defaultModel;
  }

  return { ok: true, value: out };
}

// POST /api/keys — store a new API key
apiKeyRoutes.post("/", async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json<{
    key: string;
    provider?: string;
    label?: string;
    baseUrl?: string;
  } & MetadataInput>();

  if (body.label && body.label.length > MAX_API_KEY_LABEL) {
    return c.json({ error: `Label must be ${MAX_API_KEY_LABEL} characters or fewer` }, 400);
  }

  const provider = body.provider ?? "openrouter";
  if (body.openRouterProviders !== undefined && provider !== "openrouter") {
    return c.json({ error: "openRouterProviders is only valid for provider='openrouter'" }, 400);
  }

  // Custom-provider-specific validation
  let validatedBaseUrl: string | null = null;
  if (provider === "custom") {
    if (!body.baseUrl) {
      return c.json({ error: "Custom endpoints require a base URL" }, 400);
    }
    try {
      validatedBaseUrl = validateCustomEndpointUrl(body.baseUrl, { allowStrataLocal: IS_LOCAL_EDITION });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  } else if (body.baseUrl !== undefined) {
    return c.json({ error: "baseUrl is only valid for provider='custom'" }, 400);
  }

  const allowsKeylessStrata = provider === "custom"
    && IS_LOCAL_EDITION
    && isStrataLocalEndpoint(validatedBaseUrl ?? "");
  if (typeof body.key !== "string" || (!body.key.trim() && !allowsKeylessStrata)) {
    return c.json({ error: "API key is required" }, 400);
  }

  // `defaultModel` and `models` are allowed on every provider (any profile can
  // remember its preferred model + its fetched model list). The remaining
  // metadata fields (includeBody/excludeBody/includeHeaders/promptPostProcessing)
  // are custom-only because they shape an OpenAI-compatible request body.
  let metadata: ApiKeyMetadata | null = null;
  if (provider === "custom") {
    const parsed = validateMetadata(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    metadata = { models: [], reasoningEffort: "low", ...PROFILE_SAMPLING_DEFAULTS, ...parsed.value };
  } else {
    if (body.includeBody !== undefined || body.excludeBody !== undefined || body.includeHeaders !== undefined || body.promptPostProcessing !== undefined) {
      return c.json({ error: "includeBody/excludeBody/includeHeaders/promptPostProcessing are only valid for provider='custom'" }, 400);
    }
    const parsed = validateMetadata({ models: body.models, defaultModel: body.defaultModel, contextWindow: body.contextWindow, reasoningEffort: body.reasoningEffort, openRouterProviders: body.openRouterProviders, temperature: body.temperature, topP: body.topP, topK: body.topK });
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    metadata = { reasoningEffort: "low", ...PROFILE_SAMPLING_DEFAULTS, ...parsed.value };
  }

  const { encrypted, iv, tag } = encryptApiKey(body.key);

  const result = await db
    .insert(apiKeys)
    .values({
      userId: currentUser.id,
      provider,
      encryptedKey: encrypted,
      keyIv: iv,
      keyTag: tag,
      label: body.label ?? "Default",
      baseUrl: validatedBaseUrl,
      metadata,
    })
    .returning();

  // New key changes the aggregated model list returned by GET /api/models.
  await invalidateModelCacheForUser(currentUser.id);
  return c.json({ data: result[0] }, 201);
});

// GET /api/keys — list keys (metadata only)
apiKeyRoutes.get("/", async (c) => {
  const currentUser = c.get("user");
  const result = await db
    .select({
      id: apiKeys.id,
      provider: apiKeys.provider,
      label: apiKeys.label,
      baseUrl: apiKeys.baseUrl,
      metadata: apiKeys.metadata,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, currentUser.id));

  return c.json({ data: result });
});

// PATCH /api/keys/:id — update custom endpoint fields
apiKeyRoutes.patch("/:id", async (c) => {
  const currentUser = c.get("user");
  const keyId = c.req.param("id");
  const body = await c.req.json<{ baseUrl?: string; label?: string; key?: string } & MetadataInput>();

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Key not found" }, 404);
  }

  const existing = rows[0]!;
  if (body.openRouterProviders !== undefined && existing.provider !== "openrouter") {
    return c.json({ error: "openRouterProviders is only valid for provider='openrouter'" }, 400);
  }

  const patch: { baseUrl?: string; label?: string; metadata?: ApiKeyMetadata; encryptedKey?: string; keyIv?: string; keyTag?: string } = {};

  if (body.label !== undefined) {
    if (typeof body.label !== "string" || body.label.length === 0 || body.label.length > MAX_API_KEY_LABEL) {
      return c.json({ error: `Label must be a non-empty string of ${MAX_API_KEY_LABEL} characters or fewer` }, 400);
    }
    patch.label = body.label;
  }

  // baseUrl is strictly custom-only
  if (body.baseUrl !== undefined && existing.provider !== "custom") {
    return c.json({ error: "baseUrl is only valid for provider='custom'" }, 400);
  }
  if (body.baseUrl !== undefined) {
    try {
      patch.baseUrl = validateCustomEndpointUrl(body.baseUrl, { allowStrataLocal: IS_LOCAL_EDITION });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  }

  if (body.key !== undefined) {
    const resultingBaseUrl = patch.baseUrl ?? existing.baseUrl ?? "";
    const allowsKeylessStrata = existing.provider === "custom"
      && IS_LOCAL_EDITION
      && isStrataLocalEndpoint(resultingBaseUrl);
    if (typeof body.key !== "string" || (!body.key.trim() && !allowsKeylessStrata)) {
      return c.json({ error: "key must be a non-empty string" }, 400);
    }
    const { encrypted, iv, tag } = encryptApiKey(body.key);
    patch.encryptedKey = encrypted;
    patch.keyIv = iv;
    patch.keyTag = tag;
  }

  // includeBody/excludeBody/includeHeaders/promptPostProcessing reshape an
  // OpenAI-compatible request — only meaningful for custom proxies.
  const customShapeFieldGiven =
    body.includeBody !== undefined ||
    body.excludeBody !== undefined ||
    body.includeHeaders !== undefined ||
    body.promptPostProcessing !== undefined;
  if (customShapeFieldGiven && existing.provider !== "custom") {
    return c.json({ error: "includeBody/excludeBody/includeHeaders/promptPostProcessing are only valid for provider='custom'" }, 400);
  }

  // models / defaultModel are allowed on every provider.
  if (existing.provider === "custom") {
    const parsed = validateMetadata(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (Object.keys(parsed.value).length > 0) {
      patch.metadata = { ...((existing.metadata as ApiKeyMetadata | null) ?? {}), ...parsed.value };
    }
  } else if (body.models !== undefined || body.defaultModel !== undefined || body.contextWindow !== undefined || body.reasoningEffort !== undefined || body.openRouterProviders !== undefined || body.temperature !== undefined || body.topP !== undefined || body.topK !== undefined) {
    const parsed = validateMetadata({ models: body.models, defaultModel: body.defaultModel, contextWindow: body.contextWindow, reasoningEffort: body.reasoningEffort, openRouterProviders: body.openRouterProviders, temperature: body.temperature, topP: body.topP, topK: body.topK });
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (Object.keys(parsed.value).length > 0) {
      patch.metadata = { ...((existing.metadata as ApiKeyMetadata | null) ?? {}), ...parsed.value };
    }
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  if (body.key !== undefined || body.baseUrl !== undefined || body.includeHeaders !== undefined) {
    patch.metadata = { ...(patch.metadata ?? existing.metadata ?? {}), modelsSyncedAt: 0 };
  }

  const updated = await db
    .update(apiKeys)
    .set(patch)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)))
    .returning();

  // Any field on the key (label, baseUrl, model whitelist, post-processing,
  // additional params) potentially affects what GET /api/models surfaces, so
  // drop the cache unconditionally here rather than tracking which field changed.
  await invalidateModelCacheForUser(currentUser.id);

  // Strip encrypted material before returning to client
  const row = updated[0];
  const safe = row && {
    id: row.id, provider: row.provider, label: row.label,
    baseUrl: row.baseUrl, metadata: row.metadata, createdAt: row.createdAt,
  };
  return c.json({ data: safe });
});

// GET /api/keys/:id/openrouter-providers — discover the selected model's endpoints.
apiKeyRoutes.get("/:id/openrouter-providers", async c => {
  const [row] = await db.select().from(apiKeys)
    .where(and(eq(apiKeys.id, c.req.param("id")), eq(apiKeys.userId, c.get("user").id)));
  if (!row) return c.json({ error: "Key not found" }, 404);
  if (row.provider !== "openrouter") return c.json({ error: "Provider discovery requires an OpenRouter profile" }, 400);
  const model = openRouterModelId.safeParse(c.req.query("model"));
  if (!model.success) return c.json({ error: "Enter a valid OpenRouter model ID" }, 400);
  c.header("Cache-Control", "no-store");
  try {
    const key = decryptApiKey(row.encryptedKey, row.keyIv, row.keyTag);
    const path = model.data.split("/").map(encodeURIComponent).join("/");
    const response = await fetch(`https://openrouter.ai/api/v1/models/${path}/endpoints`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return c.json({ error: `OpenRouter provider list unavailable (${response.status})` }, 502);
    const payload = await response.json() as { data?: { endpoints?: unknown } };
    if (!Array.isArray(payload.data?.endpoints)) return c.json({ error: "OpenRouter returned an invalid provider list" }, 502);
    const providers: OpenRouterProviderEndpoint[] = [];
    const seen = new Set<string>();
    for (const endpoint of payload.data.endpoints) {
      if (!endpoint || typeof endpoint !== "object") continue;
      const slug = openRouterProviderSlug.safeParse(endpoint.tag);
      if (!slug.success || seen.has(slug.data)) continue;
      seen.add(slug.data);
      const prompt = Number(endpoint.pricing?.prompt), completion = Number(endpoint.pricing?.completion);
      providers.push({
        slug: slug.data,
        name: typeof endpoint.provider_name === "string" && endpoint.provider_name ? endpoint.provider_name : slug.data,
        ...(typeof endpoint.context_length === "number" && endpoint.context_length > 0 ? { contextLength: endpoint.context_length } : {}),
        ...(Number.isFinite(prompt) && prompt >= 0 && Number.isFinite(completion) && completion >= 0 ? { pricing: { prompt, completion } } : {}),
      });
    }
    return c.json({ data: { providers } });
  } catch {
    return c.json({ error: "Could not load OpenRouter providers. Try again." }, 502);
  }
});

// DELETE /api/keys/:id — remove a key
apiKeyRoutes.delete("/:id", async (c) => {
  const currentUser = c.get("user");
  const keyId = c.req.param("id");

  const result = await db.transaction(async tx => {
    const [account] = await tx.select({ preferences: user.preferences }).from(user).where(eq(user.id, currentUser.id)).for("update");
    const deleted = await tx.delete(apiKeys).where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id))).returning();
    if (deleted.length && account) {
      const preferences = { ...account.preferences };
      if (preferences.activeApiKeyId === keyId) preferences.activeApiKeyId = null;
      if (preferences.nsfwApiKeyId === keyId) preferences.nsfwApiKeyId = null;
      if ((preferences.studioEndpoint as { source?: string; profileId?: string } | undefined)?.profileId === keyId) preferences.studioEndpoint = { source: "default" };
      delete preferences.studioApiKeyId;
      await tx.update(user).set({ preferences, updatedAt: new Date() }).where(eq(user.id, currentUser.id));
    }
    return deleted;
  });

  if (result.length === 0) {
    return c.json({ error: "Key not found" }, 404);
  }

  await invalidateModelCacheForUser(currentUser.id);
  await flagWrite(currentUser.id);
  return c.json({ data: { deleted: true } });
});

// POST /api/keys/:id/verify — quick connectivity check (legacy two-step verify)
apiKeyRoutes.post("/:id/verify", async (c) => {
  const currentUser = c.get("user");
  const keyId = c.req.param("id");

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Key not found" }, 404);
  }

  const row = rows[0]!;
  const decrypted = decryptApiKey(row.encryptedKey, row.keyIv, row.keyTag);
  if (decrypted === null) return c.json({ data: { valid: false, reason: "Failed to decrypt API key — try re-saving it" } });

  if (row.provider === "custom") {
    if (!row.baseUrl) {
      return c.json({ data: { valid: false, reason: "Missing base URL on this key" } });
    }
    const custom = new CustomProvider(decrypted, row.baseUrl, (row.metadata as ApiKeyMetadata | null) ?? null);

    return c.json({ data: await verifyCustomConnection(custom, row.metadata as ApiKeyMetadata | null) });
  }

  try {
    const provider = createProvider(row.provider as ProviderName, decrypted);
    if (provider.verify) {
      const valid = await provider.verify();
      return c.json({ data: { valid } });
    }
    return c.json({ data: { valid: false, reason: "Provider does not support verification" } });
  } catch {
    return c.json({ data: { valid: false, reason: "Verification failed" } });
  }
});

/**
 * POST /api/keys/:id/list-models — fetch the model list this key can access.
 *
 * For provider='custom', hits upstream {baseUrl}/models with detailed status.
 * For other providers, calls provider.listModels() (e.g. OpenAI /v1/models).
 *
 * The returned list (with provider prefix stripped) is also cached into
 * metadata.models so resolve-provider and the chat picker can use it quickly.
 */
apiKeyRoutes.post("/:id/list-models", async (c) => {
  const currentUser = c.get("user");
  const keyId = c.req.param("id");

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Key not found" }, 404);
  }

  const row = rows[0]!;
  const imageCapabilities = (ids: string[]) => Object.fromEntries(ids.flatMap(id => {
    if (row.provider === "custom" || row.provider === "ollama") return [];
    const full = id.includes("/") || row.provider === "openrouter" ? id : `${row.provider}/${id}`;
    const support = getCatalogImageSupport(full);
    return support === undefined ? [] : [[full, support]];
  }));
  if (c.req.query("refresh") === "auto" && privateCatalogIsFresh(row.metadata)) {
    return c.json({ data: { ok: true, provider: row.provider, models: row.metadata?.models ?? [], imageCapabilities: imageCapabilities(row.metadata?.models ?? []) } });
  }
  // A fresh private catalog stays entirely local. Only OpenRouter refreshes
  // need its live modality catalog; other providers use the cached snapshot,
  // and custom endpoints must never trigger an unrelated provider request.
  if (row.provider === "openrouter") await ensureOpenRouterCatalog();
  const decrypted = decryptApiKey(row.encryptedKey, row.keyIv, row.keyTag);
  if (decrypted === null) return c.json({ error: "Failed to decrypt API key — try re-saving it" }, 500);

  let bareIds: string[] = [];
  let status: number | undefined;

  if (row.provider === "custom") {
    if (!row.baseUrl) {
      return c.json({ error: "Missing base URL on this key" }, 400);
    }
    const custom = new CustomProvider(decrypted, row.baseUrl, (row.metadata as ApiKeyMetadata | null) ?? null);
    const detail = await custom.listModelsDetailed();
    if (!detail.ok || detail.models.length === 0) {
      return c.json({ data: {
        ok: false,
        status: detail.status,
        ...customEndpointFailure("models", detail.status, detail.reason),
        models: [],
      } });
    }
    bareIds = detail.models;
    status = detail.status;
  } else {
    try {
      const provider = createProvider(row.provider as ProviderName, decrypted);
      const models = await provider.listModels();
      // Strip the "{provider}/" prefix, leaving the bare upstream id (e.g. "gpt-4o").
      const prefix = `${row.provider}/`;
      bareIds = models.map((m) => (m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id));
    } catch (err) {
      return c.json({
        data: { ok: false, reason: `Failed to fetch model list: ${(err as Error).message}`, models: [] },
      });
    }
  }

  // Re-read under a short lock after the network call. Never overwrite a model
  // or request-setting edit made while the provider was responding.
  const nextMeta = await db.transaction(async (tx) => {
    const [latest] = await tx.select().from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id))).for("update");
    if (!latest || latest.encryptedKey !== row.encryptedKey || latest.baseUrl !== row.baseUrl ||
        JSON.stringify(latest.metadata?.includeHeaders) !== JSON.stringify(row.metadata?.includeHeaders)) return null;
    const metadata = mergePrivateCatalog(latest.metadata, bareIds);
    if (!metadata) return null;
    await tx.update(apiKeys).set({ metadata }).where(eq(apiKeys.id, keyId));
    return metadata;
  });
  if (!nextMeta) {
    return c.json({ data: { ok: false, status, reason: "No usable models returned or profile changed; saved models kept", models: [] } });
  }

  // Refreshed whitelist: invalidate the aggregated GET /api/models cache so the
  // chat picker (and the sandbox model modal that reads from it) reflects the
  // new list immediately instead of waiting up to 5 minutes for TTL.
  await invalidateModelCacheForUser(currentUser.id);

  return c.json({ data: { ok: true, status, provider: row.provider, models: nextMeta.models, imageCapabilities: imageCapabilities(nextMeta.models ?? []) } });
});

/**
 * POST /api/keys/:id/test — send a single non-streaming chat completion to verify
 * end-to-end the key+endpoint+model combination works. The "Send test message" button.
 * Body: { model: string; prompt?: string }
 */
apiKeyRoutes.post("/:id/test", async (c) => {
  const currentUser = c.get("user");
  const keyId = c.req.param("id");
  const body = await c.req.json<{ model?: string; prompt?: string }>().catch(() => ({} as { model?: string; prompt?: string }));

  if (!body.model || typeof body.model !== "string") {
    return c.json({ error: "model is required" }, 400);
  }
  const prompt = typeof body.prompt === "string" && body.prompt.length > 0 ? stripZeroWidthSpaces(body.prompt).slice(0, 1000) : "Hi";

  const rows = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, currentUser.id)));

  if (rows.length === 0) {
    return c.json({ error: "Key not found" }, 404);
  }

  const row = rows[0]!;
  if (row.provider !== "custom") {
    return c.json({ error: "test is only supported for provider='custom'" }, 400);
  }
  if (!row.baseUrl) {
    return c.json({ error: "Missing base URL on this key" }, 400);
  }

  const decrypted = decryptApiKey(row.encryptedKey, row.keyIv, row.keyTag);
  if (decrypted === null) return c.json({ error: "Failed to decrypt API key — try re-saving it" }, 500);
  const custom = new CustomProvider(decrypted, row.baseUrl, (row.metadata as ApiKeyMetadata | null) ?? null);
  const result = await custom.sendTestMessage(body.model, prompt);

  if (!result.ok) {
    return c.json({ data: {
      ok: false,
      status: result.status,
      ...customEndpointFailure("chat", result.status, result.reason),
    } });
  }

  return c.json({ data: { ok: true, status: result.status, reply: stripZeroWidthSpaces(result.reply ?? "") } });
});

export { apiKeyRoutes };
