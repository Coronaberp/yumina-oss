export interface StudioSnapshotMaterial {
  schema: Record<string, unknown>;
  /** Absent on legacy snapshots: preserve the current working portrait. */
  thumbnailUrl?: string | null;
}

/** Keep metadata outside the schema so all custom schema fields round-trip. */
export function encodeStudioSnapshotMaterial(
  schema: Record<string, unknown>, thumbnailUrl: string | null,
): Record<string, unknown> {
  return { kind: "studio-world-material", version: 1, schema, thumbnailUrl };
}

export function decodeStudioSnapshotMaterial(value: Record<string, unknown>): StudioSnapshotMaterial {
  if (Object.keys(value).length === 4
    && value.kind === "studio-world-material" && value.version === 1
    && value.schema && typeof value.schema === "object" && !Array.isArray(value.schema)
    && (value.thumbnailUrl === null || typeof value.thumbnailUrl === "string")) {
    return { schema: value.schema as Record<string, unknown>, thumbnailUrl: value.thumbnailUrl };
  }
  return { schema: value };
}
