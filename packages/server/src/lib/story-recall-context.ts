import { estimateTokens, type WorldDefinition, type GameState } from "@yumina/engine";
import type { ChatMessage } from "./llm/types.js";
import type { TurnMemory } from "./turn-memory.js";
import { TurnMemoryChangedError } from "./turn-memory.js";
import { eligibleStoryCharacters, neededStoryCharacters } from "./story-character-context.js";
import { characterIdentity } from "./story-character-identity.js";
import { chunkLoreContent, packSentences, splitIntoSentences } from "../memory/retrieval.js";

const OPEN = "<story-recall>\n", CLOSE = "\n</story-recall>";
const recalled = (m: ChatMessage) => m.role === "system" && typeof m.content === "string" && m.content.startsWith(OPEN);
function sceneCastText(state?: GameState) {
  if (!state) return "";
  return Object.entries(state.variables ?? {}).filter(([key]) => /scene.?sprites|active.?cast|current.?speaker|characters.?in.?scene|party.?members/i.test(key))
    .map(([,value]) => typeof value === "string" ? value.slice(0,4000) : JSON.stringify(value)?.slice(0,4000) ?? "").join("\n");
}
function messageCost(m: ChatMessage, model: string) {
  return typeof m.content === "string" ? estimateTokens(m.content, model)
    : m.content.reduce((n, part) => n + (part.type === "text" ? estimateTokens(part.text, model) : 1600), 0);
}
function recentHistory(messages: ChatMessage[], prefix: number, suffix: number, budget: number, historyBudget: number, model: string) {
  const first = messages.slice(0, prefix), last = suffix ? messages.slice(-suffix) : [];
  const history = messages.slice(prefix, suffix ? -suffix : undefined);
  let mandatory = -1;
  for (let i=history.length-1;i>=0;i--) if(history[i]!.role==="user"){mandatory=i;break;}
  if (mandatory < 0) {
    mandatory = Math.max(0, history.length - 1);
    for (let i=history.length-1;i>=0;i--) if(history[i]!.role!=="system"){mandatory=i;break;}
  }
  const kept = history.slice(mandatory);
  let spent = [...first, ...last, ...kept].reduce((n,m) => n + messageCost(m, model), 0);
  let historySpent = kept.reduce((n,m) => n + messageCost(m, model), 0);
  for (let i = mandatory - 1; i >= 0; i--) {
    const cost = messageCost(history[i]!, model);
    if (spent + cost > budget || historySpent + cost > historyBudget) break;
    kept.unshift(history[i]!); spent += cost; historySpent += cost;
  }
  return [...first, ...kept, ...last];
}

/** Shared by send/regenerate/continue and rerun against the actual destination.
 * Essential instructions and the latest exchange remain whole; optional recall
 * uses only the remainder. An impossible essential request is rejected by the
 * router before any text-model request. */
export async function fillTurnRecallRequest(args: {
  turn: TurnMemory; world: WorldDefinition; state?: GameState;
  messages: ChatMessage[]; model: string; maxContext: number;
  trim: { pinnedPrefix: number; pinnedSuffix: number; historyTokens?: number };
}): Promise<ChatMessage[]> {
  const {turn, world, state, model, maxContext, trim} = args;
  const original = args.messages.filter(m => !recalled(m));
  const text = original.filter(m => m.role !== "system").slice(-2).map(m =>
    typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join("\n"));
  const query = [turn.query, ...text, sceneCastText(state)].filter(Boolean).join("\n");
  const characters = neededStoryCharacters(world, query, state);
  const biographyTokens = characters.reduce((n,e) => n + estimateTokens(e.content, model), 0);
  const reserve = Math.min(Math.floor(maxContext * .25), biographyTokens + (turn.storyhaven && !turn.freshStart ? 1000 : 0) + (characters.length ? 64 : 0));
  const prefix = Math.min(trim.pinnedPrefix, original.length);
  const messages = recentHistory(original, prefix, trim.pinnedSuffix, maxContext - reserve, trim.historyTokens ?? Infinity, model);
  const remaining = maxContext - messages.reduce((n,m) => n + messageCost(m, model), 0);
  const recallBudget = Math.max(0, remaining - estimateTokens(OPEN + CLOSE, model) - 32);
  let block = "", configured = false;
  if (turn.storyhaven?.input && !turn.freshStart) {
    const result = await turn.storyhaven.adapter.retrieveStoryhavenMemory({
      ...turn.storyhaven.input, query, model, memoryBudgetTokens: recallBudget,
      // This is a visibility allowlist, not a name-match shortlist. Semantic
      // search must still be able to find a relevant first-time character.
      characterEntryIds: eligibleStoryCharacters(world, state).map(e => e.id),
    });
    if (!result.enabled || result.context.epoch !== turn.storyhaven.context.epoch || result.context.sourceHash !== turn.storyhaven.context.sourceHash)
      throw new TurnMemoryChangedError();
    configured = result.result.status === "ready";
    block = result.result.block;
    // The accepted provenance must cover the recall that is actually sent.
    // Preserve the original accepted prefix; a later snapshot cannot bless
    // stale raw history or game state already assembled for this request.
  }
  if (!configured) {
    const selected: string[] = [];
    const identities = characters.map(entry => ({ entry, identity: characterIdentity(entry) }));
    const covered = new Set<string>();
    for (const {entry, identity} of identities) {
      // Freeform biographies keep their existing sentence packing. Structured
      // identity fields get priority even if the fields occur late in a card.
      if (!identity.structured) continue;
      const part = `[Character: ${entry.name}]\n${identity.facts}`;
      if (estimateTokens([...selected, part].join("\n\n"), model) <= recallBudget) { selected.push(part); covered.add(entry.id); }
    }
    const full = characters.map(entry => `[Character: ${entry.name}]\n${entry.content}`);
    const allFit = estimateTokens(full.join("\n\n"), model) <= recallBudget;
    const fairBudget = Math.floor(recallBudget / Math.max(1, characters.length));
    const chunks = characters.map((entry,i) => allFit ? [full[i]!] : chunkLoreContent(entry.content).flatMap(chunk =>
      estimateTokens(`[Character: ${entry.name}]\n${chunk}`,model) <= fairBudget ? [chunk]
        : packSentences(splitIntoSentences(chunk), Math.max(1, Math.floor((fairBudget - 20) / 2)))
    ).map(chunk => `[Character: ${entry.name}]\n${chunk}`));
    // Cover each needed character before using more room on any one biography.
    for (let i=0;i<Math.max(0,...chunks.map(parts=>parts.length));i++) {
      for (const [index, parts] of chunks.entries()) {
        if (identities[index]!.identity.structured && !covered.has(characters[index]!.id)) continue;
        const part = parts[i]; if (!part) continue;
        if (estimateTokens([...selected, part].join("\n\n"), model) <= recallBudget) selected.push(part);
      }
    }
    block = selected.join("\n\n");
  }
  if (block && estimateTokens(OPEN + block + CLOSE, model) <= remaining) {
    messages.splice(prefix, 0, {role: "system", content: OPEN + block + CLOSE});
  }
  return messages;
}
