import { estimateTokens } from "@yumina/engine";
import { prepareContentRoutedRequest, ContentRoutingError, type ContentRoutingRequest } from "./story-content-routing.js";
import { CharacterIdentityError, type CharacterGuardRequest } from "./story-character-guard.js";
import type { ChatMessage, StreamChunk } from "./llm/types.js";

const cost = (messages: ChatMessage[], model: string) => messages.reduce((n, m) => n + estimateTokens(typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join("\n"), model) + 4, 3);

/** The last user packet and all original system instructions stay whole.
 * Additional model-specific system messages at the end stay whole too. */
export function fitCharacterGuardMessages(messages: ChatMessage[], prefix: number, model: string, cap: number): ChatMessage[] {
  let end = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") { end = i; break; }
  const first = messages.slice(0, prefix), last = messages.slice(Math.max(prefix, end));
  const kept: ChatMessage[] = [];
  if (cost([...first, ...last], model) > cap) throw new CharacterIdentityError("character_identity_context_limit");
  for (let i = end - 1; i >= prefix; i--) {
    const message = messages[i]!;
    if (cost([...first, message, ...kept, ...last], model) > cap) break;
    kept.unshift(message);
  }
  return [...first, ...kept, ...last];
}

export interface CharacterGuardUsage {
  stage: CharacterGuardRequest["stage"];
  model: string;
  requestedModel: string;
  apiKeyTier: string;
  isByok: boolean;
  usage: NonNullable<StreamChunk["usage"]>;
  observedUsage?: StreamChunk["usage"];
  completed: boolean;
}

export function createCharacterGuardTransport(args: {
  userId: string; selected: ContentRoutingRequest["selected"]; protectedWorld?: boolean;
  maxContext: number; signal: AbortSignal; startedAt: number; reviewTimeoutMs?: number;
  playerNames?: (string | null | undefined)[]; characterNames?: string[];
  route?: typeof prepareContentRoutedRequest;
  recordUsage: (record: CharacterGuardUsage) => Promise<void>;
}) {
  return async (request: CharacterGuardRequest) => {
    if (args.signal.aborted) throw new CharacterIdentityError("cancelled");
    const remaining = 180_000 - (Date.now() - args.startedAt);
    if (remaining < 1000) throw new CharacterIdentityError("character_identity_deadline");
    const controller = new AbortController();
    const abort = () => controller.abort(args.signal.reason);
    args.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, request.stage === "review" ? (args.reviewTimeoutMs ?? 60_000) : 120_000));
    const prefix = Math.max(0, request.messages.length - 1);
    const messages = [...request.messages.slice(0, prefix), ...request.history, ...request.messages.slice(prefix)];
    let routed: Awaited<ReturnType<typeof prepareContentRoutedRequest>> | undefined;
    let raw = "", done = false, started = false, stopReason: string | undefined, servedModel = args.selected.model;
    let observedUsage: StreamChunk["usage"];
    let providerRequestId: string | undefined;
    try {
      routed = await (args.route ?? prepareContentRoutedRequest)({ userId: args.userId, protectedWorld: args.protectedWorld, selected: args.selected, playerNames: args.playerNames, characterNames: args.characterNames, messages, maxContext: args.maxContext, maxTokens: request.maxTokens,
        fitContext: async (m, model, cap) => fitCharacterGuardMessages(m, prefix, model, cap), trim: { pinnedPrefix: prefix, pinnedSuffix: 1 },
      });
      if (controller.signal.aborted) throw new CharacterIdentityError("cancelled");
      servedModel = routed.model;
      started = true;
      for await (const chunk of routed.resolved.provider.generateStream({ messages: routed.messages, model: routed.model, maxTokens: request.maxTokens, temperature: 0, reasoningEffortOverride: "low", stream: false, signal: controller.signal,
        ...(request.stage === "review" ? { responseFormat: { type: "json_object" as const } } : {}),
      })) {
        if (chunk.model) servedModel = chunk.model;
        if (chunk.providerRequestId) providerRequestId = chunk.providerRequestId;
        if (chunk.usage) observedUsage = chunk.usage;
        if (controller.signal.aborted) throw new CharacterIdentityError("cancelled");
        if (chunk.type === "text") raw += chunk.content;
        if (chunk.type === "error") throw new CharacterIdentityError("character_identity_provider_failed");
        if (chunk.type === "done") { done = true; stopReason = chunk.stopReason; break; }
      }
      if (!done || !raw.trim()) throw new CharacterIdentityError("character_identity_provider_incomplete");
      return { raw, stopReason };
    } catch (error) {
      if (error instanceof CharacterIdentityError || error instanceof ContentRoutingError) throw error;
      throw new CharacterIdentityError(controller.signal.aborted ? "character_identity_deadline" : "character_identity_provider_failed");
    } finally {
      clearTimeout(timer);
      args.signal.removeEventListener("abort", abort);
      if (started && routed) {
        const promptTokens = observedUsage?.promptTokens ?? cost(routed.messages, routed.model);
        const completionTokens = observedUsage?.completionTokens ?? estimateTokens(raw, servedModel);
        const usage = observedUsage ?? { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, providerRequestId };
        await args.recordUsage({ stage: request.stage, model: servedModel, requestedModel: routed.model, apiKeyTier: routed.resolved.apiKeyTier, isByok: routed.resolved.isByok, usage, observedUsage, completed: done && !controller.signal.aborted });
      }
    }
  };
}
