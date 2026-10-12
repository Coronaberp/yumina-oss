import { CONTENT_FLAG_POLICY_ID } from "@yumina/shared";

/** Invalidate classification in the same transaction as every visible edit,
 * including writes from greetings, endings, branches and future route handlers. */
export const CONTENT_FLAGS_DDL = [
    `ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_flags JSONB`,
    `CREATE OR REPLACE FUNCTION messages_pending_content_flag() RETURNS JSONB
LANGUAGE SQL AS $$
  SELECT jsonb_build_object('version', 1, 'policyId', '${CONTENT_FLAG_POLICY_ID}',
    'classifier', 'kev', 'status', 'pending', 'label', 'nsfw',
    'routingSafe', false, 'threshold', 0.4, 'sourceHash', '',
    'startedAt', clock_timestamp());
$$`,
    `CREATE OR REPLACE FUNCTION messages_set_content_flags() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  result JSONB := '[]'::jsonb;
  variant JSONB;
  previous JSONB;
  i INTEGER := 0;
  selected INTEGER := COALESCE(NEW.active_swipe_index, 0);
BEGIN
  IF NEW.role NOT IN ('user', 'assistant') THEN RETURN NEW; END IF;
  IF NEW.role = 'assistant' AND jsonb_typeof(NEW.swipes) = 'array'
      AND jsonb_array_length(NEW.swipes) > 0 THEN
    FOR variant IN SELECT value FROM jsonb_array_elements(NEW.swipes) LOOP
      previous := CASE WHEN TG_OP = 'UPDATE' THEN OLD.swipes->i ELSE NULL END;
      IF TG_OP = 'INSERT' OR previous IS NULL
          OR (variant->'content') IS DISTINCT FROM (previous->'content')
          OR COALESCE(variant->'choices', '[]'::jsonb) IS DISTINCT FROM COALESCE(previous->'choices', '[]'::jsonb)
          OR (TG_OP = 'UPDATE' AND OLD.role IS DISTINCT FROM NEW.role)
          OR (TG_OP = 'UPDATE' AND selected = i AND COALESCE(OLD.active_swipe_index, 0) = selected
            AND OLD.content IS DISTINCT FROM NEW.content)
          OR variant->'contentFlags' IS NULL OR variant->'contentFlags' = 'null'::jsonb THEN
        variant := jsonb_set(variant, '{contentFlags}', messages_pending_content_flag());
      END IF;
      result := result || jsonb_build_array(variant);
      i := i + 1;
    END LOOP;
    NEW.swipes := result;
    NEW.content_flags := COALESCE(result->selected->'contentFlags', messages_pending_content_flag());
  ELSIF TG_OP = 'INSERT' OR OLD.content IS DISTINCT FROM NEW.content
      OR OLD.role IS DISTINCT FROM NEW.role OR NEW.content_flags IS NULL THEN
    NEW.content_flags := messages_pending_content_flag();
  END IF;
  IF NEW.role = 'assistant' AND NEW.status = 'failed' THEN
    NEW.content_flags := messages_pending_content_flag() || jsonb_build_object(
      'status', 'error', 'errorCode', 'incomplete_response', 'completedAt', clock_timestamp());
    IF jsonb_typeof(NEW.swipes) = 'array' AND NEW.swipes->selected IS NOT NULL THEN
      NEW.swipes := jsonb_set(NEW.swipes, ARRAY[selected::TEXT, 'contentFlags'], NEW.content_flags);
    END IF;
  ELSIF TG_OP = 'UPDATE' AND NEW.role = 'assistant' AND NEW.status = 'complete' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.content_flags := messages_pending_content_flag();
    IF jsonb_typeof(NEW.swipes) = 'array' AND NEW.swipes->selected IS NOT NULL THEN
      NEW.swipes := jsonb_set(NEW.swipes, ARRAY[selected::TEXT, 'contentFlags'], NEW.content_flags);
    END IF;
  END IF;
  RETURN NEW;
END;
$$`,
    `DROP TRIGGER IF EXISTS messages_content_flags_trg ON messages`,
    `CREATE TRIGGER messages_content_flags_trg BEFORE INSERT OR UPDATE OF content, role, status, swipes, active_swipe_index
ON messages FOR EACH ROW EXECUTE FUNCTION messages_set_content_flags()`,
    `CREATE INDEX IF NOT EXISTS messages_content_flags_pending_idx ON messages(created_at, id)
WHERE content_flags->>'status' = 'pending'`,
];
