import { Hono, type MiddlewareHandler } from 'hono';
import { z, ZodError } from 'zod';
import type { AppEnv } from '../lib/types.js';
import { GenerationError, providers } from '../lib/image-generation/config.js';
import type { createImageGenerationService } from '../lib/image-generation/service.js';
export function createImageGenerationRoutes(service: ReturnType<typeof createImageGenerationService>, authenticate: MiddlewareHandler<AppEnv>) {
  const routes = new Hono<AppEnv>();
  routes.use('/*', authenticate);
  routes.use('/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  routes.onError((error, c) => {
    c.header('Cache-Control', 'no-store');
    if (error instanceof GenerationError) return c.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid image-generation settings.', code: 'INVALID_SETTINGS' }, 400);
    return c.json({ error: 'Image-generation settings are unavailable. Try again later.', code: 'SETTINGS_UNAVAILABLE' }, 503);
  });
  // Mount beside Danbooru under /api/image-sources. No paid generation HTTP route.
  routes.get('/generation', async c => c.json(await service.getConfig(c.get('user').id)));
  routes.get('/generation/anima-models', async c => c.json(await service.listAnimaModels(c.get('user').id, c.req.raw.signal)));
  routes.put('/generation', async c => c.json(await service.updateConfig(c.get('user').id, await c.req.json())));
  routes.delete('/generation/:provider', async c => c.json(await service.clearConfig(c.get('user').id, z.enum(providers).parse(c.req.param('provider')))));
  routes.post('/generation/test', async c => {
    try {
      const { provider } = z.object({ provider: z.enum(providers) }).strict().parse(await c.req.json());
      await service.test(c.get('user').id, provider, c.req.raw.signal);
      return c.json({ success: true });
    } catch (error) { return c.json({ success: false, error: error instanceof GenerationError ? error.message : error instanceof ZodError || error instanceof SyntaxError ? 'Choose a valid image provider.' : 'Image provider connection failed.' }); }
  });
  return routes;
}
