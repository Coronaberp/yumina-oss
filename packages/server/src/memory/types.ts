/** Source contracts pinned by source-manifest.json. Adapter fields stay outside core rows. */
export const SOURCE_PARITY_VERSION = "d2e2f96236bbc95512719204126395bd87561302";
export const FACT_TYPES = [
  "event",
  "state",
  "relationship",
  "world",
  "profile",
  "promise",
  "conflict",
  "injury",
  "illness",
  "inventory",
  "equipment",
  "mood",
] as const;
export type FactType = (typeof FACT_TYPES)[number];
export interface FactDraft {
  text: string;
  fact_type: FactType;
  participants: string[];
  importance: number;
  valence: number;
}
export interface CharStateDraft {
  doing: string;
  location: string;
  npcs: string[];
}
export interface ReconcileDecision {
  index: number;
  action: "add" | "reinforce" | "supersede";
  target_id?: string | null;
}
export interface LoreUpdateDecision {
  index: number;
  lore_id: string;
  new_content: string;
}
export interface SecretRevealDecision {
  index: number;
  secret_id: string;
}
export interface MemoryFact extends FactDraft {
  id: string;
  session_id: string;
  char_id: string | null;
  reinforcements: number;
  valid_from_turn: number;
  valid_until_turn: number | null;
  last_turn: number;
  created_ts: number;
  expired_ts: number | null;
  superseded_by: string | null;
  pinned: boolean;
  location: string | null;
  batch_id: string | null;
  distance?: number;
  source?: string;
  demoted?: boolean;
  metadata?: Record<string, unknown>;
  links?: unknown[];
  link_label?: string;
  embedding?: number[] | null;
}
export interface MemoryCluster {
  id: string;
  session_id: string;
  title: string;
  summary_text: string;
  created_turn: number;
  source_batch_ids: string[];
  created_at: number;
  distance?: number;
  [key: string]: unknown;
}
export interface LoreEntry {
  id: string;
  char_id?: string | null;
  name: string;
  content: string;
  category?: string;
  keywords?: string[];
  always_active?: boolean;
  metadata?: Record<string, unknown>;
  links?: unknown[];
  secrets?: unknown[];
  [key: string]: unknown;
}
export interface TranscriptMessage {
  id?: string;
  role: string;
  content: string;
  sourceVersion?: string;
  selectedAnswerId?: string;
  [key: string]: unknown;
}
export interface EmbeddingProfile {
  inheritedFrom?: string;
  adminDefaultUpdateAvailable?: boolean;
  id: string;
  userId: string;
  schemaName: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  sendDimensions: boolean;
  status: "pending" | "ready" | "failed";
  revision: number;
  active: boolean;
  errorCode?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
export interface MemoryScope {
  profileId: string;
  schemaName: string;
  ownerUserId: string;
  sessionId: string;
  charId: string | null;
}
export interface MemoryDatabase {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  transaction<T>(work: (tx: MemoryDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export interface MemoryModel {
  complete(prompt: string, options?: { signal?: AbortSignal }): Promise<string>;
}
export interface EmbeddingClient {
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
}
export interface TurnMemoryContext {
  ownerUserId: string;
  actingUserId: string;
  sessionId: string;
  worldId: string;
  mode: string;
  epoch: number;
  sourceHash: string;
  cutoffMessageId: string | null;
  query: string;
  messages: TranscriptMessage[];
  charName: string;
  userName: string;
  language: string;
  castNames: string[];
  canonicalLocation: string;
  loreEntries: LoreEntry[];
}
export interface MemoryResult {
  block: string;
  usedIds: string[];
  droppedIds: string[];
  loreLines: string[];
  memoryLines: string[];
  profileId: string;
  epoch: number;
  sourceHash: string;
  status: "ready" | "pending" | "unconfigured" | "failed";
  errorCode?: string;
}
