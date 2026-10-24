import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile, rename, unlink, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ARCHIVE_MAX_FILE_BYTES } from "@yumina/shared";
export interface ArchiveImportResult { sessionId: string; worldId: string }
export interface ArchiveUploadState { state: "uploading" | "importing" | "complete"; totalBytes: number; receivedBytes: number; contextSessionId?: string; result?: ArchiveImportResult }
interface StoredUpload extends ArchiveUploadState { updatedAt: number }
export const ARCHIVE_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const ttl = 6 * 60 * 60 * 1000;
export class ArchiveUploadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 429 = 400) { super(message); }
}
export function archiveImportIds(owner: string, requestId: string): ArchiveImportResult {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(requestId)) throw new ArchiveUploadError("Invalid archive import ID.");
  const id = (kind: string) => {
    const bytes = createHash("sha256").update(`yumina-archive\0${owner}\0${requestId.toLowerCase()}\0${kind}`).digest();
    bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
  };
  return { sessionId: id("session"), worldId: id("world") };
}

/** Private, account-scoped temporary files; never store an archive under the
 * public asset/CDN root. Each request is bounded independently of file size. */
export class ArchiveUploadStore {
  constructor(readonly root: string) {}
  private directory(owner: string, id: string) {
    archiveImportIds(owner, id);
    return join(this.root, createHash("sha256").update(owner).digest("hex"), id.toLowerCase());
  }
  private async read(directory: string): Promise<StoredUpload> {
    try { return JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as StoredUpload; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ArchiveUploadError("Archive upload not found. Choose the file again.", 404); throw error; }
  }
  private async write(directory: string, state: StoredUpload) {
    const temporary = join(directory, `state-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" }); await rename(temporary, join(directory, "state.json")); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  private async locked(directory: string) {
    try {
      const lock = JSON.parse(await readFile(join(directory, "lock"), "utf8")) as { pid: number };
      if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) return true;
      try { process.kill(lock.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    } catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  }
  private async exclusive<T>(directory: string, work: () => Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "lock"), token = randomUUID();
    let handle;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { handle = await open(path, "wx", 0o600); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await this.locked(directory)) throw new ArchiveUploadError("An archive request is already running. Wait, then check its progress.", 409);
        await unlink(path).catch(() => {});
      }
    }
    if (!handle) throw new ArchiveUploadError("The archive upload is busy. Check its progress.", 409);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); return await work(); }
    finally {
      await handle.close();
      try { const lock = JSON.parse(await readFile(path, "utf8")) as { token: string }; if (lock.token === token) await unlink(path); } catch { /* A process shutdown may already have removed this lock. */ }
    }
  }
  async create(owner: string, id: string, total: number, context?: string): Promise<ArchiveUploadState> {
    if (!Number.isSafeInteger(total) || total < 1 || total > ARCHIVE_MAX_FILE_BYTES) throw new ArchiveUploadError("Archive size must be between 1 byte and 512 MB.", 413);
    const directory = this.directory(owner, id);
    return this.exclusive(directory, async () => {
      let current: StoredUpload | undefined;
      try { current = await this.read(directory); } catch (error) { if (!(error instanceof ArchiveUploadError) || error.status !== 404) throw error; }
      if (current) {
        if (current.totalBytes !== total || current.contextSessionId !== context) throw new ArchiveUploadError("This upload's metadata does not match the original import attempt.", 409);
        if (current.state === "importing") { current.state = "uploading"; current.updatedAt = Date.now(); await this.write(directory, current); }
        return current;
      }
      let active = 0;
      const parent = join(directory, "..");
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === id.toLowerCase()) continue;
        const other = join(parent, entry.name);
        try {
          const state = await this.read(other);
          if (Date.now() - state.updatedAt > ttl && !await this.locked(other)) await rm(other, { recursive: true, force: true });
          else if (state.state !== "complete") active++;
        } catch (error) { if (!(error instanceof ArchiveUploadError)) throw error; }
      }
      if (active >= 2) throw new ArchiveUploadError("Finish an existing archive upload before starting another.", 429);
      const state: StoredUpload = { state: "uploading", totalBytes: total, receivedBytes: 0, contextSessionId: context, updatedAt: Date.now() };
      await writeFile(join(directory, "payload.json"), new Uint8Array(), { mode: 0o600 });
      await this.write(directory, state); return state;
    });
  }
  async status(owner: string, id: string): Promise<ArchiveUploadState> {
    const directory = this.directory(owner, id), state = await this.read(directory);
    if (state.state === "importing" && !await this.locked(directory)) return { ...state, state: "uploading" };
    return state;
  }
  async append(owner: string, id: string, offset: number, bytes: Buffer): Promise<ArchiveUploadState> {
    if (!bytes.length || bytes.length > ARCHIVE_UPLOAD_CHUNK_BYTES) throw new ArchiveUploadError("Archive chunk is empty or too large (maximum 4 MB).", 413);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ArchiveUploadError("Invalid archive upload offset.");
    const directory = this.directory(owner, id);
    return this.exclusive(directory, async () => {
      const state = await this.read(directory);
      if (state.state !== "uploading") throw new ArchiveUploadError("The archive is already being restored.", 409);
      if (offset > state.receivedBytes || offset + bytes.length > state.totalBytes) throw new ArchiveUploadError("The archive upload position does not match.", 409);
      const file = await open(join(directory, "payload.json"), "r+");
      try {
        if (offset < state.receivedBytes) {
          if (offset + bytes.length > state.receivedBytes) throw new ArchiveUploadError("The repeated archive chunk conflicts with the saved bytes.", 409);
          const saved = Buffer.alloc(bytes.length); await file.read(saved, 0, saved.length, offset);
          if (!saved.equals(bytes)) throw new ArchiveUploadError("The repeated archive chunk differs from the saved bytes.", 409);
          return state;
        }
        // Ignore any suffix written before a process crash but not acknowledged.
        await file.truncate(offset);
        let written = 0;
        while (written < bytes.length) { const result = await file.write(bytes, written, bytes.length - written, offset + written); if (!result.bytesWritten) throw new Error("Could not write archive chunk."); written += result.bytesWritten; }
        await file.sync();
        state.receivedBytes += bytes.length; state.updatedAt = Date.now(); await this.write(directory, state); return state;
      } finally { await file.close(); }
    });
  }
  async complete(owner: string, id: string, restore: (json: string, context?: string) => Promise<ArchiveImportResult>): Promise<ArchiveImportResult> {
    const directory = this.directory(owner, id);
    return this.exclusive(directory, async () => {
      const state = await this.read(directory);
      if (state.state === "complete" && state.result) return state.result;
      if (state.receivedBytes !== state.totalBytes) throw new ArchiveUploadError("Finish uploading the complete archive before restoring it.", 409);
      state.state = "importing"; state.updatedAt = Date.now(); await this.write(directory, state);
      try {
        const bytes = await readFile(join(directory, "payload.json"));
        if (bytes.length !== state.totalBytes) throw new ArchiveUploadError("The saved archive upload is incomplete.", 409);
        let json: string;
        try { json = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new ArchiveUploadError("The archive does not contain valid UTF-8 JSON."); }
        const result = await restore(json, state.contextSessionId);
        state.state = "complete"; state.result = result; state.updatedAt = Date.now(); await this.write(directory, state);
        await unlink(join(directory, "payload.json")).catch(() => {}); return result;
      } catch (error) { state.state = "uploading"; state.updatedAt = Date.now(); await this.write(directory, state).catch(() => {}); throw error; }
    });
  }
}
