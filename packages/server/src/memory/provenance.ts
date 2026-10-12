import { createHash } from "node:crypto";
import type { TranscriptMessage } from "./types.js";

/** Renderer code does not change the story that an accepted memory describes. */
export function memoryWorldHash(world: unknown): string {
  const story = { ...(world as Record<string, unknown>) };
  delete story.rootComponent;
  return createHash("sha256").update(JSON.stringify(story)).digest("hex");
}

export function sourceFingerprint(rows: TranscriptMessage[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        rows.map((r) => [
          r.id,
          r.role,
          r.content,
          r.sourceVersion ?? "",
          r.selectedAnswerId ?? "",
        ]),
      ),
    )
    .digest("hex");
}

/** Excludes the answer being regenerated and everything after its ordered identity. */
export function prefixAt<T extends TranscriptMessage>(
  rows: T[],
  answerId: string | null,
): T[] {
  if (answerId === null) return rows;
  const index = rows.findIndex((r) => r.id === answerId);
  if (index < 0) throw new Error("memory_cutoff_missing");
  return rows.slice(0, index);
}

/** Yumina continuation adapters share one logical exchange with the source core. */
export function logicalTranscript(
  rows: TranscriptMessage[],
): TranscriptMessage[] {
  const result: TranscriptMessage[] = [];
  for (const row of rows) {
    const last = result.at(-1);
    if (row.role === "assistant" && last?.role === "assistant") {
      last.content += "\n\n" + row.content;
      last.sourceVersion = `${last.sourceVersion ?? last.id ?? ""}:${row.sourceVersion ?? row.id ?? ""}`;
      last.id = row.id;
    } else result.push({ ...row });
  }
  return result;
}
