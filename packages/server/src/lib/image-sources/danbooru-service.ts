import { createDanbooruService } from './danbooru.js';
import { danbooruRepository } from './danbooru-repository.js';
import { storeDanbooruAsset } from './danbooru-storage.js';
/** Agent methods return public configuration/posts/assets only; no decrypted key escapes. */
export const danbooruService = createDanbooruService(danbooruRepository, storeDanbooruAsset);

export const getDanbooruConfig = (userId: string) => danbooruService.getConfig(userId);
export const searchDanbooruImages = (userId: string, input: { tags: string; limit?: number; page?: number }) => danbooruService.search(userId, input);
export const importDanbooruImage = (userId: string, input: { postId: number; filename?: string; signal?: AbortSignal }) => danbooruService.import(userId, input.postId, input.filename, input.signal);
