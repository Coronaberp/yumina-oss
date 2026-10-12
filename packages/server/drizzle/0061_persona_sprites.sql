-- Add optional player VN expression sprites to personal personas.
ALTER TABLE "user_personas"
  ADD COLUMN IF NOT EXISTS "sprites" jsonb NOT NULL DEFAULT '{}'::jsonb;
