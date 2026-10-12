import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { encryptApiKey, decryptApiKey } from '../crypto.js';
import { mediaRows } from '../session-media-service.js';
import { sessionMedia } from '../session-media.js';
import { DanbooruError, defaultDanbooruConfig, mergeDanbooruSettings, type DanbooruCredentials, type DanbooruRepository } from './danbooru.js';
type Row = { enabled: boolean; username: string; encrypted_key: string | null; key_iv: string | null; key_tag: string | null };
function decode(row?: Row): DanbooruCredentials {
  if (!row) return defaultDanbooruConfig();
  const apiKey = row.encrypted_key && row.key_iv && row.key_tag ? decryptApiKey(row.encrypted_key, row.key_iv, row.key_tag) : null;
  if (row.encrypted_key && !apiKey) throw new DanbooruError('CREDENTIALS_UNREADABLE', 'Saved Danbooru credentials could not be opened. Clear them and save a new API key.', 503);
  return { enabled: row.enabled, username: row.username, apiKey };
}
export const danbooruRepository: DanbooruRepository = {
  async get(userId) {
    const [row] = await mediaRows<Row>(db, sql`SELECT enabled,username,encrypted_key,key_iv,key_tag FROM user_danbooru_settings WHERE user_id=${userId}`);
    return decode(row);
  },
  async update(userId, input) {
    return db.transaction(async tx => {
      // Locks the user row even before the first settings row exists.
      await sessionMedia.lockOwner(tx, userId);
      const [row] = await mediaRows<Row>(tx, sql`SELECT enabled,username,encrypted_key,key_iv,key_tag FROM user_danbooru_settings WHERE user_id=${userId} FOR UPDATE`);
      // Explicit clear must also recover credentials encrypted with a lost key.
      const current = input.clearKey ? { enabled: row?.enabled ?? false, username: row?.username ?? '', apiKey: null } : decode(row);
      const config = mergeDanbooruSettings(current, input);
      const encrypted = config.apiKey ? encryptApiKey(config.apiKey) : null;
      await tx.execute(sql`INSERT INTO user_danbooru_settings(user_id,enabled,username,encrypted_key,key_iv,key_tag)
        VALUES(${userId},${config.enabled},${config.username},${encrypted?.encrypted ?? null},${encrypted?.iv ?? null},${encrypted?.tag ?? null})
        ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,username=excluded.username,
          encrypted_key=excluded.encrypted_key,key_iv=excluded.key_iv,key_tag=excluded.key_tag,updated_at=NOW()`);
      return config;
    });
  },
  async clear(userId) {
    await db.transaction(async tx => {
      await sessionMedia.lockOwner(tx, userId);
      await tx.execute(sql`DELETE FROM user_danbooru_settings WHERE user_id=${userId}`);
    });
  },
};
