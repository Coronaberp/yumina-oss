import type { WorldDefinition } from "../types/index.js";

export type WorldChangeKind =
  | "entry" | "variable" | "rule" | "reaction" | "audio" | "route" | "ending" | "customUI" | "meta";

export interface WorldFieldChange {
  field: string;
  before: string;
  after: string;
  /** Value types are included by complete comparisons, including absent fields. */
  beforeType?: string;
  afterType?: string;
}

export interface WorldChange {
  kind: WorldChangeKind;
  op: "added" | "removed" | "modified";
  /** Stable identity of the changed item (entity id, filename, or scalar field name). */
  id?: string;
  /** Human label — entity name, falls back to id. */
  name?: string;
  /** Field-level before/after; only populated when opts.detail is true. */
  fields?: WorldFieldChange[];
}

export interface WorldDiff {
  changes: WorldChange[];
  counts: { added: number; removed: number; modified: number };
}

type Row = Record<string, unknown>;

interface CollectionSpec {
  kind: Exclude<WorldChangeKind, "customUI" | "meta">;
  get: (w: Partial<WorldDefinition>) => Row[];
  /** Fields compared to decide "modified" and emitted as before/after when detail=true. */
  fields: string[];
}

const COLLECTIONS: CollectionSpec[] = [
  // Entry fields that affect WHAT the AI is fed or HOW/WHEN an entry fires — all
  // are material and must trigger re-review. Deliberately excludes id (the match
  // key), position (in-section ordering — diffs are order-independent), and
  // purely organizational metadata (tags, folderId, presetId). Keep in sync with
  // the WorldEntry interface: a new AI-affecting field added there should be
  // added here too, or it would change LIVE on a published card with no review.
  { kind: "entry",    get: (w) => (w.entries as unknown as Row[]) ?? [],     fields: ["name", "content", "role", "portrait", "apiRole", "depth", "alwaysSend", "keywords", "conditions", "conditionLogic", "matchWholeWords", "secondaryKeywords", "secondaryKeywordLogic", "preventRecursion", "excludeRecursion", "section", "enabled"] },
  { kind: "variable", get: (w) => (w.variables as unknown as Row[]) ?? [],   fields: ["name", "type", "defaultValue", "description", "behaviorRules"] },
  { kind: "rule",     get: (w) => (w.rules as unknown as Row[]) ?? [],       fields: ["name", "enabled"] },
  { kind: "reaction", get: (w) => (w.reactions as unknown as Row[]) ?? [],   fields: ["name"] },
  { kind: "audio",    get: (w) => (w.audioTracks as unknown as Row[]) ?? [], fields: ["name", "url"] },
  { kind: "route",    get: (w) => (w.routes as unknown as Row[]) ?? [], fields: ["name", "enabled", "priority", "guidance", "conditions", "conditionLogic", "lockOnEntry"] },
  { kind: "ending",   get: (w) => (w.endings as unknown as Row[]) ?? [], fields: ["name", "enabled", "priority", "routeIds", "conditions", "conditionLogic", "allowUnconditional", "outcome", "mode", "prose", "guidance"] },
];

const META_FIELDS = ["name", "description", "coverCrop", "bannerImageUrl", "bannerCrop"] as const;

function asText(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function indexById(rows: Row[]): Map<string, Row> {
  const map = new Map<string, Row>();
  for (const r of rows) {
    const id = typeof r.id === "string" ? r.id : undefined;
    if (id) map.set(id, r);
  }
  return map;
}

function labelOf(row: Row, id: string): string {
  return typeof row.name === "string" && row.name ? row.name : id;
}

function diffFields(prev: Row, next: Row, fields: string[]): WorldFieldChange[] {
  const out: WorldFieldChange[] = [];
  for (const f of fields) {
    const before = asText(prev[f]);
    const after = asText(next[f]);
    if (before !== after) out.push({ field: f, before, after });
  }
  return out;
}

export function diffWorldSchemas(
  prev: WorldDefinition,
  next: WorldDefinition,
  opts: { detail?: boolean; coverage?: "review" | "all" } = {},
): WorldDiff {
  // Review callers retain their existing material-change policy. History must
  // compare every stored field, including unknown extension/custom content.
  if (opts.coverage === "all") return diffCompleteSchemas(prev, next, opts.detail === true);
  const detail = opts.detail === true;
  const changes: WorldChange[] = [];

  for (const spec of COLLECTIONS) {
    const prevMap = indexById(spec.get(prev));
    const nextMap = indexById(spec.get(next));
    for (const [id, row] of nextMap) {
      if (!prevMap.has(id)) {
        changes.push({ kind: spec.kind, op: "added", id, name: labelOf(row, id) });
      } else {
        const fields = diffFields(prevMap.get(id)!, row, spec.fields);
        if (fields.length > 0) {
          changes.push({ kind: spec.kind, op: "modified", id, name: labelOf(row, id), ...(detail ? { fields } : {}) });
        }
      }
    }
    for (const [id, row] of prevMap) {
      if (!nextMap.has(id)) changes.push({ kind: spec.kind, op: "removed", id, name: labelOf(row, id) });
    }
  }

  // customUI — rootComponent.files keyed by filename
  const prevFiles = ((prev.rootComponent as unknown as Row | undefined)?.files as Record<string, string> | undefined) ?? {};
  const nextFiles = ((next.rootComponent as unknown as Row | undefined)?.files as Record<string, string> | undefined) ?? {};
  for (const name of Object.keys(nextFiles)) {
    if (!(name in prevFiles)) {
      changes.push({ kind: "customUI", op: "added", id: name, name });
    } else if (prevFiles[name] !== nextFiles[name]) {
      changes.push({ kind: "customUI", op: "modified", id: name, name, ...(detail ? { fields: [{ field: name, before: prevFiles[name]!, after: nextFiles[name]! }] } : {}) });
    }
  }
  for (const name of Object.keys(prevFiles)) {
    if (!(name in nextFiles)) changes.push({ kind: "customUI", op: "removed", id: name, name });
  }

  const prevStructured = prev.settings?.storyStructureEnabled ?? true;
  const nextStructured = next.settings?.storyStructureEnabled ?? true;
  if (prevStructured !== nextStructured) {
    changes.push({ kind: "meta", op: "modified", id: "settings.storyStructureEnabled", name: "Story structure", ...(detail ? { fields: [{ field: "storyStructureEnabled", before: String(prevStructured), after: String(nextStructured) }] } : {}) });
  }

  // Root metadata, including independent artwork and framing.
  for (const f of META_FIELDS) {
    const before = asText((prev as unknown as Row)[f]);
    const after = asText((next as unknown as Row)[f]);
    if (before !== after) {
      changes.push({ kind: "meta", op: "modified", id: f, name: f, ...(detail ? { fields: [{ field: f, before, after }] } : {}) });
    }
  }

  const counts = { added: 0, removed: 0, modified: 0 };
  for (const c of changes) counts[c.op]++;
  return { changes, counts };
}


/** JSON object key order is immaterial; array order and value types are not. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)]));
  }
  return value;
}

function completeField(field: string, before: unknown, after: unknown): WorldFieldChange | null {
  const a = canonical(before);
  const b = canonical(after);
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  const valueType = (v: unknown) => v === undefined ? "missing" : v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const text = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? "";
  return { field, before: text(a), after: text(b), beforeType: valueType(a), afterType: valueType(b) };
}

function diffCompleteSchemas(prev: WorldDefinition, next: WorldDefinition, detail: boolean): WorldDiff {
  const changes: WorldChange[] = [];
  const addFields = (before: Row, after: Row, change: Omit<WorldChange, "op" | "fields">, op: WorldChange["op"] = "modified") => {
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      .map(field => completeField(field, Object.hasOwn(before, field) ? before[field] : undefined, Object.hasOwn(after, field) ? after[field] : undefined)).filter((f): f is WorldFieldChange => f !== null);
    if (fields.length) changes.push({ ...change, op, ...(detail ? { fields } : {}) });
  };
  const rootBefore = { ...prev } as unknown as Row;
  const rootAfter = { ...next } as unknown as Row;
  const collectionKeys = ["entries", "variables", "rules", "reactions", "audioTracks", "routes", "endings"];
  COLLECTIONS.forEach((spec, index) => {
    const key = collectionKeys[index]!;
    const before = rootBefore[key];
    const after = rootAfter[key];
    // Invalid/missing/duplicate identities are compared as raw data rather than
    // disappearing in a Map. This also preserves absent-vs-empty differences.
    const valid = (value: unknown): value is Row[] => Array.isArray(value) && value.every(row => row && typeof row === "object" && typeof row.id === "string") && new Set(value.map(row => row.id)).size === value.length;
    if (!valid(before) || !valid(after)) return;
    delete rootBefore[key];
    delete rootAfter[key];
    const a = indexById(before);
    const b = indexById(after);
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      const oldRow = a.get(id);
      const newRow = b.get(id);
      addFields(oldRow ?? {}, newRow ?? {}, { kind: spec.kind, id, name: labelOf(newRow ?? oldRow!, id) }, !oldRow ? "added" : !newRow ? "removed" : "modified");
    }
    // A pure reorder matters in history even when individual rows are equal.
    const oldOrder = before.map(row => row.id).filter(id => b.has(id as string));
    const newOrder = after.map(row => row.id).filter(id => a.has(id as string));
    const order = completeField("order", oldOrder, newOrder);
    if (order) changes.push({ kind: "meta", op: "modified", id: `${key}.order`, name: `${key}.order`, ...(detail ? { fields: [order] } : {}) });
  });
  const object = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
  if (object(rootBefore.rootComponent) && object(rootAfter.rootComponent)) {
    const before = { ...rootBefore.rootComponent };
    const after = { ...rootAfter.rootComponent };
    if (object(before.files) && object(after.files)) {
      for (const file of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
        addFields(Object.hasOwn(before.files, file) ? { [file]: before.files[file] } : {}, Object.hasOwn(after.files, file) ? { [file]: after.files[file] } : {}, { kind: "customUI", id: file, name: file }, !Object.hasOwn(before.files, file) ? "added" : !Object.hasOwn(after.files, file) ? "removed" : "modified");
      }
      delete before.files;
      delete after.files;
    }
    addFields(before, after, { kind: "customUI", id: "rootComponent", name: "rootComponent" });
    delete rootBefore.rootComponent;
    delete rootAfter.rootComponent;
  }
  for (const field of new Set([...Object.keys(rootBefore), ...Object.keys(rootAfter)])) {
    addFields(Object.hasOwn(rootBefore, field) ? { [field]: rootBefore[field] } : {}, Object.hasOwn(rootAfter, field) ? { [field]: rootAfter[field] } : {}, { kind: "meta", id: field, name: field });
  }
  const counts = { added: 0, removed: 0, modified: 0 };
  for (const change of changes) counts[change.op]++;
  return { changes, counts };
}
