import { and, eq, sql } from "drizzle-orm";
import type { WorldDefinition } from "@yumina/engine";
import { db } from "../../db/index.js";
import { agentRuns, worlds } from "../../db/schema.js";
import { executeGenerateNames, NAME_STYLES } from "./name-generator.js";
import { assertNameInputsAuthored } from "./name-authorship.js";
import type { ChatMessage } from "../llm/types.js";

type NameBatch = ReturnType<typeof executeGenerateNames>;
function batches(context: Record<string, unknown> | null): Record<string, NameBatch> {
  const value = context?.nameGenerationBatches;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, NameBatch>;
}

function cardNames(world: WorldDefinition): string[] {
  const names = (world.entries ?? []).map(entry => entry.name);
  return names.flatMap(name => [name, name.replace(/\s*\([^)]*\)/g, "").trim(),
    ...Array.from(name.matchAll(/\(([^)]+)\)/g), match => match[1]!) ]).filter(Boolean);
}

export async function readStudioGeneratedNames(worldId: string): Promise<string[]> {
  const history = await db.select({ batches: sql<Record<string, NameBatch> | null>`${agentRuns.context}->'nameGenerationBatches'` }).from(agentRuns).where(eq(agentRuns.worldId, worldId));
  return history.flatMap(item => Object.values(item.batches ?? {}).flatMap(batch => batch.names ?? []));
}

/** Lock per card so concurrent requests reserve different names. Replaying a
 * tool call returns its recorded batch instead of consuming new names. The
 * existing agent-run context stores the ledger; authored card data is untouched. */
export async function executeStudioGenerateNames(params: {
  worldId: string; runId: string; userId: string; toolCallId: string; input: Record<string, unknown>; world: WorldDefinition; messages?: readonly ChatMessage[];
}): Promise<NameBatch> {
  return db.transaction(async tx => {
    const [card] = await tx.select({ id: worlds.id, schema: worlds.schema }).from(worlds).where(and(eq(worlds.id, params.worldId), eq(worlds.creatorId, params.userId))).for("update");
    if (!card) throw new Error("Naming requires an owned card.");
    const [run] = await tx.select({ context: agentRuns.context }).from(agentRuns).where(and(eq(agentRuns.id, params.runId), eq(agentRuns.worldId, params.worldId), eq(agentRuns.userId, params.userId))).for("update");
    if (!run) throw new Error("Naming run not found.");
    const current = batches(run.context);
    if (Object.hasOwn(current, params.toolCallId)) return current[params.toolCallId]!;
    const history = await tx.select({ batches: sql<Record<string, NameBatch> | null>`${agentRuns.context}->'nameGenerationBatches'` }).from(agentRuns).where(eq(agentRuns.worldId, params.worldId));
    const reserved = history.flatMap(item => Object.values(item.batches ?? {}).flatMap(batch => batch.names ?? []));
    const authored = card.schema as unknown as WorldDefinition;
    const profiles = authored.settings?.nameGeneratorProfiles ?? [];
    assertNameInputsAuthored(params.input, params.messages ?? [], profiles);
    const result = executeGenerateNames({ ...params.input, seed: params.input.seed ?? `${params.runId}:${params.toolCallId}` },
      [...cardNames(authored), ...cardNames(params.world), ...reserved], profiles);
    await tx.update(agentRuns).set({ context: { ...run.context, nameGenerationBatches: { ...current, [params.toolCallId]: result } }, updatedAt: new Date() })
      .where(eq(agentRuns.id, params.runId));
    return result;
  });
}

export function listNameProfiles(world: WorldDefinition) {
  return { styles: Object.values(NAME_STYLES).map(style => ({ id: style.key, description: style.description })),
    profiles: world.settings.nameGeneratorProfiles ?? [],
    help: "Profiles live in settings.nameGeneratorProfiles. Use read_entities(['settings']) before update_settings({nameGeneratorProfiles:[...]}) to preserve existing profiles. Choose profileId with generate_names. Configure format (given/surname/full), order, style/surnameStyle, constraints and creator-authored phonetics. All name construction, pronunciation and similarity checks run locally in TypeScript. No LLM or external service generates names.",
  };
}
