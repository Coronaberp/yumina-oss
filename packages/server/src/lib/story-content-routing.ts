import { userPersonas } from "../db/schema.js";
import { anonymizePlayerPrompt } from "./player-prompt-identity.js";
import { eq, and, inArray } from "drizzle-orm";
import { PromptBuilder } from "@yumina/engine";
import { estimatePromptMessagesTokens } from "./turn-memory.js";
import { CONTENT_FLAG_POLICY_ID, STORY_SFW_ROUTING_MIN_PROBABILITY, isCompleteContentFlag, type ContentFlagAudit } from "@yumina/shared";
import { db } from "../db/index.js";
import { user, messages as storedMessages } from "../db/schema.js";
import { sourceHash, requiresNsfwRouting, type FlagRole } from "./content-flag-policy.js";
import { kevContentClassifier } from "./kev-content-classifier.js";
import { resolveSavedProfileProvider } from "./saved-profile-provider.js";
import { resolveAdminContentProvider } from './admin-content-defaults.js';
import type { ResolvedProvider } from "./resolve-provider.js";
import type { ChatMessage, LLMProvider } from "./llm/types.js";
import { clampMaxContextToModel } from "./llm/context-window.js";
import { assertImageModel } from "./llm/image-capability.js";
import { turnNeedsVision } from "./llm/fallback-models.js";
import { antiRepetitionInstructionForModel } from "./llm/repetition-detector.js";

type Classifier = { classify(role: FlagRole, content: string, choices?: readonly string[]): Promise<ContentFlagAudit> };
type Selected = { resolved: ResolvedProvider & { profileId?: string }; model: string };
export type RoutingSource = { role: FlagRole; content: string; choices?: readonly string[] };
export interface ContentRoutingRequest {
  playerNames?: (string | null | undefined)[];
  characterNames?: string[];
  userId: string;
  protectedWorld?: boolean;
  selected: Selected;
  messages: ChatMessage[];
  /** Replace an excerpted payload message with its complete source units when
   * assembling the whole request for Kev. */
  sourceOverrides?: Record<number, RoutingSource[]>;
  maxContext?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  modelInstruction?: string | null;
  trim?: { pinnedPrefix: number; pinnedSuffix: number; historyTokens?: number };
  /** Compose optional recall using the actual destination's input ceiling. */
  fitContext?: (messages: ChatMessage[], model: string, maxContext: number) => Promise<ChatMessage[]>;
}
export interface ContentRoutedRequest extends Selected {
  messages: ChatMessage[];
  rerouted: boolean;
  routingLabel: "sfw" | "nsfw" | "unknown" | "disabled";
  maxContext?: number;
}
export class ContentRoutingError extends Error {
  readonly name = "ContentRoutingError";
  constructor(message: string, readonly code: string = "NSFW_FALLBACK_REQUIRED", readonly status: 400 | 403 = 400) { super(message); }
}

/** Classify only included history rows, using the complete selected response and
 * offered choices. Keep its original source even if payload formatting differs. */
export async function includedStorySourceOverrides(userId: string, sessionId: string, prompt: Array<{ role: string; content: string; sourceMessageId?: string }>): Promise<Record<number, RoutingSource[]>> {
  const ids = [...new Set(prompt.flatMap(message => message.sourceMessageId ? [message.sourceMessageId] : []))];
  if (!ids.length) return {};
  const rows = await db.select({ id: storedMessages.id, role: storedMessages.role, content: storedMessages.content, swipes: storedMessages.swipes, activeSwipeIndex: storedMessages.activeSwipeIndex }).from(storedMessages).where(and(eq(storedMessages.sessionId, sessionId), inArray(storedMessages.id, ids)));
  const byId = new Map(rows.map(row => [row.id, row]));
  const overrides: Record<number, RoutingSource[]> = {};
  prompt.forEach((message, index) => {
    if (!message.sourceMessageId) return;
    const row = byId.get(message.sourceMessageId);
    if (!row || row.content !== message.content) throw new ContentRoutingError("The included conversation changed. Retry generation.", "TURN_CHANGED");
    const choices = row.role === "assistant" ? row.swipes?.[row.activeSwipeIndex ?? 0]?.choices ?? [] : [];
    overrides[index] = [{ role: row.role === "assistant" ? "assistant" : row.role === "system" ? "system" : "user", content: row.content, choices }];
  });
  return overrides;
}

function messageSource(message: ChatMessage): RoutingSource {
  let content = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  if (message.role === "assistant" && message.tool_calls?.length) content += `\n\nTool calls:\n${JSON.stringify(message.tool_calls)}`;
  return { role: message.role === "tool" ? "user" : message.role, content };
}

function sourceForMessage(args: Pick<ContentRoutingRequest, "messages" | "sourceOverrides">, index: number): RoutingSource {
  const completeSources = args.sourceOverrides?.[index];
  // Kev judges exactly one item. When a single complete source is available,
  // prefer it over the excerpted prompt rendering. Composite prompt wrappers
  // stay out of Kev's input; their high-risk cues are still checked separately.
  return completeSources?.length === 1 ? completeSources[0]! : messageSource(args.messages[index]!);
}

/** Cache retains hashes and complete verdicts only, never source text. Errors
 * remain unknown and are retried on the next request. Entries are bounded. */
export function createStoryContentRouter(classifier: Classifier = kevContentClassifier) {
  const cache = new Map<string, { audit: ContentFlagAudit; expires: number }>();
  const checked = async (source: RoutingSource): Promise<"sfw" | "nsfw" | "unknown"> => {
    const hash = sourceHash(source.role, source.content, source.choices);
    const key = `${CONTENT_FLAG_POLICY_ID}:${source.role}:${hash}`;
    const cached = cache.get(key);
    let audit = cached && cached.expires > Date.now() ? cached.audit : undefined;
    if (!audit) {
      cache.delete(key);
      try { audit = await classifier.classify(source.role, source.content, source.choices); } catch { return "unknown"; }
      if (!isCompleteContentFlag(audit) || audit.sourceHash !== hash) return "unknown";
      if (cache.size >= 512) cache.delete(cache.keys().next().value!);
      cache.set(key, { audit, expires: Date.now() + 5 * 60_000 });
    }
    if (!isCompleteContentFlag(audit) || audit.sourceHash !== hash) return "unknown";
    // Provider routing is intentionally coarse: allow the selected Story endpoint
    // when Kev estimates at least 60% SFW. The stored audit remains conservative.
    return audit.sfwProbability >= STORY_SFW_ROUTING_MIN_PROBABILITY ? "sfw" : "nsfw";
  };

  const prepare = async (args: ContentRoutingRequest): Promise<ContentRoutedRequest> => {
    const [account] = await db.select({ preferences: user.preferences, username: user.username, displayUsername: user.displayUsername, name: user.name }).from(user).where(eq(user.id, args.userId));
    const personas = await db.select({ name: userPersonas.name }).from(userPersonas).where(eq(userPersonas.userId, args.userId));
    const playerNames = [...(args.playerNames ?? []), account?.username, account?.displayUsername, account?.name, ...personas.map(persona => persona.name)];
    args = { ...args, messages: anonymizePlayerPrompt(args.messages, playerNames, args.characterNames ?? []) };
    const selectedCap = clampMaxContextToModel(args.maxContext ?? 200000, args.selected.model, args.maxTokens, args.reasoningEffort, await args.selected.resolved.provider.getContextWindow?.());
    if (args.fitContext) {
      const sources = new Map(args.messages.map((message,index) => [message,args.sourceOverrides?.[index]]));
      const fitted = await args.fitContext(args.messages, args.selected.model, selectedCap);
      const sourceOverrides: Record<number, RoutingSource[]> = {};
      fitted.forEach((message,index) => {const source=sources.get(message);if(source)sourceOverrides[index]=source;});
      args = {...args,messages:anonymizePlayerPrompt(fitted,playerNames,args.characterNames??[]),sourceOverrides};
    }
    const fallbackId = account?.preferences?.nsfwApiKeyId;
    const configured = fallbackId !== null && fallbackId !== undefined && fallbackId !== "";
    const inherited = configured ? undefined : await resolveAdminContentProvider('nsfw');
    const fallback = configured ? await resolveSavedProfileProvider(args.userId, fallbackId) : inherited ?? null;
    if ((configured || inherited !== undefined) && !fallback) throw new ContentRoutingError("Configure a valid NSFW fallback provider and model in Settings → AI config before generating.");
    const selectedRequest = async (routingLabel: "sfw" | "nsfw"): Promise<ContentRoutedRequest> => {
      const cap = selectedCap;
      if (Number.isFinite(cap)) {
        const textMessages = args.messages.map(message => ({ ...messageSource(message), imageTokens: typeof message.content === "string" ? 0 : message.content.filter(part => part.type === "image_url").length * 1600 }));
        if (estimatePromptMessagesTokens(textMessages, args.selected.model) > cap!) throw new ContentRoutingError("This request exceeds the endpoint's context window. Reduce always-send context or choose a larger endpoint window.", "CONTENT_ROUTING_CONTEXT_LIMIT");
      }
      return { ...args.selected, messages: args.messages, rerouted: false, routingLabel, maxContext: cap };
    };
    // Selecting the exact fallback profile and model for Story deliberately
    // uses the NSFW destination. A shared connection can host other models that
    // still require checks and a switch to the configured fallback model.
    if (fallback && args.selected.resolved.profileId === fallback.profileId && args.selected.model === fallback.model) return selectedRequest("nsfw");
    let activeMessageIndex = -1;
    args.messages.forEach((message, index) => { if (message.role !== "system") activeMessageIndex = index; });
    // Kev receives one complete active message or response, never the serialized
    // conversation history. Older assistant turns cannot affect its verdict.
    // Keep the explicit-risk guard on system instructions and the active turn.
    const guardedSources = args.messages.flatMap((message, index) =>
      index === activeMessageIndex || message.role === "system" ? [sourceForMessage(args, index)] : []);
    const guardedPayload = args.messages.filter((message, index) =>
      index === activeMessageIndex || message.role === "system");
    const activeSource = activeMessageIndex >= 0 ? sourceForMessage(args, activeMessageIndex) : null;
    let label: "sfw" | "nsfw" | "unknown" = guardedPayload.some(message => {
      const source = messageSource(message);
      return requiresNsfwRouting(source.content);
    }) || guardedSources.some(source => requiresNsfwRouting(source.content, source.choices))
      ? "nsfw"
      : turnNeedsVision(args.messages) || !activeSource ? "unknown" : await checked(activeSource);
    if (label === "sfw") return selectedRequest(label);
    if (!fallback) throw new ContentRoutingError("Configure an NSFW fallback provider and model in Settings → AI config before sending unsafe or uncertain content.");
    if (args.protectedWorld) throw new ContentRoutingError("This protected world cannot send its content to a private NSFW fallback provider.", "PROTECTED_WORLD", 403);
    if (!args.selected.resolved.isByok) throw new ContentRoutingError("An official Story request cannot switch to a private NSFW fallback. Select a saved Story provider in Settings → AI config.", "CONTENT_ROUTING_PROVIDER_REQUIRED", 403);

    let messages = args.messages;
    // The model-specific instruction is always a complete system message.
    if (args.modelInstruction) messages = messages.filter(message => !(message.role === "system" && message.content === args.modelInstruction));
    const nextInstruction = antiRepetitionInstructionForModel(fallback.model);
    if (nextInstruction) messages = [...messages, { role: "system", content: nextInstruction }];
    const cap = clampMaxContextToModel(args.maxContext ?? 200000, fallback.model, args.maxTokens, args.reasoningEffort, await fallback.provider.getContextWindow?.());
    if (args.fitContext) messages = anonymizePlayerPrompt(await args.fitContext(messages, fallback.model, cap), playerNames, args.characterNames ?? []);
    const textMessages = messages.map(message => ({ role: message.role === "tool" ? "user" as const : message.role, content: typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n"), imageTokens: typeof message.content === "string" ? 0 : message.content.filter(part => part.type === "image_url").length * 1600 }));
    if (estimatePromptMessagesTokens(textMessages, fallback.model) > cap) {
      if (!args.trim) throw new ContentRoutingError("This request exceeds the NSFW fallback model's context window. Shorten the context or choose a larger model.", "CONTENT_ROUTING_CONTEXT_LIMIT");
      const suffix = Math.max(0, args.trim.pinnedSuffix - (args.modelInstruction ? 1 : 0)) + (nextInstruction ? 1 : 0);
      const kept = await new PromptBuilder().buildMessageHistoryAsync(textMessages, async () => {}, cap, args.trim.pinnedPrefix, suffix, fallback.model, args.trim.historyTokens);
      const refs = new Set(kept);
      messages = messages.filter((_message, index) => refs.has(textMessages[index]!));
      if (estimatePromptMessagesTokens(textMessages.filter(message => refs.has(message)), fallback.model) > cap) throw new ContentRoutingError("The pinned context or latest message exceeds the NSFW fallback model's context window.", "CONTENT_ROUTING_CONTEXT_LIMIT");
    }
    if (turnNeedsVision(messages)) await assertImageModel(fallback, fallback.model);
    return { resolved: fallback, model: fallback.model, messages, rerouted: true, routingLabel: label, maxContext: cap };
  };

  const decorate = (args: { userId: string; protectedWorld?: boolean; selected: Selected }): LLMProvider => new Proxy(args.selected.resolved.provider, {
    get(target, property) {
      if (property === "generateStream") return async function* (params: Parameters<LLMProvider["generateStream"]>[0]) {
        const routed = await prepare({ ...args, selected: { ...args.selected, model: params.model }, messages: params.messages, maxTokens: params.maxTokens, reasoningEffort: params.reasoningEffort });
        for await (const chunk of routed.resolved.provider.generateStream({ ...params, model: routed.model, messages: routed.messages, ...(routed.rerouted ? { cacheBreakpoints: undefined, fallbackModels: undefined } : {}) })) yield { ...chunk, model: chunk.model ?? routed.model };
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { prepare, decorate };
}

const storyContentRouter = createStoryContentRouter();
export const prepareContentRoutedRequest = storyContentRouter.prepare;
export const decorateStoryProvider = storyContentRouter.decorate;
