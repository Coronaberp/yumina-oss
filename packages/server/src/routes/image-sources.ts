import { Hono, type MiddlewareHandler } from 'hono';
import { ZodError } from 'zod';
import type { AppEnv } from '../lib/types.js';
import { DanbooruError, type createDanbooruService } from '../lib/image-sources/danbooru.js';

type Service = ReturnType<typeof createDanbooruService>;
/** Injection keeps settings tests independent of production credentials/storage/database. */
export function createImageSourceRoutes(service: Service, authenticate: MiddlewareHandler<AppEnv>) {
  const routes = new Hono<AppEnv>();
  routes.use('/*', authenticate);
  routes.onError((error, c) => {
    c.header('Cache-Control', 'no-store');
    if (error instanceof DanbooruError) return c.json({ error: error.message, code: error.code }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ error: 'Invalid image source settings.', code: 'INVALID_SETTINGS' }, 400);
    return c.json({ error: 'Image source settings could not be saved. Try again later.', code: 'SOURCE_UNAVAILABLE' }, 503);
  });
  routes.use('/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  routes.get('/danbooru', async c => c.json({ config: await service.getConfig(c.get('user').id) }));
  routes.put('/danbooru', async c => c.json({ config: await service.updateConfig(c.get('user').id, await c.req.json()) }));
  routes.delete('/danbooru', async c => c.json({ config: await service.clearConfig(c.get('user').id) }));
  routes.post('/danbooru/test', async c => {
    try { await service.test(c.get('user').id); return c.json({ success: true }); }
    catch (error) {
      return c.json({ success: false, error: error instanceof DanbooruError ? error.message : 'Danbooru connection failed. Try again later.' });
    }
  });
  return routes;
}
