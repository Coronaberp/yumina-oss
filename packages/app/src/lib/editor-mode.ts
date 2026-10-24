/** Lightweight preference reads for routes that have not loaded an editor yet. */
const EDITOR_MODE_KEY = "yumina-editor-mode";
const GLOBAL_MODE_KEY = "yumina-editor-mode-global";

export function saveEditorMode(worldId: string, mode: "simple" | "advanced") {
  try {
    const data = JSON.parse(localStorage.getItem(EDITOR_MODE_KEY) || "{}");
    data[worldId] = mode;
    localStorage.setItem(EDITOR_MODE_KEY, JSON.stringify(data));
  } catch {
    /* Storage is optional. */
  }
}

export function getEditorMode(worldId: string): "simple" | "advanced" | null {
  try {
    const data = JSON.parse(localStorage.getItem(EDITOR_MODE_KEY) || "{}");
    return data[worldId] ?? null;
  } catch {
    return null;
  }
}

export function getGlobalEditorMode(): "simple" | "advanced" | null {
  try {
    const val = localStorage.getItem(GLOBAL_MODE_KEY);
    return val === "simple" || val === "advanced" ? val : null;
  } catch {
    return null;
  }
}

export function saveGlobalEditorMode(mode: "simple" | "advanced") {
  try {
    localStorage.setItem(GLOBAL_MODE_KEY, mode);
  } catch {
    /* Storage is optional. */
  }
}
