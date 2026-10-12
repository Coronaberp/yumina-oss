/** Verbatim defaults from the pinned StoryHaven memory/config.py. */
export const BATCH_SIZE = 5;
export const SETTLE_MARGIN_EXCHANGES = 1;
export const CATCHUP_MIN_PAIRS = 15;
export const SESSION_NEIGHBOR_K = 8;
export const SESSION_CANDIDATE_K = 32;
export const LOCATION_SCOPED_STATEFUL_TYPES = new Set<string>(["state"]);
export const UNSCOPED_STATEFUL_TYPES = new Set<string>(["conflict", "illness", "profile", "promise"]);
export const INJURY_HEAL_TURNS = 30;
export const EQUIPMENT_BOOST = 0.5;
export const MOOD_STRENGTH_BASE = 80.0;
export const MOOD_RECENCY_SCALE_TURNS = 400.0;
export const STRENGTH_BASE = 40.0;
export const STRENGTH_PER_REINFORCEMENT = 15.0;
export const STRENGTH_PER_IMPORTANCE = 10.0;
export const STRENGTH_PER_VALENCE = 8.0;
export const RETENTION_FLOOR = 0.05;
export const RECENCY_SCALE_TURNS = 200.0;
export const RELEVANCE_WEIGHT = 1.0;
export const RECENCY_WEIGHT = 0.6;
export const IMPORTANCE_WEIGHT = 0.4;
export const LOCATION_MATCH_WEIGHT = 0.5;
export const ACTIVE_STATE_IMPORTANCE_FLOOR = 3;
export const MAX_ACTIVE_RESERVED_FACTS = 12;
export const PARTICIPANT_ABSENCE_PENALTY = 0.5;
export const RESERVED_FRACTION = 0.6;
export const FACT_TYPES = ["event", "state", "relationship", "world", "profile", "promise", "conflict", "injury", "illness", "inventory", "equipment", "mood"] as const;
export const MAX_FACTS_PER_BATCH = 10;
export const LORE_NEIGHBOR_K = 3;
export const LORE_CANDIDATE_K = 32;
export const MAX_PINNED_LORE_CHUNKS = 12;
export const CLUSTER_TRIGGER_COUNT = 8;
export const CLUSTER_BUDGET_TOKENS = 150;
export const CLUSTER_MULTI_THREAD = false;
export const CLUSTER_MAX_SUMMARIES = 2;
/** The thirteen global settings editable by the pinned source admin API. */
export interface MemoryAlgorithmConfig {
 batchSize?:number; settleMarginExchanges?:number; sessionNeighborK?:number; sessionCandidateK?:number;
 maxFactsPerBatch?:number; loreNeighborK?:number; loreCandidateK?:number; maxPinnedLoreChunks?:number;
 clusterTriggerCount?:number; clusterBudgetTokens?:number; reservedFraction?:number;
 clusterMultiThread?:boolean; clusterMaxSummaries?:number;
}
export const MEMORY_TUNABLE_BOUNDS = {
 batchSize:[1,20],settleMarginExchanges:[0,10],sessionNeighborK:[1,50],sessionCandidateK:[1,100],
 maxFactsPerBatch:[1,50],loreNeighborK:[1,20],loreCandidateK:[1,100],maxPinnedLoreChunks:[1,50],
 clusterTriggerCount:[1,50],clusterBudgetTokens:[10,2000],reservedFraction:[0,1],clusterMaxSummaries:[1,10],
} as const;
export const DEFAULT_MEMORY_CONFIG = { BATCH_SIZE, SETTLE_MARGIN_EXCHANGES, CATCHUP_MIN_PAIRS, SESSION_NEIGHBOR_K, SESSION_CANDIDATE_K, LOCATION_SCOPED_STATEFUL_TYPES, UNSCOPED_STATEFUL_TYPES, INJURY_HEAL_TURNS, EQUIPMENT_BOOST, MOOD_STRENGTH_BASE, MOOD_RECENCY_SCALE_TURNS, STRENGTH_BASE, STRENGTH_PER_REINFORCEMENT, STRENGTH_PER_IMPORTANCE, STRENGTH_PER_VALENCE, RETENTION_FLOOR, RECENCY_SCALE_TURNS, RELEVANCE_WEIGHT, RECENCY_WEIGHT, IMPORTANCE_WEIGHT, LOCATION_MATCH_WEIGHT, ACTIVE_STATE_IMPORTANCE_FLOOR, MAX_ACTIVE_RESERVED_FACTS, PARTICIPANT_ABSENCE_PENALTY, RESERVED_FRACTION, FACT_TYPES, MAX_FACTS_PER_BATCH, LORE_NEIGHBOR_K, LORE_CANDIDATE_K, MAX_PINNED_LORE_CHUNKS, CLUSTER_TRIGGER_COUNT, CLUSTER_BUDGET_TOKENS, CLUSTER_MULTI_THREAD, CLUSTER_MAX_SUMMARIES } as const;
