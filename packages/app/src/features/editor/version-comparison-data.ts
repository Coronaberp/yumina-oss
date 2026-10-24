import type { WorldDefinition, WorldDiff } from "@yumina/engine";
// Keep the disposable worker limited to the pure diff module. The engine barrel
// also initializes schemas/templates that this read-only comparison never uses.
import { diffWorldSchemas } from "../../../../engine/src/diff/world-diff";

export interface VersionComparisonInput {
  saved: { schema: Record<string, unknown>; thumbnailUrl: string | null; ageRating: string };
  draft: WorldDefinition;
  currentAgeRating: string;
}

/** Runs in a worker. Never migrates, saves, restores or renders user code. */
export function compareVersionDraft({ saved, draft, currentAgeRating }: VersionComparisonInput): WorldDiff {
  // avatar is the editor's DB-cover projection and is stripped on save. Compare
  // the candidate schema and cover separately. A legacy avatar stored inside an
  // old schema remains visible as a schema difference rather than being hidden.
  const { avatar, ...schemaDraft } = draft;
  const diff = diffWorldSchemas(
    saved.schema as unknown as WorldDefinition,
    schemaDraft as WorldDefinition,
    { detail: true, coverage: "all" },
  );
  const cover = avatar || null;
  if (saved.thumbnailUrl !== cover) {
    diff.changes.push({ kind: "meta", id: "snapshot.thumbnailUrl", name: "snapshot.thumbnailUrl", op: "modified",
      fields: [{ field: "thumbnailUrl", before: saved.thumbnailUrl ?? "null", after: cover ?? "null", beforeType: saved.thumbnailUrl === null ? "null" : "string", afterType: cover === null ? "null" : "string" }] });
    diff.counts.modified++;
  }
  if (saved.ageRating !== currentAgeRating) {
    diff.changes.push({ kind: "meta", id: "snapshot.ageRating", name: "snapshot.ageRating", op: "modified",
      fields: [{ field: "ageRating", before: saved.ageRating, after: currentAgeRating, beforeType: "string", afterType: "string" }] });
    diff.counts.modified++;
  }
  return diff;
}
