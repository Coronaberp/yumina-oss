/** Shared by PGlite bootstrap and PostgreSQL self-heal. */
export const IMAGE_GENERATION_DDL = [
  `CREATE TABLE IF NOT EXISTS user_image_generation_settings (
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('comfyui','forgeneo')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE, base_url TEXT NOT NULL, workflow TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
    encrypted_key TEXT, key_iv TEXT, key_tag TEXT, updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,provider),
    CHECK ((encrypted_key IS NULL AND key_iv IS NULL AND key_tag IS NULL) OR (encrypted_key IS NOT NULL AND key_iv IS NOT NULL AND key_tag IS NOT NULL))
  );`,
  `CREATE TABLE IF NOT EXISTS user_image_generation_preferences (
    user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
    active_provider TEXT NOT NULL DEFAULT 'comfyui' CHECK (active_provider IN ('comfyui','forgeneo')),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  );`,
  `CREATE TABLE IF NOT EXISTS generated_image_sources (
    asset_id TEXT PRIMARY KEY REFERENCES user_assets(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('comfyui','openai','forgeneo','codex')), metadata JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
  );`,
  `CREATE TABLE IF NOT EXISTS image_generation_requests (
    user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','succeeded','failed')),
    asset_id TEXT REFERENCES user_assets(id) ON DELETE SET NULL, created_at TIMESTAMP NOT NULL DEFAULT NOW(), updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id,request_id)
  );`,
  `CREATE INDEX IF NOT EXISTS generated_image_sources_user_idx ON generated_image_sources(user_id);`,
  // Replace legacy OpenAI profiles and their encrypted keys; retain historical provenance rows.
  `ALTER TABLE user_image_generation_settings DROP CONSTRAINT IF EXISTS image_generation_provider_check;`,
  `ALTER TABLE user_image_generation_settings DROP CONSTRAINT IF EXISTS user_image_generation_settings_provider_check;`,
  `ALTER TABLE user_image_generation_preferences DROP CONSTRAINT IF EXISTS image_generation_active_provider_check;`,
  `ALTER TABLE user_image_generation_preferences DROP CONSTRAINT IF EXISTS user_image_generation_preferences_active_provider_check;`,
  `ALTER TABLE generated_image_sources DROP CONSTRAINT IF EXISTS generated_image_provider_check;`,
  `ALTER TABLE generated_image_sources DROP CONSTRAINT IF EXISTS generated_image_sources_provider_check;`,
  `DELETE FROM user_image_generation_settings WHERE provider='openai';`,
  `UPDATE user_image_generation_preferences SET active_provider='forgeneo',updated_at=NOW() WHERE active_provider='openai';`,
  `ALTER TABLE user_image_generation_settings ADD CONSTRAINT image_generation_provider_check CHECK (provider IN ('comfyui','forgeneo'));`,
  `ALTER TABLE user_image_generation_preferences ADD CONSTRAINT image_generation_active_provider_check CHECK (active_provider IN ('comfyui','forgeneo'));`,
  `ALTER TABLE generated_image_sources ADD CONSTRAINT generated_image_provider_check CHECK (provider IN ('comfyui','openai','forgeneo','codex'));`,
] as const;
