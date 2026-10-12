import type {
  StoryhavenEmbeddingProfile,
  StoryhavenProfileInput,
} from "@yumina/shared";
import type { EmbeddingProfile } from "./types.js";
import { normalizeEmbeddingBase } from "./embeddings.js";

export function parseEmbeddingProfileInput(
  value: unknown,
): StoryhavenProfileInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_profile");
  const r = value as Record<string, unknown>;
  if (
    typeof r.baseUrl !== "string" ||
    r.baseUrl.length > 2048 ||
    typeof r.model !== "string" ||
    !r.model.trim() ||
    r.model.length > 256
  )
    throw new Error("invalid_profile");
  normalizeEmbeddingBase(r.baseUrl);
  if (
    typeof r.dimensions !== "number" ||
    !Number.isInteger(r.dimensions) ||
    r.dimensions < 1 ||
    r.dimensions > 16000
  )
    throw new Error("invalid_dimensions");
  if (r.sendDimensions !== undefined && typeof r.sendDimensions !== "boolean")
    throw new Error("invalid_profile");
  if (
    r.apiKey !== undefined &&
    (typeof r.apiKey !== "string" ||
      r.apiKey.length > 8192 ||
      /[\r\n]/.test(r.apiKey))
  )
    throw new Error("invalid_key");
  return {
    baseUrl: r.baseUrl.trim(),
    model: r.model.trim(),
    dimensions: r.dimensions,
    sendDimensions: r.sendDimensions === true,
    ...(typeof r.apiKey === "string" ? { apiKey: r.apiKey } : {}),
  };
}
export function publicEmbeddingProfile(
  profile: EmbeddingProfile,
  hasKey: boolean,
): StoryhavenEmbeddingProfile {
  return {
    id: profile.id,
    baseUrl: profile.inheritedFrom ? "" : profile.baseUrl,
    model: profile.model,
    dimensions: profile.dimensions,
    sendDimensions: profile.sendDimensions,
    status: profile.status,
    revision: profile.revision,
    active: profile.active,
    hasKey: profile.inheritedFrom ? false : hasKey,
    errorCode: profile.errorCode ?? null,
    ...(profile.inheritedFrom ? { configurationSource: "admin" as const,
      ...(profile.adminDefaultUpdateAvailable ? { adminDefaultUpdateAvailable: true } : {}),
    } : {}),
  };
}
