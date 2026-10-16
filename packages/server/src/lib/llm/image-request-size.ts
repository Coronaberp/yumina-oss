import sharp from "sharp";

// Leave headroom below the 4.5 MB limit used by serverless custom API proxies.
// This is an HTTP byte budget, independent of a model's token/context window.
const MAX_CUSTOM_IMAGE_REQUEST_BYTES = 4 * 1024 * 1024;
const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
type ImagePart = { type?: string; image_url?: { url?: string; [key: string]: unknown }; [key: string]: unknown };

/** Bound only the outgoing image copies; keep text, tools and originals intact. */
export async function fitCustomImageRequest(
  body: Record<string, unknown>, signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const originalBytes = Buffer.byteLength(JSON.stringify(body));
  if (originalBytes <= MAX_CUSTOM_IMAGE_REQUEST_BYTES || !Array.isArray(body.messages)) return body;
  const images = new Set<string>();
  let imageCount = 0, imageUrlBytes = 0;
  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const url = part?.type === "image_url" ? part.image_url?.url : undefined;
      if (typeof url !== "string" || !DATA_IMAGE.test(url)) continue;
      images.add(url);
      imageCount++;
      imageUrlBytes += Buffer.byteLength(url);
    }
  }
  // Never fetch remote URLs or trim a text-only prompt to solve an image error.
  if (!imageCount) return body;
  const availableUrlBytes = MAX_CUSTOM_IMAGE_REQUEST_BYTES - (originalBytes - imageUrlBytes) - 256;
  const urlBudget = Math.floor(availableUrlBytes / imageCount);
  if (urlBudget < 256) throw new Error("This image request has too much text or tool data for the endpoint. Start a new chat with the images you need.");
  const binaryBudget = Math.floor((urlBudget - 64) * 3 / 4);
  const replacements = new Map<string, string>();
  for (const url of images) {
    signal.throwIfAborted();
    if (Buffer.byteLength(url) <= urlBudget) { replacements.set(url, url); continue; }
    const bytes = Buffer.from(DATA_IMAGE.exec(url)![2]!, "base64");
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
    if (!metadata.width || !metadata.height) throw new Error("An attached image could not be prepared for the endpoint.");
    let edge = Math.min(1536, Math.max(metadata.width, metadata.height));
    let fitted: string | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      signal.throwIfAborted();
      const resized = sharp(bytes, { limitInputPixels: 40_000_000 }).timeout({ seconds: 10 })
        .rotate().resize(edge, edge, { fit: "inside", withoutEnlargement: true });
      // PNG keeps alpha intact; opaque images use JPEG to retain more detail
      // within the same byte budget. Stored/reference-generation bytes stay original.
      const output = metadata.hasAlpha
        ? await resized.png({ compressionLevel: 9 }).toBuffer()
        : await resized.jpeg({ quality: 80 }).toBuffer();
      signal.throwIfAborted();
      if (output.byteLength <= binaryBudget) {
        fitted = `data:image/${metadata.hasAlpha ? "png" : "jpeg"};base64,${output.toString("base64")}`;
        break;
      }
      if (edge <= 64) break;
      edge = Math.max(64, Math.min(edge - 1, Math.floor(edge * Math.sqrt(binaryBudget / output.byteLength) * 0.9)));
    }
    if (!fitted) throw new Error("The attached images could not fit the endpoint's request limit. Try fewer images in a new chat.");
    replacements.set(url, fitted);
  }
  const result = { ...body, messages: body.messages.map(message => !Array.isArray(message?.content) ? message : {
    ...message, content: message.content.map((part: ImagePart) => {
      const url = part?.type === "image_url" ? part.image_url?.url : undefined;
      const replacement = typeof url === "string" ? replacements.get(url) : undefined;
      return replacement ? { ...part, image_url: { ...part.image_url, url: replacement } } : part;
    }),
  }) };
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_CUSTOM_IMAGE_REQUEST_BYTES) throw new Error("The image request still exceeds the endpoint's request limit. Try fewer images in a new chat.");
  return result;
}
