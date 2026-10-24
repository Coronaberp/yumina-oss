export type PreviewJsonKind = "text" | "number" | "boolean" | "list" | "group" | "empty";
export type PreviewJsonPath = (string | number)[];

export function emptyStatusPreviewJson(kind: PreviewJsonKind): unknown {
  switch (kind) {
    case "text": return "";
    case "number": return 0;
    case "boolean": return false;
    case "list": return [];
    case "group": return {};
    case "empty": return null;
  }
}

/** Form paths are literal keys, never executable code or dotted expressions. */
export function editStatusPreviewJson(source: unknown, path: PreviewJsonPath, value: unknown, remove = false): unknown {
  if (!path.length) return remove ? null : value;
  if (!source || typeof source !== "object") throw new Error("Open an existing group or list first.");
  const [key, ...rest] = path;
  if (Array.isArray(source)) {
    if (typeof key !== "number" || !Number.isInteger(key) || key < 0 || key > source.length || (rest.length || remove) && key === source.length) throw new Error("Choose an existing list entry.");
    const copy = [...source];
    if (remove && !rest.length) copy.splice(key, 1);
    else copy[key] = rest.length ? editStatusPreviewJson(source[key], rest, value, remove) : value;
    return copy;
  }
  if (typeof key !== "string" || rest.length && !Object.hasOwn(source, key)) throw new Error("Choose an existing field.");
  const copy = { ...source } as Record<string, unknown>;
  if (remove && !rest.length) delete copy[key];
  else Object.defineProperty(copy, key, { enumerable: true, writable: true, configurable: true,
    value: rest.length ? editStatusPreviewJson((source as Record<string, unknown>)[key], rest, value, remove) : value });
  return copy;
}
