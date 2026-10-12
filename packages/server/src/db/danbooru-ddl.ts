/** Shared by PGlite bootstrap and the PostgreSQL self-heal migration. */
export const DANBOORU_DDL = [
  `CREATE TABLE IF NOT EXISTS user_danbooru_settings (
    user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    username TEXT NOT NULL DEFAULT '',
    encrypted_key TEXT, key_iv TEXT, key_tag TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK ((encrypted_key IS NULL AND key_iv IS NULL AND key_tag IS NULL) OR
      (encrypted_key IS NOT NULL AND key_iv IS NOT NULL AND key_tag IS NOT NULL)),
    CHECK ((username = '') = (encrypted_key IS NULL))
  );`,
  `CREATE TABLE IF NOT EXISTS danbooru_asset_sources (
    asset_id TEXT PRIMARY KEY REFERENCES user_assets(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    post_id BIGINT NOT NULL CHECK (post_id > 0),
    metadata JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  );`,
  `CREATE INDEX IF NOT EXISTS danbooru_asset_sources_user_idx ON danbooru_asset_sources(user_id);`,
] as const;
