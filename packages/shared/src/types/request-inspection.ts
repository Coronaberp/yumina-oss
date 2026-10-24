/** Dedicated private inspection endpoint DTOs. Never include in generic session data. */
export interface RequestSnapshot {
  provider: string;
  model: string;
  parameters: Record<string, unknown>;
  sections: Array<{ name: string; text: string }>;
  estimatedTextTokens: number;
  truncated: boolean;
}
export interface RequestReceipt {
  id: string;
  kind: "send" | "regenerate" | "continue";
  capturedAt: string;
  attempts: RequestSnapshot[];
  omittedAttempts: number;
  /** Provider-reported usage for the final reply, never an estimate or retry total. */
  usage?: ReportedRequestUsage;
}
export interface ReportedRequestUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
