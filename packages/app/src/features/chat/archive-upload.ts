import { ARCHIVE_MAX_FILE_BYTES, type ArchiveMode } from "@yumina/shared";
import { isArchiveDataScript, parseArchiveFile } from "./archive-html";

export interface ArchiveUpload {
  preview: { sessionName: string | null; worldName: string; messageCount: number; mode: ArchiveMode };
  payload: Blob;
  requestId: string;
}

/** Scan bounded byte chunks for the inert JSON block. Keep the file-backed
 * payload for upload instead of retaining all media in React or reserializing it. */
export async function parseArchiveUpload(file: Blob): Promise<ArchiveUpload> {
  if (file.size > ARCHIVE_MAX_FILE_BYTES) throw new Error("Choose an archive smaller than 512 MB.");
  const head = await file.slice(0, 4096).text();
  let payload = file.slice(0, file.size, "application/json");
  if (head.trim().replace(/^\uFEFF/, "").startsWith("<")) {
    const chunkSize = 512 * 1024;
    const decoder = new TextDecoder("latin1"); // One character per byte preserves slice offsets.
    let carry = "", processed = 0, start = -1, end = -1, blocks = 0;
    let script: { marked: boolean; start: number } | null = null;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const chunk = decoder.decode(await file.slice(offset, offset + chunkSize).arrayBuffer());
      const text = carry + chunk, base = offset - carry.length;
      const tags = /<script\b([^>]*)>|<\/script\s*>/gi;
      for (const match of text.matchAll(tags)) {
        const position = base + match.index!;
        if (position < processed) continue;
        processed = position + match[0].length;
        if (/^<\//.test(match[0])) {
          if (script?.marked) { blocks++; start = script.start; end = position; }
          script = null;
        } else if (!script) {
          const attributes = match[1];
          script = { marked: isArchiveDataScript(attributes), start: processed };
        }
      }
      carry = text.slice(-4096);
    }
    if (blocks !== 1 || start < 0 || end < start) throw new Error("Choose a Yumina HTML transcript or JSON archive.");
    payload = file.slice(start, end, "application/json");
  }
  const archive = parseArchiveFile(await payload.text());
  // Embedded portraits make the offline transcript readable. Restoring it on
  // its original card reuses that card's images and sends message metadata only.
  if (archive.mode === "transcript") payload = new Blob([JSON.stringify({ ...archive, assets: {} })], { type: "application/json" });
  return { preview: { sessionName: archive.session.name, worldName: archive.world.name, messageCount: archive.messages.length, mode: archive.mode }, payload, requestId: crypto.randomUUID() };
}
