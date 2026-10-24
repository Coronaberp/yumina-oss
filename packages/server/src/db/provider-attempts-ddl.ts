/** Provider receipts are observations, separate from accepted turns and billing. */
export const PROVIDER_ATTEMPTS_DDL = [
  `CREATE TABLE IF NOT EXISTS provider_attempts (
    id TEXT PRIMARY KEY,
    invocation_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    profile_id TEXT,
    provider_host TEXT NOT NULL,
    model TEXT NOT NULL,
    conversation_id TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('complete', 'error', 'cancelled')),
    http_status INTEGER,
    provider_request_id TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    reasoning_tokens INTEGER,
    provider_cost_usd NUMERIC(24,12),
    stop_reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS provider_attempts_user_started_idx ON provider_attempts(user_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS provider_attempts_invocation_idx ON provider_attempts(invocation_id)`,
];
