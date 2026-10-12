import { authMiddleware } from '../middleware/auth.js';
import { imageGenerationService } from '../lib/image-generation/default.js';
import { createImageGenerationRoutes } from './image-generation.js';
export const imageGenerationRoutes = createImageGenerationRoutes(imageGenerationService, authMiddleware);
