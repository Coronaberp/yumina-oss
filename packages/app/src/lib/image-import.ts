export const MAX_IMAGE_IMPORT_BYTES = 20 * 1024 * 1024;
export type ImageSource = File | string;
export type PreparedImage = { file: File; skipCrop: boolean };
const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Only our validated raster response becomes a preview; clipboard HTML and remote URLs never do. */
export async function prepareImportedImage(source: ImageSource, signal: AbortSignal, endpoint: string, fetcher: typeof fetch = fetch): Promise<PreparedImage> {
  let name: string;
  let body: BodyInit;
  let contentType: string;
  if (typeof source === "string") {
    let url: URL;
    try { url = new URL(source.trim()); } catch { throw Error("Enter a valid public image URL."); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw Error("Use a public HTTP(S) image link.");
    name = url.pathname.split("/").pop() || "image";
    body = JSON.stringify({ url: source.trim() }); contentType = "application/json";
  } else {
    name = source.name;
    contentType = source.type || types[name.split(".").pop()?.toLowerCase() ?? ""] || "";
    if (!Object.values(types).includes(contentType)) throw Error("Use PNG, JPEG, GIF or WebP images.");
    if (!source.size || source.size > MAX_IMAGE_IMPORT_BYTES) throw Error("Images must be under 20 MB.");
    body = source;
  }
  const response = await fetcher(endpoint, { method: "POST", credentials: "include", headers: { "Content-Type": contentType }, body, signal });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw Error(typeof result?.error === "string" ? result.error : "The image could not be imported.");
  }
  const mime = response.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase();
  if (!mime || !Object.hasOwn(extensions, mime)) throw Error("The image could not be validated.");
  const blob = await response.blob();
  signal.throwIfAborted();
  if (!blob.size || blob.size > MAX_IMAGE_IMPORT_BYTES) throw Error("Images must be under 20 MB.");
  const stem = name.replace(/\.[^.]*$/, "").replace(/[^\p{L}\p{N}_ -]/gu, "_").slice(0,100) || "image";
  const originalExtension = name.split(".").pop()?.toLowerCase() ?? "";
  const extension = types[originalExtension] === mime ? originalExtension : extensions[mime];
  return { file: new File([blob], `${stem}.${extension}`, { type: mime }),
    skipCrop: mime === "image/gif" || response.headers.get("x-image-animated") === "true" };
}
