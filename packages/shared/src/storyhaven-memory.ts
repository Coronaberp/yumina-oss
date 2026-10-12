export interface StoryhavenEmbeddingProfile {
  configurationSource?: "admin" | "user";
  adminDefaultUpdateAvailable?: boolean;
  id: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  sendDimensions: boolean;
  status: "pending" | "ready" | "failed";
  revision: number;
  active: boolean;
  hasKey: boolean;
  errorCode: string | null;
}
export interface StoryhavenProfileInput {
  baseUrl: string;
  model: string;
  dimensions: number;
  sendDimensions: boolean;
  apiKey?: string;
}
export interface StoryhavenFact {
  id: string;
  text: string;
  fact_type: string;
  participants: string[];
  importance: number;
  valence: number;
  reinforcements: number;
  valid_from_turn: number;
  valid_until_turn: number | null;
  last_turn: number;
  pinned: boolean;
  location: string | null;
  superseded_by: string | null;
  expired_ts: number | null;
}
export interface StoryhavenMemoryStatus {
  backend: "legacy" | "storyhaven";
  profile: StoryhavenEmbeddingProfile | null;
  epoch: number;
  frontier: number;
  status: string;
  errorCode: string | null;
  settings: Record<string, number | boolean | string>;
  memoryBudgetTokensInherited?: boolean;
  facts: StoryhavenFact[];
  clusters: Array<Record<string, unknown>>;
  lore: Array<Record<string, unknown>>;
  overrides: Array<Record<string, unknown>>;
  reveals: Array<Record<string, unknown>>;
}
