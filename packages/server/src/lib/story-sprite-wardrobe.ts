import {
  canonicalCharacterName, displayCharacterName, standardizeSpeakerMarkup,
  presentationLiteralRanges, isPresentationLiteral, normalizeSpriteId, normalizeSpriteSelectionId,
  readVnSpriteConfig, readVnSpriteWardrobeDescriptions, readVnSpriteVariants,
  readVnSpriteVariantWardrobeDescriptions, readVnSpriteChapterDefaults, readVnSpriteOutfit, IncrementalSegmentExtractor,
  type WorldDefinition, type GameState,
} from "@yumina/engine";
import { eligibleStoryCharacters } from "./story-character-context.js";
import { and, eq, desc, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { assertTurnMemoryCurrent, TurnMemoryChangedError, type TurnMemory } from "./turn-memory.js";

export type WardrobeBranchMessage = { role: string; content: string; rawContent?: string; stateSnapshot?: { activeGreetingId?: unknown } | null };
export const wardrobePlaceholder = /\{\{\s*sprite_wardrobe\s*\}\}/gi;
export function expandWardrobePlaceholder(content: string, description: string): string {
  return content.replace(wardrobePlaceholder, () => description);
}

/** Only the supplied accepted branch is inspected. Bounded history does not
 * establish an outfit last mentioned before its earliest row. No persistence. */
export function resolveStoryWardrobes(args: {
  world: WorldDefinition; state?: GameState; branchMessages: readonly WardrobeBranchMessage[];
  initialSelections?: Record<string, { type: string; variant: string }>;
  allCharacters?: boolean;
}) {
  const entries = eligibleStoryCharacters(args.world, args.allCharacters ? undefined : args.state);
  const names = entries.map(entry => displayCharacterName(entry.name));
  const selected = new Map<string, { type: string; variant: string }>();
  const observed = new Set<string>();
  const source = args.world.rootComponent?.files["sprites.ts"] || "export const sprites = {};";
  let descriptions: ReturnType<typeof readVnSpriteWardrobeDescriptions> = {};
  let variantDescriptions: ReturnType<typeof readVnSpriteVariantWardrobeDescriptions> = {};
  let variants: ReturnType<typeof readVnSpriteVariants> = {};
  let defaults: ReturnType<typeof readVnSpriteChapterDefaults> = {};
  let types: Record<string, string> = { normal: "Normal" };
  try {
    descriptions = readVnSpriteWardrobeDescriptions(source);
    variantDescriptions = readVnSpriteVariantWardrobeDescriptions(source);
    variants = readVnSpriteVariants(source);
    defaults = readVnSpriteChapterDefaults(source);
    types = readVnSpriteConfig(source).types;
  } catch { /* Custom executable maps are never evaluated. */ }
  const accept = (rawName: unknown, rawType: unknown, rawVariant?: unknown, explicit = true) => {
    if (typeof rawName !== "string" || /^(npc|narrator|narration)$/i.test(rawName.trim())) return;
    if (typeof rawType !== "string" || !rawType.trim()) return;
    const name = canonicalCharacterName(names, rawName);
    if (!name) return;
    const id = normalizeSpriteSelectionId(rawType);
    if (!id) return;
    const type = Object.keys(types).find(key => normalizeSpriteId(key) === id);
    if (!type || (rawVariant != null && typeof rawVariant !== "string")) return;
    const variantId = typeof rawVariant === "string" && rawVariant.trim() ? normalizeSpriteSelectionId(rawVariant) : "";
    if (variantId === undefined) return;
    const variant = variantId ? Object.keys(variants[type] ?? {}).find(key => normalizeSpriteId(key) === variantId) : "";
    if (variant === undefined) return;
    selected.set(name, { type, variant });
    if (explicit) observed.add(name);
  };
  const reset = () => {
    selected.clear(); observed.clear();
    for (const [name, value] of Object.entries(defaults[args.state?.activeGreetingId ?? ""] ?? {})) accept(name, value.type, value.variant, false);
  };
  reset();
  for (const [name, selection] of Object.entries(args.initialSelections ?? {})) accept(name, selection.type, selection.variant, false);
  let start = 0;
  if (args.state?.activeGreetingId !== undefined) for (let index = args.branchMessages.length - 1; index >= 0; index--) {
    const message = args.branchMessages[index]!, id = message.stateSnapshot?.activeGreetingId;
    if (message.role === "assistant" && (typeof id === "string" || id === null) && id !== args.state.activeGreetingId) { start = index + 1; break; }
  }
  for (const message of args.branchMessages.slice(start)) {
    if (message.role !== "assistant") continue;
    if (message.content.includes("[CHARACTER_CREATE]")) reset();
    const raw = message.rawContent || message.content;
    // Structured replies carry wardrobe on each segment, in passage order.
    const segments = new IncrementalSegmentExtractor().extract(raw).newSegments;
    if (segments.length) {
      for (const segment of segments) accept(segment.speaker ?? segment.name, segment.spriteType, segment.spriteVariant);
      continue;
    }
    const text = standardizeSpeakerMarkup(raw.replace(/[\u200B\u2060]/g, ""), names);
    const literals = presentationLiteralRanges(text);
    for (const marker of text.matchAll(/\[SPEAKER:([^:\]\n]+):([^:\]\n]+)(?::([^:\]\n]+))?(?::([^:\]\n]+))?\]/gi)) {
      if (!isPresentationLiteral(literals, marker.index!)) accept(marker[1], marker[3], marker[4]);
    }
  }
  return entries.map(entry => {
    const name = displayCharacterName(entry.name), { type, variant } = selected.get(name) || { type: "normal", variant: "" };
    const key = Object.keys(descriptions).find(key => key.toLowerCase() === name.toLowerCase());
    const variantKey = Object.keys(variantDescriptions).find(key => key.toLowerCase() === name.toLowerCase());
    let outfit: ReturnType<typeof readVnSpriteOutfit> = { expressions: {}, description: "", defaultEmotion: undefined };
    try { outfit = readVnSpriteOutfit(source, name, type, variant); } catch { /* Unknown executable maps remain untouched. */ }
    const description = outfit.description;
    const hasAuthoredWardrobe = (!!key && Object.values(descriptions[key] || {}).some(value => value.trim()))
      || (!!variantKey && Object.values(variantDescriptions[variantKey] || {}).some(values => Object.values(values).some(value => value.trim())));
    const promptDescription = description || (hasAuthoredWardrobe || selected.has(name)
      ? `Clothing for wardrobe ${type}${variant ? ` variant ${variant}` : ""} is unspecified. Do not borrow clothing from another wardrobe, variant, or older lore.` : "");
    return { entry, name, type, variant, label: types[type] || type, variantLabel: variant ? variants[type]?.[variant] || variant : "", description, promptDescription,
      expressions: Object.keys(outfit.expressions), defaultEmotion: outfit.defaultEmotion || "normal", hasAuthoredWardrobe, observed: observed.has(name) };
  });
}

/** Walk persisted active answers, including compacted rows, once per request.
 * The accepted memory prefix and route cutoff both constrain the scan. Paging
 * stays bounded in memory; no cap silently substitutes Normal for old markers. */
export async function loadStoryWardrobeBranch(args: {
  sessionId: string; turn: TurnMemory; world: WorldDefinition; state?: GameState;
  throughMessageId?: string;
  before?: { id: string; createdAt: Date | null };
}): Promise<WardrobeBranchMessage[]> {
  if (args.sessionId !== args.turn.sessionId) throw new TurnMemoryChangedError();
  if (args.turn.freshStart) return [];
  const unresolved = new Set(resolveStoryWardrobes({ world: args.world, state: args.state, branchMessages: [] }).map(item => item.name));
  if (!unresolved.size) return [];
  await assertTurnMemoryCurrent(args.turn);
  const bounds = [eq(messages.sessionId, args.sessionId)];
  const orderedTime = sql`COALESCE(${messages.createdAt},'1970-01-01'::timestamp)`;
  const anchorIds = [args.throughMessageId, args.turn.storyhaven?.context.messages.at(-1)?.id].filter((id): id is string => !!id);
  // An accepted empty prefix must never see newer live messages.
  if (args.turn.storyhaven && !args.turn.storyhaven.context.messages.length) return [];
  if (!anchorIds.length && !args.before) {
    const [latest] = await db.select({ id: messages.id }).from(messages)
      .where(eq(messages.sessionId, args.sessionId)).orderBy(desc(orderedTime), desc(messages.id)).limit(1);
    if (!latest) return [];
    anchorIds.push(latest.id);
  }
  for (const id of [...new Set(anchorIds)]) {
    const [anchor] = await db.select({ id: messages.id, createdAt: messages.createdAt }).from(messages)
      .where(and(eq(messages.sessionId, args.sessionId), eq(messages.id, id))).limit(1);
    if (!anchor) throw new TurnMemoryChangedError();
    bounds.push(sql`(${orderedTime},${messages.id}) <= (${anchor.createdAt?.toISOString() ?? '1970-01-01'}::timestamp,${anchor.id})`);
  }
  if (args.before) bounds.push(sql`(${orderedTime},${messages.id}) < (${args.before.createdAt?.toISOString() ?? '1970-01-01'}::timestamp,${args.before.id})`);
  let cursor: { id: string; createdAt: Date | null } | undefined;
  const selected: WardrobeBranchMessage[] = [];
  let stopped = false;
  while (unresolved.size && !stopped) {
    const rows = await db.select({
      id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt,
      rawContent: sql<string>`COALESCE(${messages.swipes}->(COALESCE(${messages.activeSwipeIndex},0))->>'rawContent',${messages.content})`,
      stateSnapshot: messages.stateSnapshot,
    }).from(messages).where(and(...bounds, eq(messages.role, "assistant"), eq(messages.status, "complete"),
      ...(cursor ? [sql`(${orderedTime},${messages.id}) < (${cursor.createdAt?.toISOString() ?? '1970-01-01'}::timestamp,${cursor.id})`] : []),
    )).orderBy(desc(orderedTime), desc(messages.id)).limit(128);
    if (!rows.length) break;
    for (const row of rows) {
      const openingId = (row.stateSnapshot as { activeGreetingId?: unknown } | null)?.activeGreetingId;
      if (args.state?.activeGreetingId !== undefined && (typeof openingId === "string" || openingId === null) && openingId !== args.state.activeGreetingId) { stopped = true; break; }
      const resolved = resolveStoryWardrobes({ world: args.world, state: args.state, branchMessages: [row] });
      const latestForAny = resolved.filter(item => item.observed && unresolved.has(item.name));
      if (latestForAny.length) {
        selected.push(row);
        latestForAny.forEach(item => unresolved.delete(item.name));
      }
      // Match the request history's existing current-run reset boundary.
      if (row.content.includes("[CHARACTER_CREATE]")) { stopped = true; break; }
      if (!unresolved.size) break;
    }
    cursor = rows.at(-1)!;
    if (rows.length < 128) break;
  }
  await assertTurnMemoryCurrent(args.turn);
  return selected.reverse();
}


/** Compact state travels with the accepted swipe. The reader uses before until
 * its own passage cursor consumes outfit changes; after belongs to later turns. */
export function snapshotStoryWardrobes(args: {
 world: WorldDefinition; beforeState: GameState; finalState: GameState;
 branchMessages: readonly WardrobeBranchMessage[]; content: string; rawContent?: string; previousReply?: WardrobeBranchMessage;
}): GameState {
 const sameOpening=args.beforeState.activeGreetingId === args.finalState.activeGreetingId;
 const selections=(items: ReturnType<typeof resolveStoryWardrobes>) => Object.fromEntries(items.map(({name,type,variant})=>[name,{type,variant}]));
 const before=selections(resolveStoryWardrobes({world:args.world,state:args.finalState,branchMessages:sameOpening ? args.branchMessages : []}));
 const after=selections(resolveStoryWardrobes({world:args.world,state:args.finalState,initialSelections:before,branchMessages:[...(sameOpening && args.previousReply ? [args.previousReply] : []),{role:'assistant',content:args.content,rawContent:args.rawContent}]}));
 return {...args.finalState,metadata:{...args.finalState.metadata,vnSpriteWardrobes:{version:1,openingId:args.finalState.activeGreetingId ?? null,before,after}}};
}
