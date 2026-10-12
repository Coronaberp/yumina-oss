/** Triggers put invalidations in the same app transaction as every history mutation. */
export const MEMORY_APP_DDL = [
  `CREATE TABLE IF NOT EXISTS storyhaven_memory_accounts(user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,enabled_at TIMESTAMP NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS storyhaven_memory_sessions (
    session_id TEXT PRIMARY KEY REFERENCES play_sessions(id) ON DELETE CASCADE,
    backend TEXT CHECK (backend IN ('legacy','storyhaven')), epoch BIGINT NOT NULL DEFAULT 0, version BIGINT NOT NULL DEFAULT 0,source_hash TEXT,
    frontier INTEGER NOT NULL DEFAULT 0, settings JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'idle', error_code TEXT, updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  )`,
  `ALTER TABLE storyhaven_memory_sessions ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE storyhaven_memory_sessions ADD COLUMN IF NOT EXISTS source_hash TEXT`,
  `ALTER TABLE storyhaven_memory_sessions ADD COLUMN IF NOT EXISTS reset_epoch BIGINT NOT NULL DEFAULT 0`,
  `INSERT INTO storyhaven_memory_sessions(session_id,backend) SELECT id,'legacy' FROM play_sessions ON CONFLICT DO NOTHING`,
  `CREATE OR REPLACE FUNCTION storyhaven_memory_session_created() RETURNS TRIGGER AS $$ BEGIN
    INSERT INTO storyhaven_memory_sessions(session_id,backend) VALUES(NEW.id,CASE WHEN EXISTS(SELECT 1 FROM storyhaven_memory_accounts WHERE user_id=NEW.user_id) THEN 'storyhaven' ELSE 'legacy' END) ON CONFLICT DO NOTHING;
    RETURN NULL;
  END; $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS storyhaven_memory_session_created ON play_sessions`,
  `CREATE TRIGGER storyhaven_memory_session_created AFTER INSERT ON play_sessions FOR EACH ROW EXECUTE FUNCTION storyhaven_memory_session_created()`,
  `CREATE TABLE IF NOT EXISTS storyhaven_memory_outbox (
    id BIGSERIAL PRIMARY KEY, owner_user_id TEXT NOT NULL, session_id TEXT NOT NULL,
    kind TEXT NOT NULL, epoch BIGINT NOT NULL, payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(), delivered_at TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS storyhaven_memory_outbox_pending ON storyhaven_memory_outbox(id) WHERE delivered_at IS NULL`,
  `CREATE OR REPLACE FUNCTION storyhaven_memory_message_changed() RETURNS TRIGGER AS $$
  DECLARE sid TEXT; uid TEXT; history_epoch BIGINT; action TEXT;
  BEGIN
    IF TG_OP = 'DELETE' THEN sid := OLD.session_id; ELSE sid := NEW.session_id; END IF;
    SELECT user_id INTO uid FROM play_sessions WHERE id = sid;
    IF uid IS NULL THEN RETURN NULL; END IF;
    INSERT INTO storyhaven_memory_sessions(session_id) VALUES(sid) ON CONFLICT DO NOTHING;
    -- Usage receipts do not alter the story. In particular, saving a receipt
    -- on an appended reply must not cancel an older settled extraction.
    IF TG_OP = 'UPDATE' AND OLD.content IS NOT DISTINCT FROM NEW.content AND OLD.role IS NOT DISTINCT FROM NEW.role AND ((OLD.swipes->COALESCE(OLD.active_swipe_index,0)) - 'contentFlags' - 'creditCost' - 'creditBalanceAfter') IS NOT DISTINCT FROM ((NEW.swipes->COALESCE(NEW.active_swipe_index,0)) - 'contentFlags' - 'creditCost' - 'creditBalanceAfter') THEN RETURN NULL; END IF;
    UPDATE storyhaven_memory_sessions SET epoch=epoch+CASE WHEN TG_OP='INSERT' THEN 0 ELSE 1 END,frontier=CASE WHEN TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM messages WHERE session_id=sid) THEN 0 ELSE frontier END,version=version+1, updated_at=NOW() WHERE session_id=sid RETURNING epoch INTO history_epoch;
    IF TG_OP = 'INSERT' THEN action := 'append'; ELSE action := 'invalidate'; END IF;
    INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch,payload)
      VALUES(uid,sid,action,history_epoch,jsonb_build_object('operation',TG_OP,'messageId',COALESCE(NEW.id,OLD.id)));
    RETURN NULL;
  END; $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS storyhaven_memory_history_changed ON messages`,
  `CREATE TRIGGER storyhaven_memory_history_changed AFTER INSERT OR DELETE OR UPDATE OF content, role,swipes,active_swipe_index ON messages FOR EACH ROW EXECUTE FUNCTION storyhaven_memory_message_changed()`,
  `CREATE OR REPLACE FUNCTION storyhaven_memory_session_deleted() RETURNS TRIGGER AS $$
  BEGIN
    INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch)
    VALUES(OLD.user_id,OLD.id,'purge',COALESCE((SELECT epoch+1 FROM storyhaven_memory_sessions WHERE session_id=OLD.id),1));
    RETURN OLD;
  END; $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS storyhaven_memory_session_deleted ON play_sessions`,
  `CREATE TRIGGER storyhaven_memory_session_deleted BEFORE DELETE ON play_sessions FOR EACH ROW EXECUTE FUNCTION storyhaven_memory_session_deleted()`,
  `CREATE OR REPLACE FUNCTION storyhaven_memory_world_changed() RETURNS TRIGGER AS $$
  BEGIN
    IF (OLD.schema - 'rootComponent') IS NOT DISTINCT FROM (NEW.schema - 'rootComponent') AND OLD.status IS NOT DISTINCT FROM NEW.status AND OLD.creator_id IS NOT DISTINCT FROM NEW.creator_id THEN RETURN NULL; END IF;
    INSERT INTO storyhaven_memory_sessions(session_id) SELECT id FROM play_sessions WHERE world_id=NEW.id ON CONFLICT DO NOTHING;
    UPDATE storyhaven_memory_sessions SET epoch=epoch+1,updated_at=NOW() WHERE session_id IN (SELECT id FROM play_sessions WHERE world_id=NEW.id);
    INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch)
      SELECT s.user_id,s.id,'invalidate',m.epoch FROM play_sessions s JOIN storyhaven_memory_sessions m ON m.session_id=s.id WHERE s.world_id=NEW.id;
    RETURN NULL;
  END; $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS storyhaven_memory_world_changed ON worlds`,
  `CREATE TRIGGER storyhaven_memory_world_changed AFTER UPDATE OF schema,status,creator_id ON worlds FOR EACH ROW EXECUTE FUNCTION storyhaven_memory_world_changed()`,
  `CREATE OR REPLACE FUNCTION storyhaven_memory_pending_world_changed() RETURNS TRIGGER AS $$
  DECLARE world_ids TEXT[];
  BEGIN
    IF TG_OP='UPDATE' AND (OLD.schema - 'rootComponent') IS NOT DISTINCT FROM (NEW.schema - 'rootComponent') AND OLD.world_id IS NOT DISTINCT FROM NEW.world_id THEN RETURN NULL; END IF;
    IF TG_OP='DELETE' THEN world_ids:=ARRAY[OLD.world_id];
    ELSIF TG_OP='UPDATE' THEN world_ids:=ARRAY[OLD.world_id,NEW.world_id];
    ELSE world_ids:=ARRAY[NEW.world_id]; END IF;
    -- Serialize against branch creation before enumerating sessions, including a
    -- creator acting in a group session owned by another player.
    PERFORM id FROM worlds WHERE id=ANY(world_ids) ORDER BY id FOR UPDATE;
    INSERT INTO storyhaven_memory_sessions(session_id) SELECT id FROM play_sessions WHERE world_id=ANY(world_ids) ON CONFLICT DO NOTHING;
    UPDATE storyhaven_memory_sessions SET epoch=epoch+1,updated_at=NOW() WHERE session_id IN (SELECT id FROM play_sessions WHERE world_id=ANY(world_ids));
    INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch)
      SELECT s.user_id,s.id,'invalidate',m.epoch FROM play_sessions s JOIN storyhaven_memory_sessions m ON m.session_id=s.id WHERE s.world_id=ANY(world_ids);
    RETURN NULL;
  END; $$ LANGUAGE plpgsql`,
  `DO $$ BEGIN IF to_regclass('public.world_pending_edits') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS storyhaven_memory_pending_world_changed ON world_pending_edits;
    CREATE TRIGGER storyhaven_memory_pending_world_changed AFTER INSERT OR DELETE OR UPDATE OF schema,world_id ON world_pending_edits FOR EACH ROW EXECUTE FUNCTION storyhaven_memory_pending_world_changed();
  END IF; END; $$`,
  `CREATE OR REPLACE FUNCTION storyhaven_memory_owner_deleted() RETURNS TRIGGER AS $$ BEGIN
    INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch) VALUES(OLD.id,'owner:'||OLD.id,'purge-owner',0);
    RETURN OLD;
  END; $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS storyhaven_memory_owner_deleted ON "user"`,
  `CREATE TRIGGER storyhaven_memory_owner_deleted BEFORE DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION storyhaven_memory_owner_deleted()`,
  `CREATE OR REPLACE FUNCTION storyhaven_memory_world_deleted() RETURNS TRIGGER AS $$ BEGIN
    INSERT INTO storyhaven_memory_outbox(owner_user_id,session_id,kind,epoch,payload)
      SELECT user_id,'world:'||OLD.id,'purge-world',0,jsonb_build_object('worldId',OLD.id)
      FROM (SELECT DISTINCT user_id FROM play_sessions WHERE world_id=OLD.id UNION SELECT OLD.creator_id) owners;
    RETURN OLD;
  END; $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS storyhaven_memory_world_deleted ON worlds`,
  `CREATE TRIGGER storyhaven_memory_world_deleted BEFORE DELETE ON worlds FOR EACH ROW EXECUTE FUNCTION storyhaven_memory_world_deleted()`,
];
