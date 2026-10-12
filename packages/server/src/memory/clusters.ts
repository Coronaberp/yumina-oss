import { CLUSTER_TRIGGER_COUNT } from "./config.js";
import { ModelValidation, loadJson } from "./extraction.js";
import { buildClusterPrompt, buildClusterAssignPrompt } from "./prompts.js";
import { PythonFloat } from "./python-json.js";
import { pythonTruthy } from "./block.js";
import type { EmbeddingClient, MemoryFact, MemoryModel } from "./types.js";
import type { CoreCluster } from "./ranking.js";
import type { MemoryRepositories } from "./repositories/index.js";
export { buildClusterPrompt, buildClusterAssignPrompt };
export type ClusterFact = Pick<
  MemoryFact,
  "id" | "text" | "last_turn" | "batch_id"
>;
export interface ClusterAssignment {
  id: string | null;
  title: string | null;
  summary: string;
  fact_indices: number[];
}
export interface ClusterServiceDependencies {
  repositories: MemoryRepositories;
  model: MemoryModel;
  embedding: EmbeddingClient;
  triggerCount?: number;
  signal?: AbortSignal;
}
export interface PreparedCluster {
  summary: string;
  createdTurn: number;
  batchIds: string[];
}
export interface PreparedClusterAssignment extends PreparedCluster {
  id: string | null;
  title: string;
  factIds: string[];
  vector?: number[];
}
function validateAssignment(data: unknown): ClusterAssignment {
  const v = new ModelValidation("ClusterAssignment", data),
    d = v.object();
  const id = v.field(d, "id", null),
    title = v.field(d, "title", null);
  const result = {
    id: id === null ? null : v.string(id, "id"),
    title: title === null ? null : v.string(title, "title"),
    summary: v.string(v.field(d, "summary"), "summary", 1),
    fact_indices: v.list(
      v.field(d, "fact_indices"),
      "fact_indices",
      (x, l) => v.integer(x, l),
      1,
    ) as number[],
  };
  if (!v.issues.length && !result.id && !result.title)
    v.issue(
      "",
      "Value error, assignment requires either id (existing cluster) or title (new cluster)",
      "value_error",
      data,
    );
  v.finish();
  return result;
}
/** Preserve actual source validation: duplicate/unassigned indexes are accepted. */
export function parseClusterAssignments(
  raw: string,
  factCount: number,
  validIds: Set<string>,
): ClusterAssignment[] {
  let data: unknown;
  try {
    data = loadJson(raw);
  } catch (error) {
    throw new Error(`not valid JSON: ${(error as Error).message}`);
  }
  if (
    data === null ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data instanceof PythonFloat
  )
    throw new Error("expected a JSON object with clusters");
  const clusters = (data as Record<string, unknown>).clusters;
  const items = pythonTruthy(
    clusters instanceof PythonFloat ? clusters.value : clusters,
  )
    ? clusters
    : [];
  const iterable = Array.isArray(items)
    ? items
    : typeof items === "string"
      ? Array.from(items)
      : items !== null &&
          typeof items === "object" &&
          !(items instanceof PythonFloat)
        ? Object.keys(items)
        : null;
  if (iterable === null) throw new TypeError("clusters is not iterable");
  const assignments = iterable.map(validateAssignment);
  for (const assignment of assignments) {
    if (assignment.id && !validIds.has(assignment.id))
      throw new Error(`unknown cluster id ${assignment.id}`);
    for (const idx of assignment.fact_indices)
      if (idx < 0 || idx >= factCount)
        throw new Error(
          `fact index ${idx} out of range for ${factCount} facts`,
        );
  }
  return assignments;
}
export async function runClusterAssign(
  existing: CoreCluster[],
  facts: { text: string }[],
  model: MemoryModel,
  signal?: AbortSignal,
): Promise<ClusterAssignment[]> {
  if (!facts.length) return [];
  const prompt = buildClusterAssignPrompt(existing, facts),
    validIds = new Set(existing.map((c) => c.id));
  try {
    let raw = (await model.complete(prompt, { signal })).trim();
    try {
      return parseClusterAssignments(raw, facts.length, validIds);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      raw = (
        await model.complete(
          `${prompt}\n\nYour previous reply was invalid: ${(error as Error).message}\nReply again with only the corrected JSON.`,
          { signal },
        )
      ).trim();
      return parseClusterAssignments(raw, facts.length, validIds);
    }
  } catch {
    return [
      {
        id: null,
        title: "Untitled thread",
        summary: facts.map((f) => f.text).join(" "),
        fact_indices: facts.map((_, i) => i),
      },
    ];
  }
}
export function pythonSortedStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => {
    const x = Array.from(a),
      y = Array.from(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
      if (d) return d;
    }
    return x.length - y.length;
  });
}
export function createClusterService(deps: ClusterServiceDependencies) {
  const { repositories, model, embedding, signal } = deps;
  async function prepareCluster(
    facts: Pick<MemoryFact, "text" | "last_turn">[],
    batchIds: string[],
    previousSummary?: string | null,
  ): Promise<PreparedCluster> {
    let summary: string;
    try {
      summary = (
        await model.complete(buildClusterPrompt(facts, previousSummary), {
          signal,
        })
      ).trim();
    } catch {
      const fallback = facts.map((f) => f.text).join(" ");
      summary = previousSummary ? `${previousSummary} ${fallback}` : fallback;
    }
    return {
      summary,
      createdTurn: Math.max(0, ...facts.map((f) => f.last_turn)),
      batchIds,
    };
  }
  async function commitCluster(
    prepared: PreparedCluster,
    repos = repositories,
  ) {
    return repos.clusters.insert(
      prepared.summary,
      prepared.createdTurn,
      prepared.batchIds,
      "",
      undefined,
    );
  }
  async function prepareAssignments(
    facts: ClusterFact[],
  ): Promise<PreparedClusterAssignment[]> {
    if (!facts.length) return [];
    const existing = await repositories.clusters.activeForSession(),
      existingIds = new Set(existing.map((c) => c.id));
    const assignments = await runClusterAssign(existing, facts, model, signal),
      prepared: PreparedClusterAssignment[] = [];
    for (const assignment of assignments) {
      const assigned = assignment.fact_indices
        .filter((i) => i >= 0 && i < facts.length)
        .map((i) => facts[i]!);
      if (!assigned.length) continue;
      let vector: number[] | undefined;
      try {
        vector = await embedding.embed(assignment.summary, signal);
      } catch {}
      prepared.push({
        id:
          assignment.id && existingIds.has(assignment.id)
            ? assignment.id
            : null,
        title: assignment.title || "",
        summary: assignment.summary,
        createdTurn: Math.max(0, ...assigned.map((f) => f.last_turn)),
        batchIds: pythonSortedStrings(
          assigned.flatMap((f) => (f.batch_id ? [f.batch_id] : [])),
        ),
        factIds: assigned.map((f) => f.id),
        vector,
      });
    }
    return prepared;
  }
  async function commitAssignments(
    prepared: PreparedClusterAssignment[],
    repos = repositories,
  ) {
    for (const p of prepared) {
      let id = p.id;
      if (id)
        await repos.clusters.updateCluster(
          id,
          p.summary,
          p.createdTurn,
          p.batchIds,
          p.vector,
        );
      else
        id = await repos.clusters.insert(
          p.summary,
          p.createdTurn,
          p.batchIds,
          p.title,
          p.vector,
        );
      await repos.clusters.addMembers(id, p.factIds);
    }
    return prepared.length;
  }
  return {
    prepareCluster,
    commitCluster,
    prepareAssignments,
    commitAssignments,
    shouldBuildCluster: async (sinceBatchId: string | null) =>
      (await repositories.facts.countUnclusteredSince(sinceBatchId)) >=
      (deps.triggerCount ?? CLUSTER_TRIGGER_COUNT),
    shouldBuildClusterMulti: async () => {
      const facts = await repositories.clusters.unclusteredFacts();
      return facts.length >= (deps.triggerCount ?? CLUSTER_TRIGGER_COUNT)
        ? facts
        : [];
    },
    buildCluster: async (
      facts: Pick<MemoryFact, "text" | "last_turn">[],
      batchIds: string[],
      previousSummary?: string | null,
    ) => commitCluster(await prepareCluster(facts, batchIds, previousSummary)),
    assignAndBuildClusters: async (facts: ClusterFact[]) =>
      commitAssignments(await prepareAssignments(facts)),
  };
}
