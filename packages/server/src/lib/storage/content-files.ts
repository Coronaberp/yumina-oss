import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const CONTENT_DIRECTORY = ".blobs";
const mutations = new Map<string, Promise<void>>();

/** Local storage is served by one process. Share the queue between instances
 * so a replacement, its sidecar and last-reference cleanup cannot interleave. */
export async function withContentMutation<T>(root: string, work: () => Promise<T>): Promise<T> {
  const previous = mutations.get(root) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  mutations.set(root, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (mutations.get(root) === current) mutations.delete(root);
  }
}

export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function contentPath(root: string, hash: string): string {
  if (!isContentHash(hash)) throw new Error("Invalid content digest");
  return path.join(root, CONTENT_DIRECTORY, "sha256", hash.slice(0, 2), hash);
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Install a complete immutable file. Account/card paths remain independent
 * hard links; an overwrite always replaces a link, never shared file bytes.
 * Callers hold withContentMutation through metadata and cleanup as well. */
export async function installContentFile(root: string, source: string, target: string, hash: string): Promise<void> {
  const blob = contentPath(root, hash);
  await fs.mkdir(path.dirname(blob), { recursive: true });
  try {
    await fs.link(source, blob);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Shared byte storage belongs to the server OS account. Never inherit a
  // more permissive legacy file's mode when another account's private file
  // joins the same inode; publication/ownership remain per-key metadata.
  await fs.chmod(blob, 0o600);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.link(blob, temp);
    await fs.rename(temp, target);
  } finally {
    // rename can be a no-op when both names already point to the same inode.
    await fs.unlink(temp).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

/** The index itself is one link. No data should survive solely for the index
 * after its last object (or failed upload's temporary file) is removed. */
export async function releaseUnusedContent(root: string, hash: unknown): Promise<void> {
  if (!isContentHash(hash)) return;
  const blob = contentPath(root, hash);
  try {
    if ((await fs.stat(blob)).nlink === 1) await fs.unlink(blob);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
