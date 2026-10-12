/** PGlite bootstrap and explicit PostgreSQL migration share this definition. */
export const CUSTOM_UI_PRESETS_DDL = `CREATE TABLE IF NOT EXISTS user_custom_ui_presets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 50),
  entry_file TEXT NOT NULL,
  files JSONB NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);`;
