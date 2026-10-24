import { Hono } from "hono";
import type { Context } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { isS3Configured, getObject, headObject, getObjectBuffer, putObject } from "../lib/s3.js";
import { createPortraitVariants } from "../lib/portrait-variant.js";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { publicAssetCacheControl } from "../lib/public-asset-cache.js";
import { isPublicCdnKey, resolvePublicCdnKey } from "../lib/cdn-key-policy.js";
import { decodeImageMaster, imageMasterDecodedLength, isImageMasterEnvelope } from "../lib/image-master-envelope.js";

const cdnRoutes = new Hono();
const portraitVariant = createPortraitVariants({ head: headObject, read: getObjectBuffer, write: putObject });

// Allowed S3 key prefixes (defense-in-depth against arbitrary key access)

/**
 * CORS for the public asset route.
 *
 * The card sandbox is an `allow-scripts` iframe with an OPAQUE origin, so every
 * request it makes here is cross-origin. Plain `<img>` display never needed
 * this — the browser paints a cross-origin image happily. But a WebGL texture
 * upload does: `texImage2D` refuses a non-origin-clean image, and three.js's
 * loaders request with `crossOrigin="anonymous"`. Without this header a 3D card
 * simply cannot use anything from the asset library, which is why every 3D card
 * so far has had to generate its textures in code.
 *
 * Safe to open: this route is already public and unauthenticated — anyone can
 * `curl` these bytes today. `*` only adds *scripted* cross-origin reads of data
 * that was never protected. It must NOT be widened to reflect an Origin with
 * credentials, and this route must never start honoring cookies.
 */
function applyCdnCors(c: Context): void {
  c.header("Access-Control-Allow-Origin", "*");
  // Media seeking + progress UIs need these readable cross-origin; without the
  // allowlist the browser hides them from script even on a successful response.
  c.header("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag, Content-Encoding, X-Uncompressed-Length");
  // `Vary: Origin` is deliberately omitted: the value is a constant `*`, so
  // varying would only fragment the Cloudflare cache for no behavioral gain.
}

// Range is only CORS-safelisted for simple `bytes=a-b` forms, so media players
// issuing anything richer will preflight. Answer it here rather than 404-ing.
cdnRoutes.options("/*", (c) => {
  applyCdnCors(c);
  c.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Range, Content-Type, If-None-Match, If-Range");
  c.header("Access-Control-Max-Age", "86400");
  return c.body(null, 204);
});

// GET /cdn/key/:encodedKey — public, permanent URL for raw S3 keys
// Used for thumbnails, gallery images, user avatars that don't have asset table entries.
// The key is base64url-encoded to be URL-safe.
cdnRoutes.get("/key/:encodedKey", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const encodedKey = c.req.param("encodedKey");

  let s3Key: string;
  try {
    s3Key = Buffer.from(encodedKey, "base64url").toString("utf-8");
  } catch {
    return c.json({ error: "Invalid key encoding" }, 400);
  }

  if (!s3Key || s3Key.includes("..") || !s3Key.includes("/")) {
    return c.json({ error: "Invalid key" }, 400);
  }

  if (!isPublicCdnKey(s3Key)) {
    return c.json({ error: "Invalid key prefix" }, 400);
  }

  const variant = c.req.query("variant") === "portrait" ? await portraitVariant(s3Key) : undefined;
  return streamS3Object(c, variant || s3Key, "CDN key proxy error:");
});

const ENTITY_TAG = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
const singleEntityTag = new RegExp(`^${ENTITY_TAG}$`);
const entityTagList = new RegExp(`^[\\t ]*${ENTITY_TAG}(?:[\\t ]*,[\\t ]*${ENTITY_TAG})*[\\t ]*$`);

/** S3 HEAD and local sidecars use bare tags; HTTP requires quoted tags. */
function httpEtag(value: string | null): string | null {
  if (!value) return null;
  if (singleEntityTag.test(value)) return value;
  const quoted = `"${value}"`;
  return singleEntityTag.test(quoted) ? quoted : null;
}

function matchesIfNoneMatch(header: string | undefined, etag: string | null): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  if (!etag || !entityTagList.test(header)) return false;
  const current = etag.replace(/^W\//, "");
  return [...header.matchAll(new RegExp(ENTITY_TAG, "g"))]
    .some(([tag]) => tag.replace(/^W\//, "") === current);
}

type ObjectHeaders = Pick<Awaited<ReturnType<typeof getObject>>,
  "contentType" | "etag" | "contentEncoding" | "decodedLength" | "sourceSha256" | "storedSha256">;

function imageEncoding(c: Context): "gzip" | "identity" | null {
  const header = c.req.header("accept-encoding");
  if (!header) return "identity";
  const accepted = new Map<string, number>();
  for (const entry of header.split(",")) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(";");
    let quality = 1;
    for (const parameter of parameters) {
      if (!parameter.trim().startsWith("q=")) continue;
      const value = parameter.trim().slice(2);
      quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value) ? Number(value) : 0;
    }
    if (name) accepted.set(name, quality);
  }
  const gzip = accepted.get("gzip") ?? accepted.get("*") ?? 0;
  const identity = accepted.get("identity") ?? (accepted.get("*") === 0 ? 0 : 1);
  return gzip > 0 && gzip >= identity ? "gzip" : identity > 0 ? "identity" : gzip > 0 ? "gzip" : null;
}

function representation(c: Context, metadata: ObjectHeaders & { contentLength?: number }) {
  if (!isImageMasterEnvelope(metadata)) return metadata;
  const size = imageMasterDecodedLength(metadata);
  const vary = c.res.headers.get("Vary");
  if (!vary?.split(",").some(value => value.trim().toLowerCase() === "accept-encoding"))
    c.header("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  const encoding = imageEncoding(c);
  if (!encoding) throw new Error("IMAGE_ENCODING_NOT_ACCEPTABLE");
  return encoding === "gzip" ? metadata : { ...metadata, etag: metadata.sourceSha256!, contentLength: size, contentEncoding: undefined };
}

async function closeBody(body: Awaited<ReturnType<typeof getObject>>["body"]): Promise<void> {
  if (body instanceof Readable) body.destroy();
  else await (body as ReadableStream | undefined)?.cancel();
}

function applyObjectHeaders(c: Context, key: string, metadata: ObjectHeaders, imageEnvelope = isImageMasterEnvelope(metadata)): void {
  applyCdnCors(c);
  c.header("Content-Type", metadata.contentType);
  if (metadata.contentEncoding) c.header("Content-Encoding", metadata.contentEncoding);
  if (metadata.contentEncoding && metadata.decodedLength && (key.startsWith("worlds/pvz-previews/") || isImageMasterEnvelope(metadata)))
    c.header("X-Uncompressed-Length", String(metadata.decodedLength));
  // Keep browser revalidation and the existing bounded edge cache for objects
  // that can be deleted. Only content-addressed public packs are immutable.
  c.header("Cache-Control", publicAssetCacheControl(key));
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Accept-Ranges", imageEnvelope ? "none" : "bytes");
  const etag = httpEtag(metadata.etag);
  if (etag) c.header("ETag", etag);
}

/** Stream media with cache validation and version-safe ranged reads. */
export async function streamS3Object(
  c: Context,
  s3Key: string,
  errorLogPrefix: string,
  readObject: typeof getObject = getObject,
  inspectObject: typeof headObject = headObject,
): Promise<Response> {
  let range = c.req.header("range");
  const ifNoneMatch = c.req.header("if-none-match");
  const ifRange = c.req.header("if-range");
  const isHead = c.req.method === "HEAD";
  try {
    let ifMatch: string | undefined;
    if (isHead || ifNoneMatch !== undefined || range) {
      // Check storage existence before returning 304. Do not open the media body.
      const metadata = await inspectObject(s3Key);
      const selected = representation(c, metadata);
      const etag = httpEtag(selected.etag);
      if (matchesIfNoneMatch(ifNoneMatch, etag)) {
        applyObjectHeaders(c, s3Key, selected, isImageMasterEnvelope(metadata));
        return c.body(null, 304);
      }
      if (isHead) {
        applyObjectHeaders(c, s3Key, selected, isImageMasterEnvelope(metadata));
        c.header("Content-Length", String(selected.contentLength));
        return c.body(null, 200);
      }
      if (isImageMasterEnvelope(metadata)) range = undefined;
      else if (range && ifRange !== undefined) {
        // HTTP dates and weak tags cannot prove an exact match. For strong
        // tags, pin the storage read so an intervening overwrite cannot mix
        // byte ranges from two different versions of an image or video.
        if (etag && !etag.startsWith("W/") && ifRange === etag) ifMatch = etag;
        else range = undefined;
      }
    }

    let object: Awaited<ReturnType<typeof getObject>>;
    try {
      object = await readObject(s3Key, range ? { range, ...(ifMatch ? { ifMatch } : {}) } : undefined);
    } catch (err: any) {
      // A same-key overwrite may turn an identity image into a smaller gzip
      // envelope between inspection and Range GET, including a resulting416.
      if (range && err?.$metadata?.httpStatusCode === 416 && isImageMasterEnvelope(await inspectObject(s3Key))) {
        range = undefined; object = await readObject(s3Key);
      } else {
        if (!ifMatch || err?.$metadata?.httpStatusCode !== 412) throw err;
        range = undefined;
        object = await readObject(s3Key);
      }
    }
    if (isImageMasterEnvelope(object) && object.contentRange) {
      await closeBody(object.body); range = undefined; object = await readObject(s3Key);
    }
    let { body } = object;

    if (!body) {
      return c.json({ error: "Asset body empty" }, 502);
    }

    let selected;
    try { selected = representation(c, object); }
    catch (error) { await closeBody(body); throw error; }
    applyObjectHeaders(c, s3Key, selected, isImageMasterEnvelope(object));
    // Recheck against the actual read if an object changed after inspection.
    if (matchesIfNoneMatch(ifNoneMatch, httpEtag(selected.etag))) {
      await closeBody(body);
      return c.body(null, 304);
    }
    if (isImageMasterEnvelope(object) && selected.contentEncoding === undefined) {
      const chunks: Buffer[] = []; let size = 0;
      const limit = imageMasterDecodedLength(object);
      try {
        const source = body instanceof Readable ? body : Readable.fromWeb(body as never);
        await pipeline(source, new Writable({ write(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size >= limit) return done(new Error("Invalid image master stored size"));
          chunks.push(chunk); done();
        } }), { signal: c.req.raw.signal });
      } finally { await closeBody(body); }
      const decoded = await decodeImageMaster(Buffer.concat(chunks, size), object, { signal: c.req.raw.signal });
      body = Readable.from([decoded]); range = undefined;
    }
    if (selected.contentLength != null) {
      c.header("Content-Length", String(selected.contentLength));
    }
    let status = 200;
    if (range && object.contentRange && !isImageMasterEnvelope(object)) {
      c.header("Content-Range", object.contentRange);
      status = 206;
    }

    const stream = body instanceof Readable ? (Readable.toWeb(body) as ReadableStream) : (body as ReadableStream);
    return new Response(stream, { status, headers: c.res.headers });
  } catch (err: any) {
    if (err?.message === "IMAGE_ENCODING_NOT_ACCEPTABLE") return c.json({ error: "No acceptable image encoding" }, 406);
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      return c.json({ error: "Asset file not found in storage" }, 404);
    }
    // An unsatisfiable range (seek past EOF) comes back from S3 as 416.
    if (err?.$metadata?.httpStatusCode === 416) {
      return c.json({ error: "Requested range not satisfiable" }, 416);
    }
    console.error(errorLogPrefix, err);
    return c.json({ error: "Failed to fetch asset" }, 502);
  }
}

// GET /cdn/:assetId — public, permanent URL for any asset
// No auth required — UUID is unguessable. CDN-friendly cache headers.
cdnRoutes.get("/:assetId", async (c) => {
  if (!isS3Configured()) {
    return c.json({ error: "Asset storage not configured" }, 503);
  }

  const assetId = c.req.param("assetId");

  // A logical binding can be deleted while its shared master remains stored.
  // Resolve the current row on every request, including conditional GET/HEAD.
  const s3Key = await resolvePublicCdnKey(async () => {
    // Single query across both tables
    const result = await db.execute(sql`
      SELECT url FROM assets WHERE id = ${assetId}
      UNION ALL
      SELECT url FROM user_assets WHERE id = ${assetId}
      LIMIT 1
    `);

    const rows = result.rows as Array<{ url: string }>;
    return rows[0]?.url ?? null;
  });

  if (!s3Key || !isPublicCdnKey(s3Key)) {
    return c.json({ error: "Asset not found" }, 404);
  }

  const variant = c.req.query("variant") === "portrait" ? await portraitVariant(s3Key) : undefined;
  return streamS3Object(c, variant || s3Key, "CDN proxy error:");
});

export { cdnRoutes };
