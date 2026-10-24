import { sessionArchiveSchema, archiveMediaReferences, ARCHIVE_MAX_MEDIA_BYTES, ARCHIVE_MAX_ASSET_BYTES, type ArchiveMode, type SessionArchive } from "@yumina/shared";
import { resolveImageUrl } from "@/lib/asset-url";
import { buildArchiveHtmlBlob } from "./archive-html";
import { populateArchiveDialogue } from "./archive-dialogue";
import { archiveRequestData } from "./archive-request";
import { importArchivePayload, type ArchiveImportClientOptions } from "./archive-import-client";

const apiBase = import.meta.env.VITE_API_URL || "";

async function portraitThumbnail(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, 192 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) { bitmap.close(); return blob; }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  return new Promise(resolve => canvas.toBlob(result => resolve(result || blob), "image/webp", 0.88));
}

export function downloadArchiveFile(content: string | Blob, filename: string, type = "text/html") {
  const url = URL.createObjectURL(typeof content === "string" ? new Blob([content], { type }) : content);
  const link = document.createElement("a"); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Collect literal asset refs plus actual rendered media. Never fetch arbitrary
 * URLs with account cookies; credentialed reads are limited to this app. */
export async function prepareSessionArchive(sessionId: string, mode: ArchiveMode, onProgress?: (text: string) => void): Promise<SessionArchive> {
  onProgress?.("Collecting the complete saved chat…");
  const archive = populateArchiveDialogue(sessionArchiveSchema.parse(await archiveRequestData<unknown>(`${apiBase}/api/session-archives/${encodeURIComponent(sessionId)}?mode=${mode}`, { credentials: "include" }, { timeoutMs: 60_000, timeoutMessage: "The saved chat could not be downloaded in time. Try exporting it again." })));
  const sources = new Set<string>();
  const portraits = new Set(archive.participants.flatMap(person => person.avatar ? [person.avatar] : []));
  for (const person of archive.participants) if (person.avatar) sources.add(person.avatar);
  if (archive.world.thumbnailUrl) sources.add(archive.world.thumbnailUrl);
  for (const message of archive.messages) {
    for (const attachment of message.attachments ?? []) sources.add(attachment.url);
    for (const match of message.content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) sources.add(match[1]);
  }
  if (mode === "full-save") {
    const collect = (value: unknown) => {
      if (typeof value === "string") for (const source of archiveMediaReferences(value)) sources.add(source);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(archive);
  }
  let total = 0, done = 0, next = 0;
  const pending = [...sources];
  const cache = new Map<string, Promise<string>>();
  const controller = new AbortController();
  const embed = async (source: string) => {
    const resolved = resolveImageUrl(source) || source;
    if (!cache.has(resolved)) cache.set(resolved, (async () => {
      const url = new URL(resolved, apiBase || window.location.origin);
      if (!["http:", "https:", "data:"].includes(url.protocol)) throw new Error("An attachment uses an unsupported URL.");
      const response = await fetch(url, { credentials: url.origin === window.location.origin ? "include" : "omit", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) });
      if (!response.ok) throw new Error(`Could not embed a portrait or attachment (HTTP ${response.status}). Try again after it loads in the chat.`);
      let blob = await response.blob();
      if (mode === "transcript" && portraits.has(source) && blob.type.startsWith("image/")) blob = await portraitThumbnail(blob);
      total += blob.size;
      if (total > ARCHIVE_MAX_MEDIA_BYTES || blob.size > ARCHIVE_MAX_ASSET_BYTES) throw new Error("This export's media is too large. Choose Transcript to omit world media.");
      return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Could not read an exported asset.")); reader.readAsDataURL(blob); });
    })());
    archive.assets[source] = await cache.get(resolved)!;
    onProgress?.(`Embedding media ${++done} of ${sources.size}…`);
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (next < pending.length) await embed(pending[next++]);
    }));
  } catch (error) {
    controller.abort();
    throw error;
  }
  return sessionArchiveSchema.parse(archive);
}

export async function downloadSessionArchive(sessionId: string, mode: ArchiveMode, onProgress?: (text: string) => void) {
  const archive = await prepareSessionArchive(sessionId, mode, onProgress);
  const filename = `${archive.world.name} - ${archive.session.name || "Chat"}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") + ` - ${mode}.html`;
  downloadArchiveFile(buildArchiveHtmlBlob(archive), filename);
  return { filename };
}

export async function importArchive(archive: SessionArchive | Blob, options: ArchiveImportClientOptions = {}) {
  return importArchivePayload(archive instanceof Blob ? archive : new Blob([JSON.stringify(archive)], { type: "application/json" }), options, apiBase);
}
