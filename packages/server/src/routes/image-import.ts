import { Hono } from "hono";
import type { AppEnv } from "../lib/types.js";
import { createPinnedProviderFetch } from "../lib/image-generation/host-transport.js";
import { downloadImportedImage, normalizeImportedImage, readImportBody, MAX_IMPORT_BYTES, ImageImportPolicyError } from "../lib/image-import.js";

type Dependencies = { rateLimit: (userId: string) => Promise<{ error: string; retryAfter: number } | null>; fetcher?: typeof fetch };
export function createImageImportRoutes({ rateLimit, fetcher = createPinnedProviderFetch({ allowPrivate: false }) }: Dependencies) {
  const routes = new Hono<AppEnv>();
  const users = new Set<string>();
  routes.post("/", async c => {
    const discard = () => { void c.req.raw.body?.cancel().catch(() => {}); };
    const userId = c.get("user")?.id;
    if (!userId) { discard(); return c.json({ error: "Sign in to import images." }, 401); }
    const limited = await rateLimit(userId);
    if (limited) { discard(); c.header("Retry-After", String(limited.retryAfter)); return c.json({ error: limited.error }, 429); }
    if (users.has(userId) || users.size >= 4) { discard(); return c.json({ error: "Image import is busy. Please try again shortly." }, 429); }
    users.add(userId);
    try {
      const mime = c.req.header("content-type")?.split(";",1)[0]?.trim().toLowerCase();
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15_000)]);
      const isJson = mime === "application/json";
      if (!isJson && !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime ?? "")) {
        discard(); return c.json({ error: "Use a PNG, JPEG, GIF, WebP or a JSON image URL." }, 415);
      }
      const maxBytes = isJson ? 8192 : MAX_IMPORT_BYTES;
      if (Number(c.req.header("content-length")) > maxBytes) { discard(); return c.json({ error: "Image request exceeds its size limit." }, 413); }
      const bytes = await readImportBody(c.req.raw.body, maxBytes, signal);
      let image;
      if (isJson) {
        const body = JSON.parse(bytes.toString("utf8"));
        image = await downloadImportedImage(body?.url, signal, fetcher);
      } else image = await normalizeImportedImage(bytes);
      signal.throwIfAborted();
      c.header("Content-Type", image.mimeType);
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Cache-Control", "no-store");
      c.header("Content-Security-Policy", "default-src 'none'; sandbox");
      c.header("X-Image-Animated", String(image.animated));
      return c.body(new Uint8Array(image.bytes));
    } catch (error) {
      if (error instanceof ImageImportPolicyError) return c.json({ error: error.message }, 400);
      // Do not reflect remote hostnames, signed URLs, response bodies or decoder internals.
      return c.json({ error: "Could not import this image. Use a direct public PNG, JPEG, GIF or WebP under 20 MB. Redirects and private addresses are blocked." }, 400);
    } finally { users.delete(userId); }
  });
  return routes;
}
