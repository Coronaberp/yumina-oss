import { diffWorldSchemas, type WorldChange, type WorldDefinition, type WorldDiff } from "@yumina/engine";
import { decodeStudioSnapshotMaterial } from "../studio-world-material.js";

export interface TimelineSnapshotInput {
  id: string;
  schemaData: unknown; // legacy schema JSON or versioned Studio material
}

export interface SnapshotSummary {
  id: string;
  summary: WorldChange[];
}

/** Compare complete Studio state without placing the portrait inside schema.avatar. */
export function diffStudioSnapshotMaterials(
  before: unknown,
  after: unknown,
  opts: { detail?: boolean } = {},
): WorldDiff {
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const prev = decodeStudioSnapshotMaterial(asRecord(before));
  const next = decodeStudioSnapshotMaterial(asRecord(after));
  const diff = diffWorldSchemas(prev.schema as unknown as WorldDefinition, next.schema as unknown as WorldDefinition, opts);
  // Historical plain-schema snapshots did not record portraits. Their omission
  // means unknown, so mixed timelines must not invent a cover replacement.
  if (prev.thumbnailUrl !== undefined && next.thumbnailUrl !== undefined) {
    const previousCover = prev.thumbnailUrl ?? "";
    const nextCover = next.thumbnailUrl ?? "";
    if (previousCover !== nextCover) {
      diff.changes.push({
        kind: "meta", op: "modified", id: "thumbnailUrl", name: "thumbnailUrl",
        ...(opts.detail ? { fields: [{ field: "thumbnailUrl", before: previousCover, after: nextCover }] } : {}),
      });
      diff.counts.modified++;
    }
  }
  return diff;
}

/**
 * snapshots MUST be ordered oldest -> newest. Each snapshot is paired with the
 * next newer snapshot's state; the newest snapshot is paired with `current`
 * (the live world). Returns lightweight (detail:false) change summaries.
 */
export function summarizeSnapshotTimeline(
  snapshots: TimelineSnapshotInput[],
  current: unknown,
): SnapshotSummary[] {
  const out: SnapshotSummary[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const prev = snapshots[i]!.schemaData;
    const next = i + 1 < snapshots.length ? snapshots[i + 1]!.schemaData : current;
    out.push({ id: snapshots[i]!.id, summary: diffStudioSnapshotMaterials(prev, next).changes });
  }
  return out;
}
