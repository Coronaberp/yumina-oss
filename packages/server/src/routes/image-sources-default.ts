import { createImageSourceRoutes } from './image-sources.js';
import { danbooruService } from '../lib/image-sources/danbooru-service.js';
import { authMiddleware } from '../middleware/auth.js';
export const imageSourceRoutes = createImageSourceRoutes(danbooruService, authMiddleware);
