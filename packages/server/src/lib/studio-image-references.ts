import sharp from "sharp";
import { getObjectBuffer } from "./s3.js";
import { resolveImageCdn } from "./cdn-url.js";
import { GenerationError } from "./image-generation/config.js";
import type { ChatMessage } from "./llm/types.js";
import { isHarnessTurn } from "./studio-tools/harness-notes.js";
import { assertOwnedVnImageRef } from "./studio-tools/asset-catalog.js";
import { readOwnedStudioImage } from "./studio-image-view.js";
import { imageMasters, isImageMasterKey } from "./image-masters.js";
import { displayCharacterName, isVnInterface, readVnAssetMap, readVnOpeningScenes, readVnSpriteSets, readVnSpriteVariants, readVnSpriteVariantSets, readVnSpriteOutfit, readVnSpriteConfig, type WorldDefinition, type VnAssetMap } from "@yumina/engine";

export type StudioReferenceRole = "identity" | "environment" | "style" | "creator";
export type StudioImageTarget = {
  kind: "background" | "sprite" | "portrait" | "cg" | "library";
  sceneId?: string;
  period?: string;
  openingId?: string;
  characterId?: string;
  expression?: string;
  spriteType?: string;
  spriteVariant?: string;
};
export type StudioImageReference = {
  key: string; url: string; name: string; assetRef?: string;
  role?: StudioReferenceRole; origin?: "upload" | "manual" | "automatic";
};
export type StudioImageContext = {
  referenceImages: StudioImageReference[];
  styleInstructions?: string;
  outfitInstructions?: string;
  target?: StudioImageTarget;
  unassignedReason?: string;
};
export const MAX_STUDIO_IMAGE_REFERENCES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function ownedKey(userId: string, key: unknown): asserts key is string {
  const prefix = `studio-chat/${userId}/`;
  const master = typeof key === "string" && key.startsWith(`users/${userId}/image-masters/public/`) && isImageMasterKey(key);
  if (!master && (typeof key !== "string" || !key.startsWith(prefix) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|webp|gif)$/i.test(key.slice(prefix.length))))
    throw new GenerationError("INVALID_REFERENCE", "Use only your own uploaded images as references.");
}

/** Candidate syntax is not authorization; verify before every native byte read. */
async function authorizeUploadedStudioKey(userId: string, key: string) {
  ownedKey(userId, key);
  if (isImageMasterKey(key) && !await imageMasters.findByKey(userId, "public", key))
    throw new GenerationError("INVALID_REFERENCE", "The uploaded image master is not available in your account.");
}

/** Client URLs never determine which object the server reads or sends. */
export function normalizeStudioChatReferences(userId: string, uploads: unknown): StudioImageReference[] {
  if (uploads === undefined) return [];
  if (!Array.isArray(uploads) || uploads.length > MAX_STUDIO_IMAGE_REFERENCES)
    throw new GenerationError("INVALID_REFERENCE", "Attach at most five reference images.");
  const refs = uploads.map(upload => {
    if (!upload || typeof upload !== "object" || !IMAGE_TYPES.has(upload.mimeType))
      throw new GenerationError("INVALID_REFERENCE", "Upload a PNG, JPEG, WebP or GIF image as the reference.");
    ownedKey(userId, upload.key);
    return { key: upload.key, url: resolveImageCdn(upload.key)!, name: typeof upload.name === "string" ? upload.name.slice(0, 200) : "Reference image" };
  });
  return refs.filter((ref, index) => refs.findIndex(other => other.key === ref.key) === index);
}

function referenceFromUrl(userId: string, value: string): StudioImageReference | null {
  const path = new URL(value, "http://studio.invalid").pathname;
  if (!path.startsWith("/cdn/key/")) return null;
  const key = Buffer.from(path.slice("/cdn/key/".length), "base64url").toString("utf8");
  ownedKey(userId, key);
  return { key, url: resolveImageCdn(key)!, name: key.split("/").at(-1)! };
}

/** Status nudges continue the same request; a new substantive request replaces its references. */
export function latestStudioImageReferences(userId: string, messages: ChatMessage[]): StudioImageReference[] {
  const latest = [...messages].reverse().find(message => {
    if (message.role !== "user" || isHarnessTurn(message)) return false;
    if (typeof message.content !== "string") return true;
    const text = message.content.toLowerCase().replace(/[\s?!.,…]+/g, " ").trim();
    return !/^(hello|hey|hi|any update|any updates|status|are you there|is it done|is it done yet|still working|what s happening)$/.test(text);
  });
  if (!latest || typeof latest.content === "string") return [];
  const refs = latest.content.filter(part => part.type === "image_url").map(part => {
    const ref = referenceFromUrl(userId, part.image_url.url);
    if (!ref) throw new GenerationError("INVALID_REFERENCE", "Upload the reference image through agent chat.");
    return ref;
  });
  if (refs.length > MAX_STUDIO_IMAGE_REFERENCES) throw new GenerationError("INVALID_REFERENCE", "Attach at most five reference images.");
  return refs.filter((ref, index) => refs.findIndex(other => other.key === ref.key) === index)
    .map(ref => ({ ...ref, role: "creator" as const, origin: "upload" as const }));
}

export function latestStudioUserText(messages: ChatMessage[]): string {
  const latest = [...messages].reverse().find(message => message.role === "user" && !isHarnessTurn(message));
  if (!latest) return "";
  return typeof latest.content === "string" ? latest.content : latest.content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

/** Resolve model-selected @asset images through the current card/library ownership checks. */
export async function resolveStudioAssetReferences(userId: string, worldId: string, input: unknown): Promise<StudioImageReference[]> {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_STUDIO_IMAGE_REFERENCES
    || input.some(ref => typeof ref !== "string" || !/^@asset:[A-Za-z0-9_-]+$/.test(ref))) {
    throw new GenerationError("INVALID_REFERENCE", "Choose up to five owned image @asset references from list_assets or list_vn_assets.");
  }
  const unique = [...new Set(input as string[])];
  const refs: StudioImageReference[] = [];
  for (const assetRef of unique) {
    try {
      await assertOwnedVnImageRef(userId, worldId, assetRef);
      const image = await readOwnedStudioImage(userId, assetRef);
      refs.push({ key: assetRef, url: assetRef, name: image.info.name, assetRef, role: "creator", origin: "manual" });
    } catch (error) {
      throw new GenerationError("INVALID_REFERENCE", error instanceof Error
        ? `Reference ${assetRef} is unavailable: ${error.message}`
        : `Reference ${assetRef} is unavailable. Choose an owned image from this card or your asset library.`);
    }
  }
  return refs;
}

/** Reload reference bytes through owner-checked storage paths immediately before local ComfyUI upload. */
export async function loadStudioImageReferenceInputs(userId: string, worldId: string | undefined,
  references: StudioImageReference[], signal?: AbortSignal) {
  const resolved = [] as Array<{ key: string; name: string; role: StudioReferenceRole; bytes: Buffer; contentType: "image/png" }>;
  for (const reference of references) {
    signal?.throwIfAborted();
    let source: Buffer;
    if (reference.assetRef) {
      if (!worldId) throw new GenerationError("INVALID_REFERENCE", "Project references require an active project.");
      await assertOwnedVnImageRef(userId, worldId, reference.assetRef);
      const viewed = await readOwnedStudioImage(userId, reference.assetRef);
      const data = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(viewed.imageUrl)?.[1];
      if (!data) throw new GenerationError("INVALID_REFERENCE", "A selected project reference could not be decoded.");
      source = Buffer.from(data, "base64");
    } else {
      await authorizeUploadedStudioKey(userId, reference.key);
      const result = await getObjectBuffer(reference.key, { signal, maxBytes: MAX_BYTES });
      source = result.buffer;
    }
    try {
      const bytes = await sharp(source, { limitInputPixels: 40_000_000, failOn: "warning" }).timeout({ seconds: 15 })
        .rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
      signal?.throwIfAborted();
      resolved.push({ key: reference.assetRef ?? reference.key, name: reference.name, role: reference.role ?? "creator", bytes, contentType: "image/png" });
    } catch (error) {
      signal?.throwIfAborted();
      throw new GenerationError("INVALID_REFERENCE", error instanceof Error ? `Reference ${reference.name} is not a supported image.` : "A selected reference is not a supported image.");
    }
  }
  return resolved;
}

/** Keep user uploads and agent-selected files within one provider input limit. */
export function combineStudioImageReferences(...groups: StudioImageReference[][]): StudioImageReference[] {
  const refs = new Map<string, StudioImageReference>();
  for (const group of groups) for (const ref of group) refs.set(ref.assetRef ?? ref.key, ref);
  if (refs.size > MAX_STUDIO_IMAGE_REFERENCES) {
    throw new GenerationError("INVALID_REFERENCE", "Use at most five combined uploaded and owned asset references per image.");
  }
  return [...refs.values()];
}

const normalizeWords = (value: string) => ` ${value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
const mentions = (text: string, candidate: string) => {
  const phrase = normalizeWords(candidate);
  return phrase.length > 2 && normalizeWords(text).includes(phrase);
};
const ownedRef = (value: unknown): value is string => typeof value === "string" && /^@asset:[A-Za-z0-9_-]+$/.test(value);

function orderedVnEntries(map: VnAssetMap, preferredPeriod?: string): Array<{ name: string; period: string; ref: string }> {
  const result: Array<{ name: string; period: string; ref: string }> = [];
  const periodOrder = (period: string) => {
    const known = ["day", "evening", "night"];
    const index = known.indexOf(period.toLowerCase());
    return index < 0 ? known.length : index;
  };
  for (const [name, value] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof value === "string") result.push({ name, period: "normal", ref: value });
    else for (const [period, ref] of Object.entries(value).sort(([a], [b]) => periodOrder(a) - periodOrder(b) || a.localeCompare(b))) {
      result.push({ name, period, ref });
    }
  }
  if (preferredPeriod) result.sort((a, b) => Number(b.period.toLowerCase() === preferredPeriod.toLowerCase()) - Number(a.period.toLowerCase() === preferredPeriod.toLowerCase()));
  return result;
}

export function requestedTarget(world: WorldDefinition, source: string, intent: string, value: unknown): { target?: StudioImageTarget; reason?: string } {
  const scenes = (() => { try { return readVnAssetMap(source, "backgrounds"); } catch { return {}; } })();
  const openings = (() => { try { return readVnOpeningScenes(source); } catch { return {}; } })();
  const entries = world.entries ?? [];
  const outer = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const raw = outer.target && typeof outer.target === "object" && !Array.isArray(outer.target) ? outer.target as Record<string, unknown> : outer;
  const kind = raw.kind === "background" || raw.kind === "sprite" || raw.kind === "portrait" || raw.kind === "cg" || raw.kind === "library"
    ? raw.kind : undefined;
  const sceneId = typeof raw.sceneId === "string" ? raw.sceneId : undefined;
  const openingId = typeof raw.openingId === "string" ? raw.openingId : undefined;
  const characterId = typeof raw.characterId === "string" ? raw.characterId : undefined;
  const period = typeof raw.period === "string" ? raw.period : undefined;
  const expression = typeof raw.expression === "string" ? raw.expression : undefined;
  const spriteType = typeof raw.spriteType === "string" ? raw.spriteType : undefined;
  const spriteVariant = typeof raw.spriteVariant === "string" ? raw.spriteVariant : undefined;
  const openingMap = openingId ? openings[openingId] : undefined;
  const availableScenes = openingMap ?? scenes;
  const sceneEntry = sceneId ? Object.keys(availableScenes).find(name => name === sceneId) : Object.keys(availableScenes).find(name => mentions(intent, name));
  const characterEntry = characterId ? entries.find(entry => entry.role === "character" && entry.id === characterId)
    : entries.find(entry => entry.role === "character" && (mentions(intent, displayCharacterName(entry.name)) || mentions(intent, entry.id)));
  const inferredPeriod = period ?? ["day", "evening", "night"].find(candidate => mentions(intent, candidate));
  const backgroundIntent = /\b(background|backgrounds|location|scene|setting)\b/i.test(intent)
    && !/\b(cg|cutscene|illustration|portrait|sprite)\b/i.test(intent);
  const targetKind = kind ?? (outer.imageKind === "background" ? "background"
    : backgroundIntent && sceneEntry ? "background"
    : characterEntry && /\b(portrait|headshot)\b/i.test(intent) ? "portrait"
      : characterEntry && /\b(sprite|sprites|expression)\b/i.test(intent) ? "sprite"
        : undefined);
  if (targetKind === "background") {
    if (period && !["day", "evening", "night"].includes(period.toLowerCase())) return { reason: "Background periods must use day, evening, or night." };
    if (openingId && !entries.some(entry => entry.id === openingId && entry.role === "greeting")) return { reason: "The requested opening ID is not present in the current project." };
    if (sceneId && !sceneEntry) return { reason: "The requested scene ID is not present in the current managed scenes map." };
    if (!sceneEntry) return { reason: "The background target could not be matched to one exact scene ID." };
    return { target: { kind: "background", sceneId: sceneEntry, period: inferredPeriod ?? "day", ...(openingId ? { openingId } : {}) } };
  }
  if (targetKind === "sprite" || targetKind === "portrait") {
    if ((raw.spriteType !== undefined && typeof raw.spriteType !== "string") || (raw.expression !== undefined && typeof raw.expression !== "string") || (raw.spriteVariant !== undefined && typeof raw.spriteVariant !== "string")) return { reason: "Sprite type and emotion must be catalog IDs." };
    if (characterId && !characterEntry) return { reason: "The requested character ID does not match a current character entry." };
    if (!characterEntry) return { reason: "The character target could not be matched to one exact character ID." };
    if (targetKind === "portrait") return { target: { kind: "portrait", characterId: characterEntry.id } };
    try {
      const config = readVnSpriteConfig(world.rootComponent?.files["sprites.ts"] ?? "");
      const inferOption = (options: Record<string, string>) => Object.entries(options).filter(([id, label]) => id !== "normal" && (mentions(intent, id) || mentions(intent, label))).map(([id]) => id);
      const emotions = inferOption(config.emotions);
      const types = inferOption(config.types);
      if ((!expression && emotions.length > 1) || (!spriteType && types.length > 1)) return { reason: "Multiple wardrobe or emotion options were mentioned; select an exact catalog ID." };
      const emotionId = expression ?? emotions[0] ?? "normal";
      const typeId = spriteType ?? types[0] ?? "normal";
      if (!Object.hasOwn(config.emotions, emotionId) || !Object.hasOwn(config.types, typeId)) return { reason: "Choose wardrobe and emotion IDs from this card’s spriteConfig in list_vn_assets." };
      const variants = readVnSpriteVariants(world.rootComponent?.files["sprites.ts"] ?? "")[typeId] ?? {};
      const inferredVariants = Object.entries(variants).filter(([id, label]) => mentions(intent, id) || mentions(intent, label)).map(([id]) => id);
      if (spriteVariant === undefined && inferredVariants.length > 1) return { reason: "Multiple outfit variants were mentioned; select an exact spriteVariant ID." };
      const variantId = spriteVariant ?? inferredVariants[0];
      if (variantId && !Object.hasOwn(variants, variantId)) return { reason: "Choose a configured outfit variant ID from list_vn_assets." };
      return { target: { kind: "sprite", characterId: characterEntry.id, expression: emotionId, spriteType: typeId, ...(variantId ? { spriteVariant: variantId } : {}) } };
    } catch { return { reason: "The card’s sprite catalog could not be read safely; the image will remain in the library." }; }
  }
  if (targetKind === "cg") return { target: { kind: "cg" } };
  if (targetKind === "library") return { target: { kind: "library" } };
  return { reason: "No exact scene, character, or asset slot was identified. The image will be saved to the library." };
}

/** Deterministically selects project-owned visual context for a generation request. */
export async function resolveAutomaticStudioImageContext(
  userId: string, worldId: string, world: WorldDefinition, intent: string, targetInput?: unknown,
): Promise<StudioImageContext> {
  const root = isVnInterface(world.rootComponent) ? world.rootComponent : null;
  const scenesSource = root?.files["scenes.ts"] ?? "";
  const spritesSource = root?.files["sprites.ts"] ?? "";
  const scenes = (() => { try { return readVnAssetMap(scenesSource, "backgrounds"); } catch { return {}; } })();
  const openingScenes = (() => { try { return readVnOpeningScenes(scenesSource); } catch { return {}; } })();
  const spriteSets = (() => { try { return readVnSpriteSets(spritesSource); } catch { return {}; } })();
  const variantSets = (() => { try { return readVnSpriteVariantSets(spritesSource); } catch { return {}; } })();
  const targetResult = requestedTarget(world, scenesSource, intent, targetInput);
  const target = targetResult.target;
  let outfitInstructions: string | undefined;
  if (target?.kind === "sprite") {
    const character = world.entries.find(entry => entry.role === "character" && entry.id === target.characterId);
    if (character) try {
      const name = displayCharacterName(character.name);
      const outfit = readVnSpriteOutfit(spritesSource, name, target.spriteType ?? "normal", target.spriteVariant ?? "");
      outfitInstructions = [
        "Exact target outfit: " + name.slice(0, 200) + "; type=" + (target.spriteType ?? "normal") + "; variant=" + (target.spriteVariant || "base") + ".",
        "This outfit guidance takes precedence over clothing visible in identity portraits, style references, older biographies, and other outfits. Preserve character identity from portraits; do not copy their clothing or borrow clothes from another type or variant.",
        outfit.description ? "Authored clothing description:\n" + outfit.description.slice(0, 2000)
          : "Clothing for this exact outfit is unspecified. Do not infer it from another outfit or identity portrait; use only clothing details explicitly requested by the creator.",
      ].join("\n").slice(0, 3000);
    } catch { /* Unsupported source never contributes invented outfit guidance. */ }
  }
  const candidates: StudioImageReference[] = [];
  const push = (assetRef: unknown, name: string, role: StudioReferenceRole) => {
    if (ownedRef(assetRef) && !candidates.some(ref => ref.assetRef === assetRef)) {
      candidates.push({ key: assetRef, url: assetRef, assetRef, name: name.slice(0, 200), role, origin: "automatic" });
    }
  };
  const characters = (world.entries ?? []).filter(entry => entry.role === "character" && entry.enabled !== false
    && (mentions(intent, displayCharacterName(entry.name)) || mentions(intent, entry.id) || (target?.characterId === entry.id)));
  for (const entry of characters.slice(0, 2)) {
    if (ownedRef(entry.portrait)) push(entry.portrait, `${entry.name} portrait`, "identity");
    // Clothing references must come from the exact requested outfit; portraits retain identity.
    const sprites = target?.kind === "sprite" ? (target.spriteVariant
      ? variantSets[target.spriteType ?? "normal"]?.[target.spriteVariant] ?? {}
      : spriteSets[target.spriteType ?? "normal"] ?? {}) : {};
    const matchesCharacter = ([name]: [string, unknown]) => name === entry.id || name === displayCharacterName(entry.name) || mentions(displayCharacterName(entry.name), name) || mentions(entry.id, name);
    const mapEntry = Object.entries(sprites).find(matchesCharacter)?.[1];
    if (typeof mapEntry === "string") push(mapEntry, `${entry.name} sprite`, "identity");
    else if (mapEntry) {
      const variants = Object.entries(mapEntry);
      const canonical = variants.find(([variant]) => variant.toLowerCase() === "normal") ?? variants[0];
      if (canonical) push(canonical[1], `${entry.name} ${canonical[0]} sprite`, "identity");
    }
  }

  const environmentMap = (target?.openingId && openingScenes[target.openingId]) || scenes;
  const matchedScene = target?.sceneId ?? Object.keys(environmentMap).find(name => mentions(intent, name));
  if (matchedScene) {
    const requestedPeriod = target?.period ?? ["day", "evening", "night"].find(candidate => mentions(intent, candidate));
    const variants = orderedVnEntries({ [matchedScene]: environmentMap[matchedScene]! }, requestedPeriod);
    const selected = variants.find(item => requestedPeriod && item.period.toLowerCase() === requestedPeriod.toLowerCase())
      ?? variants.find(item => ["day", "evening", "night"].includes(item.period.toLowerCase())) ?? variants[0];
    if (selected) push(selected.ref, `${matchedScene} · ${selected.period}`, "environment");
  }

  const styleEntries = (world.entries ?? []).filter(entry => entry.role === "style" && entry.enabled !== false);
  const styleInstructions = styleEntries.map(entry => `${entry.name}: ${entry.content}`.trim()).filter(Boolean).join("\n").slice(0, 5000) || undefined;
  for (const entry of styleEntries) {
    push(entry.portrait, `${entry.name} style reference`, "style");
    for (const match of entry.content.matchAll(/@asset:[A-Za-z0-9_-]+/g)) push(match[0], `${entry.name} style reference`, "style");
  }
  if (!candidates.some(ref => ref.role === "style")) {
    const stableBackground = orderedVnEntries(scenes).find(item => ownedRef(item.ref));
    if (stableBackground) push(stableBackground.ref, `${stableBackground.name} · ${stableBackground.period} style sample`, "style");
  }

  const referenceImages: StudioImageReference[] = [];
  for (const candidate of candidates) {
    if (referenceImages.length >= MAX_STUDIO_IMAGE_REFERENCES) break;
    try {
      await assertOwnedVnImageRef(userId, worldId, candidate.assetRef!);
      await readOwnedStudioImage(userId, candidate.assetRef!);
      referenceImages.push(candidate);
    } catch { /* stale and unavailable project art is omitted deterministically */ }
  }
  return { referenceImages, ...(outfitInstructions ? { outfitInstructions } : {}), ...(styleInstructions ? { styleInstructions } : {}), ...(target ? { target } : {}),
    ...(targetResult.reason ? { unassignedReason: targetResult.reason } : {}) };
}

/** Keep creator-selected references intact, then fill remaining slots with project context. */
export function mergeStudioImageReferences(...groups: StudioImageReference[][]): StudioImageReference[] {
  const selected = new Map<string, StudioImageReference>();
  const automatic = new Map<string, StudioImageReference>();
  for (const group of groups) for (const ref of group) {
    const key = ref.assetRef ?? ref.key;
    if (ref.origin === "automatic") {
      if (!selected.has(key) && !automatic.has(key)) automatic.set(key, ref);
    } else {
      automatic.delete(key);
      if (!selected.has(key)) selected.set(key, ref);
    }
  }
  if (selected.size > MAX_STUDIO_IMAGE_REFERENCES) {
    throw new GenerationError("INVALID_REFERENCE", "Use at most five combined uploaded and manually selected reference images per image. Reduce the creator-selected references; project references are filled automatically.");
  }
  return [...selected.values(), ...automatic.values()].slice(0, MAX_STUDIO_IMAGE_REFERENCES);
}

export function studioImageReferenceGuidance(refs: StudioImageReference[], styleInstructions?: string, outfitInstructions?: string): string {
  const labels = refs.map(ref => `- ${ref.role ?? "creator"}: ${ref.name}`).join("\n");
  return ["Use each supplied image according to its labeled role. Preserve identity from identity references, scene layout from environment references, and palette/rendering from style references. Creator references show the requested content to adapt.",
    labels ? `Reference roles:\n${labels}` : "", styleInstructions ? `Project visual style:\n${styleInstructions}` : "", outfitInstructions ? `Exact outfit clothing guidance:\n${outfitInstructions.slice(0, 3000)}` : ""].filter(Boolean).join("\n\n");
}

/** Text-only agents can propose a referenced image while the separate Codex
 * helper receives the actual bytes. Never pretend the main agent saw them. */
export function textOnlyStudioReferenceMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => message.role === "tool" || typeof message.content === "string" ? message : {
    ...message, content: message.content.map(part => part.type === "image_url" ? {
      type: "text" as const,
      text: "[Uploaded reference image. The selected agent cannot inspect images directly. The Codex image helper receives the actual image automatically when generate_image uses source codex. Preserve the creator's requested changes, refer to the uploaded reference in the prompt, and do not invent its appearance.]",
    } : part),
  });
}

export async function loadStudioImageReferences(userId: string, refs: StudioImageReference[], signal?: AbortSignal, read = getObjectBuffer, worldId?: string): Promise<string[]> {
  if (refs.length > MAX_STUDIO_IMAGE_REFERENCES) throw new GenerationError("INVALID_REFERENCE", "Attach at most five reference images.");
  // Validate the complete list before reading even its first object.
  for (const ref of refs) {
    if (ref.assetRef !== undefined) {
      if (!worldId || !/^@asset:[A-Za-z0-9_-]+$/.test(ref.assetRef) || ref.key !== ref.assetRef || ref.url !== ref.assetRef)
        throw new GenerationError("INVALID_REFERENCE", "Choose an owned image from this card or your asset library.");
    } else {
      await authorizeUploadedStudioKey(userId, ref.key);
      if (ref.url !== resolveImageCdn(ref.key)) throw new GenerationError("INVALID_REFERENCE", "Use only your own uploaded images as references.");
    }
  }
  const input: string[] = [];
  for (const ref of refs) {
    signal?.throwIfAborted();
    if (ref.assetRef) {
      try {
        await assertOwnedVnImageRef(userId, worldId!, ref.assetRef);
        input.push((await readOwnedStudioImage(userId, ref.assetRef, signal, read)).imageUrl);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw new GenerationError("INVALID_REFERENCE", error instanceof Error
          ? `The selected asset reference is unavailable: ${error.message}`
          : "The selected asset reference is unavailable.");
      }
      continue;
    }
    const { buffer } = await read(ref.key, { signal, maxBytes: MAX_BYTES });
    signal?.throwIfAborted();
    try {
      if (buffer.length > MAX_BYTES) throw new Error("Image too large");
      const image = sharp(buffer, { limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      if (!metadata.format || !["png", "jpeg", "webp", "gif"].includes(metadata.format)) throw new Error("Unsupported image");
      const png = await image.rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
      signal?.throwIfAborted();
      input.push(`data:image/png;base64,${png.toString("base64")}`);
    } catch (error) {
      signal?.throwIfAborted();
      throw new GenerationError("INVALID_REFERENCE", "The reference must be a valid image of at most 10 MB. Upload it again.");
    }
  }
  return input;
}

/** Inline bytes reach Codex even when this installation's CDN is private/local.
 * The persisted transcript retains its small storage URL. */
export async function hydrateStudioMessageImages(userId: string, messages: ChatMessage[], signal?: AbortSignal, read = getObjectBuffer): Promise<ChatMessage[]> {
  const cache = new Map<string, string>();
  const output: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool" || typeof message.content === "string") { output.push(message); continue; }
    const content = [];
    for (const part of message.content) {
      if (part.type !== "image_url") { content.push(part); continue; }
      const ref = referenceFromUrl(userId, part.image_url.url);
      if (!ref) { content.push(part); continue; }
      if (!cache.has(ref.key)) {
        if (cache.size >= 20) throw new GenerationError("TOO_MANY_REFERENCES", "This chat has too many image references. Start a new agent chat with the images you need.");
        cache.set(ref.key, (await loadStudioImageReferences(userId, [ref], signal, read))[0]!);
      }
      content.push({ type: "image_url" as const, image_url: { ...part.image_url, url: cache.get(ref.key)! } });
    }
    output.push({ ...message, content });
  }
  return output;
}
