import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { encryptApiKey, decryptApiKey } from '../crypto.js';
import { mediaRows } from '../session-media-service.js';
import { sessionMedia } from '../session-media.js';
import { defaultGenerationConfig, mergeGenerationSettings, type GenerationCredentials, type GenerationRepository, type ImageProvider } from './config.js';
type Row = { provider: ImageProvider; enabled: boolean; base_url: string; workflow: string; model: string; encrypted_key: string | null; key_iv: string | null; key_tag: string | null };
type Reader = Parameters<typeof mediaRows>[0];
async function load(tx: Reader, userId: string, recoverProvider?: ImageProvider): Promise<GenerationCredentials> {
  const state = defaultGenerationConfig();
  const rows = await mediaRows<Row>(tx, sql`SELECT provider,enabled,base_url,workflow,model,encrypted_key,key_iv,key_tag FROM user_image_generation_settings WHERE user_id=${userId}`);
  for (const row of rows) {
    if (!['comfyui', 'forgeneo'].includes(row.provider)) continue;
    const apiKey = row.encrypted_key && row.key_iv && row.key_tag && row.provider !== recoverProvider ? decryptApiKey(row.encrypted_key, row.key_iv, row.key_tag) : null;
    state.configs[row.provider] = { enabled: row.enabled, baseUrl: row.base_url, workflow: row.workflow, model: row.model, apiKey, keyUnreadable: !!row.encrypted_key && !apiKey && row.provider !== recoverProvider };
  }
  const [choice] = await mediaRows<{ active_provider: ImageProvider }>(tx, sql`SELECT active_provider FROM user_image_generation_preferences WHERE user_id=${userId}`);
  if (choice && ['comfyui', 'forgeneo'].includes(choice.active_provider)) state.activeProvider = choice.active_provider;
  return state;
}
export const imageGenerationRepository: GenerationRepository = {
  get: userId => load(db, userId),
  async update(userId, input) {
    return db.transaction(async tx => {
      await sessionMedia.lockOwner(tx, userId);
      const state = mergeGenerationSettings(await load(tx, userId, input.clearKey ? input.provider : undefined), input);
      const profile = state.configs[input.provider];
      const encrypted = profile.apiKey ? encryptApiKey(profile.apiKey) : null;
      await tx.execute(sql`INSERT INTO user_image_generation_settings(user_id,provider,enabled,base_url,workflow,model,encrypted_key,key_iv,key_tag)
        VALUES(${userId},${input.provider},${profile.enabled},${profile.baseUrl},${profile.workflow},${profile.model},${encrypted?.encrypted ?? null},${encrypted?.iv ?? null},${encrypted?.tag ?? null})
        ON CONFLICT(user_id,provider) DO UPDATE SET enabled=excluded.enabled,base_url=excluded.base_url,workflow=excluded.workflow,model=excluded.model,
          encrypted_key=excluded.encrypted_key,key_iv=excluded.key_iv,key_tag=excluded.key_tag,updated_at=NOW()`);
      await tx.execute(sql`INSERT INTO user_image_generation_preferences(user_id,active_provider) VALUES(${userId},${state.activeProvider})
        ON CONFLICT(user_id) DO UPDATE SET active_provider=excluded.active_provider,updated_at=NOW()`);
      return state;
    });
  },
  async clear(userId, provider) {
    return db.transaction(async tx => {
      await sessionMedia.lockOwner(tx, userId);
      await tx.execute(sql`DELETE FROM user_image_generation_settings WHERE user_id=${userId} AND provider=${provider}`);
      return load(tx, userId);
    });
  },
};
