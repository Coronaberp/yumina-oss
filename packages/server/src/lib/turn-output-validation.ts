import { activeChapter, chapterEventContext } from "@yumina/engine";
import { reviewChapterEventMoments } from "./chapter-event-review.js";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { GameStateManager, ResponseParser, StructuredResponseParser, estimateTokens, preserveSetupScopedVariables, standardizeSpeakerMarkup, displayCharacterName, type GameState, type WorldDefinition, type ParseResult } from "@yumina/engine";
import { parseStateGuardModel, type StateValidationAudit } from "@yumina/shared";
import { db } from "../db/index.js";
import { messages, playSessions, worlds, worldPendingEdits } from "../db/schema.js";
import { turnOutputInstructions, validateTurnOutput, type TurnHookDispatch, type TurnOutputContext } from "./extension-hooks.js";
import { isExtensionInstalled } from "./extensions.js";
import { recordUsageLog } from "./usage-log.js";
import { StateGuardError } from "../extensions/state-update-guard/validate.js";
import { captureServerEvent } from "./analytics.js";
import { resolveGuardModel, resolveGuardModelSelection } from "../extensions/state-update-guard/model.js";
import { backgroundUsageCost, backgroundBillingLabel, notEnoughMushiesMessage } from "./background-billing.js";
import { withoutContentFlags } from "./content-flag-history.js";
import { calculateCost, deductCredits } from "./credit-service.js";
import { purgePlayerAgency } from "./player-agency.js";
import { eligibleStoryCharacters } from "./story-character-context.js";
import { guardStoryCharacterIdentity, characterIdentityState, mentionedCharacterIdentities, type CharacterGuardRequest, type CharacterGuardReply } from "./story-character-guard.js";
import { createCharacterGuardTransport } from "./story-character-transport.js";
import { usageObservation } from "./usage-observation.js";
import type { ResolvedProvider } from "./resolve-provider.js";
import type { ChatMessage } from "./llm/types.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Target = Pick<typeof messages.$inferSelect, "id" | "content" | "activeSwipeIndex" | "swipes">;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex");
const targetFingerprint = (row: Target) => fingerprint([row.id, row.content, row.activeSwipeIndex, withoutContentFlags(row.swipes)]);

function standardizeTurnPresentation(parsed: ParseResult, world: WorldDefinition): ParseResult {
  if (world?.rootComponent?.interfaceId !== "vn") return parsed;
  const names = world.entries.filter(entry => entry.role === "character" && entry.enabled !== false).map(entry => displayCharacterName(entry.name));
  const source = parsed.speaker && !/^\s*\[\s*(?:speaker|name)\s*:/i.test(parsed.cleanText) ? `[speaker:${parsed.speaker}]\n${parsed.cleanText}` : parsed.cleanText;
  return { ...parsed, cleanText: standardizeSpeakerMarkup(source, names) };
}

export function guardPrompt(dispatch: TurnHookDispatch): { content: string; reserve: number } {
  const content = turnOutputInstructions(dispatch);
  return { content, reserve: content ? estimateTokens(content) + 64 : 0 };
}

/** Continuation applies only NEW effects, but its saved swipe is the WHOLE
 * reply. Preserve the full delta ledger so later regeneration can undo it. */
export function appendTurnStateChanges(previous: unknown, next: unknown[]): Record<string, unknown> | undefined {
  const combined = [...(Array.isArray(previous) ? previous : []), ...next];
  return combined.length ? combined as unknown as Record<string, unknown> : undefined;
}

/** Guarded regeneration starts before the replaced AI turn, not after it. */
export function regenerationBaseline(world: WorldDefinition, current: GameState, message: { swipes: unknown; activeSwipeIndex: number | null; stateChanges: unknown }): GameState {
  const swipes = message.swipes as Array<{ generationState?: GameState }> | null;
  const stored = swipes?.[message.activeSwipeIndex ?? 0]?.generationState;
  const baseline = structuredClone(current);
  const changed = new Set<string>();
  // Historical swipes lack a baseline. Reverse their recorded deltas in order;
  // preserve unrelated current UI-owned values, never replay the old AI batch.
  if (Array.isArray(message.stateChanges)) {
    for (const change of [...message.stateChanges].reverse()) {
      if (change && typeof change.variableId === "string" && change.oldValue !== undefined) {
        if (!changed.has(change.variableId) && fingerprint(current.variables[change.variableId]) !== fingerprint(change.newValue)) continue;
        changed.add(change.variableId);
        baseline.variables[change.variableId] = change.oldValue;
      }
    }
  }
  // The saved pre-AI baseline already includes character-creation/user seeds.
  // Use it only for keys this reply changed, never for unrelated current UI.
  for (const key of changed) {
    const value = stored?.variables?.[key];
    if (value !== undefined) baseline.variables[key] = structuredClone(value);
  }
  if (stored) baseline.storyEvents = structuredClone(stored.storyEvents);
  if (stored?.ruleState) baseline.ruleState = {
    ...structuredClone(stored.ruleState),
    toggledVariables: current.ruleState?.toggledVariables,
    toggledEntries: current.ruleState?.toggledEntries ?? {},
  };
  return new GameStateManager(world, preserveSetupScopedVariables(world.variables, { ...current }, { ...baseline })).getSnapshot();
}

export class TurnOutputAttempt {
  readonly audit: StateValidationAudit;
  private targetHash = "";
  private lastId?: string;
  private committed = false;
  private touched = new Set<string>();
  private readonly narrativeUsageId = randomUUID();
  private failedDraft = "";
  private correctionUsage?: { id: string; model: string; promptTokens: number; completionTokens: number; providerCostUsd?: number };
  private correctionCost = 0;
  private identityCharges: Array<{ id: string; model: string; cost: number; tokens: number; endpoint: string }> = [];
  private identityReadSet = new Set<string>();
  private balanceAfterCorrection?: number;
  private preparedStoryCharge?: { cost: number; model: string; tokens: number };
  private storyBalance?: number;
  constructor(private readonly args: {
    dispatch: TurnHookDispatch; userId: string; sessionId: string; targetId: string;
    path: StateValidationAudit["path"]; world: WorldDefinition; baseline: GameState;
    model: string; apiKeyTier: string; startedAt: number;
    worldVersion: string | null; pendingVersion: string | null;
    worldId: string; checkPending: boolean;
    signal: AbortSignal;
    identityProvider?: ResolvedProvider & { profileId?: string };
    identityMaxTokens?: number;
    protectedWorld?: boolean;
    identityRequest?: (request: CharacterGuardRequest) => Promise<CharacterGuardReply>;
    eventRequest?: (request: CharacterGuardRequest) => Promise<CharacterGuardReply>;
  }, private readonly database: Pick<typeof db, "transaction" | "select" | "update"> = db) {
    this.audit = {
      version: 1, attemptId: randomUUID(), targetMessageId: args.targetId, path: args.path, outcome: "validating",
      diagnostics: [], parsedCount: 0, repaired: false, correctionCount: 0,
      model: args.model, apiKeyTier: args.apiKeyTier, startedAt: new Date(args.startedAt).toISOString(),
      baselineFingerprint: fingerprint(args.baseline), usageLogIds: [],
      changes: [], committed: false,
    };
  }
  get enabled(): boolean { return this.args.dispatch.activeExtensions.has("state-update-guard"); }
  private get identityActive(): boolean { return eligibleStoryCharacters(this.args.world, this.args.baseline).some(e => e.content?.trim()); }
  // A replacement can rewind a completed event. Fence that operation too,
  // even though the live (post-reply) baseline has no pending scene.
  private get eventsActive(): boolean { return Boolean(activeChapter(this.args.world, this.args.baseline)?.events?.some(event => event.enabled)); }
  private get fenced(): boolean { return this.enabled || this.identityActive || this.eventsActive; }
  get started(): boolean { return this.enabled && Boolean(this.targetHash); }
  get correctionBalance(): number | undefined { return this.committed ? this.balanceAfterCorrection : undefined; }
  get storyCharge(): { cost: number; balance: number | undefined } | undefined {
    return this.committed && this.preparedStoryCharge ? { cost: this.preparedStoryCharge.cost, balance: this.storyBalance } : undefined;
  }
  /** Only paid corrections need to join the normally separate story debit. */
  async prepareStoryCharge(args: { model: string; promptTokens: number; completionTokens: number; providerCostUsd?: number }): Promise<void> {
    if (this.correctionCost <= 0 && !this.identityCharges.some(c => c.cost > 0)) return;
    this.preparedStoryCharge = { cost: await calculateCost(args.model, args.promptTokens, args.completionTokens, { providerCostUsd: args.providerCostUsd }), model: args.model, tokens: args.promptTokens + args.completionTokens };
  }

  trackNarrativeUsage(): string {
    if (this.enabled && !this.audit.usageLogIds.includes(this.narrativeUsageId)) this.audit.usageLogIds.push(this.narrativeUsageId);
    return this.narrativeUsageId;
  }

  /** Capture real engine deltas, not model claims. Bounded owner-only previews. */
  recordChanges(ai: Array<{ variableId: string; oldValue: unknown; newValue: unknown }>, rules: Array<{ variableId: string; oldValue: unknown; newValue: unknown }>): void {
    if (!this.enabled) return;
    const all = [...ai.map((change) => ({ ...change, source: "ai" as const })), ...rules.map((change) => ({ ...change, source: "rule" as const }))];
    let budget = 48_000;
    this.audit.changes = [];
    this.audit.changesTruncated = false;
    for (const change of all) {
      if (this.audit.changes.length >= 100 || budget < 1000) { this.audit.changesTruncated = true; break; }
      let truncated = false;
      const preview = (value: unknown) => {
        const json = JSON.stringify(value) ?? "null";
        const limit = Math.min(4000, Math.floor(budget / 2));
        if (json.length > limit) { truncated = true; budget -= limit; return json.slice(0, limit) + "…"; }
        budget -= json.length;
        return JSON.parse(json) as unknown;
      };
      const oldValue = preview(change.oldValue);
      const newValue = preview(change.newValue);
      this.audit.changes.push({ variableId: change.variableId, oldValue, newValue, source: change.source, ...(truncated ? { truncated: true } : {}) });
    }
  }

  async begin(): Promise<void> {
    if (!this.fenced) return;
    if (this.enabled && process.env.STATE_UPDATE_GUARD_DISABLED === "true") throw new StateGuardError("disabled");
    await this.database.transaction(async (tx) => {
      const [session] = await tx.select({ id: playSessions.id }).from(playSessions).where(and(eq(playSessions.id, this.args.sessionId), eq(playSessions.userId, this.args.userId))).for("update");
      if (!session || this.args.signal.aborted) throw new StateGuardError("stale_target");
      const [target] = await tx.select().from(messages).where(and(eq(messages.id, this.args.targetId), eq(messages.sessionId, this.args.sessionId)));
      if (!target) throw new StateGuardError("stale_target");
      const active = target.stateValidation;
      if (active && ["validating", "repairing"].includes(active.outcome) && Date.now() - Date.parse(active.startedAt) < 180_000) throw new StateGuardError("already_running");
      this.targetHash = targetFingerprint(target);
      const [last] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, this.args.sessionId)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
      this.lastId = last?.id;
      if (this.enabled) await tx.update(messages).set({ stateValidation: this.audit }).where(eq(messages.id, target.id));
    });
  }

  async progress(audit = this.audit): Promise<void> {
    if (!this.enabled || !this.targetHash || this.committed) return;
    await this.database.update(messages).set({ stateValidation: audit }).where(and(eq(messages.id, this.args.targetId), sql`${messages.stateValidation}->>'attemptId' = ${this.audit.attemptId}`));
  }

  async validate(ctx: Omit<TurnOutputContext, "audit" | "mayCorrect" | "progress" | "recordUsage">, onProgress: (audit: StateValidationAudit) => Promise<void>) {
    ctx = { ...ctx, parsed: standardizeTurnPresentation(ctx.parsed, ctx.world) };
    const cleaned = purgePlayerAgency(ctx.parsed, ctx.raw, ctx.playerNames, ctx.characterNames, ctx.personaControlMode);
    ctx = { ...ctx, parsed: cleaned.parsed, raw: cleaned.raw };
    const request = this.args.identityRequest ?? (this.args.identityProvider ? createCharacterGuardTransport({
      userId: this.args.userId, selected: { resolved: this.args.identityProvider, model: this.args.model },
      protectedWorld: this.args.protectedWorld, maxContext: ctx.maxContext, signal: ctx.signal, startedAt: this.args.startedAt,
      playerNames: ctx.playerNames, characterNames: ctx.characterNames,
      recordUsage: async record => {
        const id = randomUUID(), endpoint = `character-identity-${record.stage}`;
        await recordUsageLog({ id, userId: this.args.userId, sessionId: this.args.sessionId, model: record.model, ...record.usage, ...usageObservation(record.observedUsage), endpoint, apiKeyTier: record.apiKeyTier, generationTimeMs: Date.now() - this.args.startedAt });
        const free = record.requestedModel === "openrouter/free" || record.requestedModel.endsWith(":free");
        const cost = record.isByok || free || !record.completed ? 0 : await backgroundUsageCost({ userId: this.args.userId, model: record.model, ...record.usage });
        this.identityCharges.push({ id, model: record.model, cost, tokens: record.usage.totalTokens, endpoint });
      },
    }) : undefined);
    const identityArgs = {
      world: ctx.world, state: ctx.state, signal: ctx.signal,
      history: (ctx.history ?? []).map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : "[attachment]" })) as ChatMessage[],
      instructions: (ctx.history ?? []).filter(m => m.role === "system" && typeof m.content === "string" && !m.content.startsWith("<story-recall>")).map(m => ({ role: "system" as const, content: m.content as string })),
      maxTokens: Math.max(256, Math.min(this.args.identityMaxTokens ?? this.args.world.settings?.maxTokens ?? 4096, 32768)),
      request: request ?? (async () => { throw new Error("Character identity provider is unavailable. Please retry."); }),
    };
    const readIdentity = (raw: string) => {
      for (const id of Object.keys(characterIdentityState(ctx.world, ctx.state, mentionedCharacterIdentities(ctx.world, raw, ctx.state)))) this.identityReadSet.add(id);
    };
    if (this.identityActive) {
      readIdentity(ctx.raw);
      const checked = await guardStoryCharacterIdentity({ ...identityArgs, raw: ctx.raw });
      readIdentity(checked.raw);
      if (checked.corrected) {
        const structured = new StructuredResponseParser();
        const parsed = structured.isStructuredResponse(checked.raw) ? structured.parse(checked.raw)
          : new ResponseParser().parse(checked.raw, undefined, ctx.world.variables.flatMap(v => [v.id, v.name]));
        const final = purgePlayerAgency(standardizeTurnPresentation(parsed, ctx.world), checked.raw, ctx.playerNames, ctx.characterNames, ctx.personaControlMode);
        ctx = { ...ctx, raw: final.raw, parsed: final.parsed };
      }
      this.touched = new Set(ctx.parsed.effects.map(e => e.variableId.split(".")[0]!));
    }
    if (!this.enabled) return { parsed: await this.reviewEvents(ctx), raw: ctx.raw };
    this.failedDraft = ctx.raw.slice(0, 65_536);
    if (ctx.raw.trim()) this.trackNarrativeUsage();
    this.audit.model = ctx.model;
    const result = await validateTurnOutput(this.args.dispatch, {
      ...ctx, audit: this.audit,
      resolveCorrection: async () => {
        const model = resolveGuardModelSelection(this.args.dispatch.outputModels?.get("state-update-guard"), this.args.model);
        const [world] = await this.database.select({ creatorId: worlds.creatorId, allowCustomApi: worlds.allowCustomApi })
          .from(worlds).where(eq(worlds.id, this.args.worldId));
        if (!world) throw new StateGuardError("stale_target");
        try { return await resolveGuardModel(this.args.userId, model, world.allowCustomApi === false && world.creatorId !== this.args.userId); }
        catch { throw new StateGuardError("correction_model_unavailable"); }
      },
      mayCorrect: async () => process.env.STATE_UPDATE_GUARD_DISABLED !== "true" && await isExtensionInstalled(this.args.userId, "state-update-guard"),
      progress: async (audit) => { await this.progress(audit); await onProgress(audit); },
      recordUsage: async (usage, model) => {
        const id = randomUUID();
        await recordUsageLog({ id, userId: this.args.userId, sessionId: this.args.sessionId, model, ...usage, providerCostUsd: usage.providerCostUsd?.toString(), endpoint: "state-update-guard", apiKeyTier: this.audit.correctionApiKeyTier ?? this.args.apiKeyTier, generationTimeMs: Date.now() - this.args.startedAt });
        this.correctionUsage = { id, model, ...usage };
        return id;
      },
    });
    const final = purgePlayerAgency(standardizeTurnPresentation(result.parsed, ctx.world), ctx.raw, ctx.playerNames, ctx.characterNames, ctx.personaControlMode);
    result.parsed = final.parsed;
    // State correction freezes narrative, but enforce that contract before
    // accepting any replacement prose or rendered scene state it returns.
    if (this.identityActive && (result.parsed.cleanText !== ctx.parsed.cleanText || JSON.stringify(result.parsed.effects.filter(e => /segments|dialogue|narrative/i.test(e.variableId))) !== JSON.stringify(ctx.parsed.effects.filter(e => /segments|dialogue|narrative/i.test(e.variableId))))) {
      const finalDraft = result.parsed.cleanText + "\n" + JSON.stringify(result.parsed.effects);
      readIdentity(finalDraft);
      await guardStoryCharacterIdentity({ ...identityArgs, raw: finalDraft, mayCorrect: false });
    }
    // Failed corrections log usage but never reach billing. Price the requested
    // free router as free even when it reports the paid model that served it.
    if (this.correctionUsage && this.audit.correctionApiKeyTier !== "byok") {
      const requested = parseStateGuardModel(resolveGuardModelSelection(this.args.dispatch.outputModels?.get("state-update-guard"), this.args.model)).model;
      this.correctionCost = requested === "openrouter/free" || requested?.endsWith(":free") ? 0
        : await backgroundUsageCost({ userId: this.args.userId, ...this.correctionUsage });
    }
    this.touched = new Set(result.parsed.effects.map((effect) => effect.variableId.split(".")[0]!));
    return { ...result, parsed: await this.reviewEvents({ ...ctx, parsed: result.parsed }), raw: final.raw };
  }

  private async reviewEvents(ctx: Omit<TurnOutputContext, "audit" | "progress" | "recordUsage" | "mayCorrect">): Promise<ParseResult> {
    if (!ctx.world?.chapters?.some(chapter => chapter.events?.length)) return ctx.parsed;
    const context = chapterEventContext(ctx.world, ctx.state);
    if (!context) return ctx.parsed;
    for (const condition of [...context.event.conditions, ...context.scene.completionConditions]) {
      for (const id of [condition.variableId, condition.valueRef]) if (id) this.identityReadSet.add(id.split(".")[0]!);
    }
    const resolved = this.args.identityProvider ?? { provider: ctx.provider, providerName: "custom" as const, isByok: this.args.apiKeyTier === "byok", apiKeyTier: this.args.apiKeyTier as ResolvedProvider["apiKeyTier"] };
    const request = this.args.eventRequest ?? createCharacterGuardTransport({
      userId: this.args.userId, selected: { resolved, model: this.args.model }, protectedWorld: this.args.protectedWorld,
      maxContext: Math.min(ctx.maxContext, 16_000), signal: ctx.signal, startedAt: this.args.startedAt, reviewTimeoutMs: 20_000,
      playerNames: ctx.playerNames, characterNames: ctx.characterNames,
      recordUsage: async record => {
        const id = randomUUID(), endpoint = "chapter-event-check";
        await recordUsageLog({ id, userId: this.args.userId, sessionId: this.args.sessionId, model: record.model, ...record.usage, ...usageObservation(record.observedUsage), endpoint, apiKeyTier: record.apiKeyTier, generationTimeMs: Date.now() - this.args.startedAt });
        const free = record.requestedModel === "openrouter/free" || record.requestedModel.endsWith(":free");
        const cost = record.isByok || free || !record.completed ? 0 : await backgroundUsageCost({ userId: this.args.userId, model: record.model, ...record.usage });
        this.identityCharges.push({ id, model: record.model, cost, tokens: record.usage.totalTokens, endpoint });
      },
    });
    const eventEvidence = await reviewChapterEventMoments({ world: ctx.world, state: ctx.state, narrative: ctx.parsed.cleanText, request });
    return { ...ctx.parsed, eventEvidence };
  }

  /** Called under the EXISTING session lock, before writes. No provider work. */
  async checkCommit(tx: Tx, liveState: unknown, finalState: GameState): Promise<void> {
    if (!this.fenced) return;
    const stale = () => { this.audit.outcome = "stale"; throw new StateGuardError("stale_state"); };
    if (this.args.signal.aborted) throw new StateGuardError("cancelled");
    if ((this.enabled && process.env.STATE_UPDATE_GUARD_DISABLED === "true") || this.committed) stale();
    const [session] = await tx.select({ userId: playSessions.userId, worldId: playSessions.worldId }).from(playSessions).where(eq(playSessions.id, this.args.sessionId));
    if (session?.userId !== this.args.userId || session.worldId !== this.args.worldId) stale();
    const [target] = await tx.select().from(messages).where(eq(messages.id, this.args.targetId));
    if (!target || targetFingerprint(target) !== this.targetHash || (this.enabled && target.stateValidation?.attemptId !== this.audit.attemptId)) stale();
    const [last] = await tx.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, this.args.sessionId)).orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
    if (last?.id !== this.lastId) stale();
    const [world] = await tx.select({ updatedAt: worlds.updatedAt }).from(worlds).where(eq(worlds.id, this.args.worldId)).for("share");
    const [pending] = this.args.checkPending ? await tx.select({ updatedAt: worldPendingEdits.updatedAt }).from(worldPendingEdits).where(eq(worldPendingEdits.worldId, this.args.worldId)).for("share") : [];
    if ((world?.updatedAt?.toISOString() ?? null) !== this.args.worldVersion || (this.args.checkPending && (pending?.updatedAt?.toISOString() ?? null) !== this.args.pendingVersion)) stale();
    const live = new GameStateManager(this.args.world, liveState as GameState).getSnapshot();
    const base = this.args.baseline;
    if (this.identityActive || this.eventsActive) {
      const gates = [
        ...this.args.world.entries.filter(e => e.role === "character").flatMap(e => e.conditions ?? []),
        ...(this.args.world.worldbooks ?? []).flatMap(b => b.activation.mode === "conditions" ? b.activation.conditions : []),
        ...(this.args.world.loreUiBindings ?? []).flatMap(b => b.conditions ?? []),
        ...this.args.world.variables.filter(v => this.identityReadSet.has(v.id))
          .flatMap(v => v.activation?.mode === "conditions" ? v.activation.conditions : []),
      ];
      for (const condition of gates) for (const id of [condition.variableId, condition.valueRef]) if (id) this.identityReadSet.add(id.split(".")[0]!);
      for (const binding of this.args.world.loreUiBindings ?? []) this.identityReadSet.add(`__lore_${binding.slotId}`);
      if (fingerprint(live.metadata?.activeLoreSlots) !== fingerprint(base.metadata?.activeLoreSlots)) stale();
      for (const id of this.identityReadSet) if (fingerprint(live.variables[id]) !== fingerprint(base.variables[id])) stale();
    }
    if (fingerprint([live.turnCount, live.activeGreetingId, live.activeCharacterId, live.ruleState, live.storyEvents]) !== fingerprint([base.turnCount, base.activeGreetingId, base.activeCharacterId, base.ruleState, base.storyEvents])) stale();
    for (const key of Object.keys(finalState.variables)) {
      if (this.touched.has(key) || fingerprint(finalState.variables[key]) !== fingerprint(base.variables[key])) {
        if (fingerprint(live.variables[key]) !== fingerprint(base.variables[key])) stale();
      }
    }
    if (this.args.signal.aborted) throw new StateGuardError("cancelled");
    if ((this.correctionCost > 0 && this.correctionUsage) || this.identityCharges.some(c => c.cost > 0)) {
      try {
        for (const charge of this.identityCharges.filter(c => c.cost > 0)) {
          this.balanceAfterCorrection = (await deductCredits(this.args.userId, charge.cost, charge.id,
            `${backgroundBillingLabel(charge.endpoint)} — ${charge.model} — ${charge.tokens} tokens`, tx)).newBalance;
        }
        if (this.correctionCost > 0 && this.correctionUsage) {
        const charge = await deductCredits(this.args.userId, this.correctionCost, this.correctionUsage.id,
          `${backgroundBillingLabel("state-update-guard")} — ${this.correctionUsage.model} — ${this.correctionUsage.promptTokens + this.correctionUsage.completionTokens} tokens`, tx);
        this.balanceAfterCorrection = charge.newBalance;
        }
        if (this.preparedStoryCharge) {
          const story = this.preparedStoryCharge;
          this.storyBalance = story.cost > 0 ? (await deductCredits(this.args.userId, story.cost, this.trackNarrativeUsage(),
            `${story.model} — ${story.tokens} tokens`, tx)).newBalance : this.balanceAfterCorrection;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "INSUFFICIENT_CREDITS") {
          this.audit.diagnostics.push("insufficient_credits");
          throw Object.assign(new StateGuardError("insufficient_credits"), { message: notEnoughMushiesMessage("state-update-guard") });
        }
        throw error;
      }
    }
    if (this.args.signal.aborted) throw new StateGuardError("cancelled");
    this.audit.committed = true;
    if (this.enabled) await tx.update(messages).set({ stateValidation: this.audit }).where(eq(messages.id, this.args.targetId));
  }
  markCommitted(): void { this.committed = true; }
  async finish(signal: AbortSignal): Promise<void> {
    if (!this.enabled || !this.targetHash) return;
    if (!this.committed) {
      this.audit.committed = false;
      if (this.failedDraft) this.audit.originalRaw = this.failedDraft;
      if (this.audit.outcome !== "stale") this.audit.outcome = signal.aborted ? "cancelled" : "failed";
      this.audit.finishedAt = new Date().toISOString();
      this.audit.elapsedMs = Date.now() - this.args.startedAt;
      await this.progress();
    }
    // Aggregate only: never send raw stories, batches, state or API keys.
    captureServerEvent(this.args.userId, "state_validation_result", {
      outcome: this.audit.outcome, path: this.audit.path,
      initial_outcome: this.audit.initialOutcome, diagnostics: this.audit.diagnostics,
      parsed_count: this.audit.parsedCount, applied_count: this.audit.appliedCount,
      correction_count: this.audit.correctionCount, locally_repaired: this.audit.repaired,
      elapsed_ms: Date.now() - this.args.startedAt, model: this.audit.model,
      api_key_tier: this.audit.apiKeyTier,
    });
  }
}
