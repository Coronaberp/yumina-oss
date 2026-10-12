import type { MemoryDatabase, MemoryScope } from "../types.js";
import { RepositoryContext, type MemoryKey } from "./context.js";
import { FactsRepository } from "./facts.js";
import { VectorsRepository } from "./vectors.js";
import { LoreRepository } from "./lore.js";
import { ClustersRepository } from "./clusters.js";
export function createMemoryRepositories(
  db: MemoryDatabase,
  scope: MemoryScope,
  key: MemoryKey,
) {
  const context = new RepositoryContext(db, scope, key);
  const facts = new FactsRepository(context);
  return {
    facts,
    vectors: new VectorsRepository(context),
    lore: new LoreRepository(context),
    clusters: new ClustersRepository(context, facts),
  };
}
export type MemoryRepositories = ReturnType<typeof createMemoryRepositories>;
export type { InsertFact, MemoryBatch, RollbackResult } from "./facts.js";
export type {
  LoreInput,
  StoredLore,
  LoreChunk,
  LoreSecret,
  LoreState,
  LoreLink,
} from "./lore.js";
export type { StoredMemoryCluster } from "./clusters.js";
