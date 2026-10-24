export const SCENE_IN_VARIABLE_UPDATES_CODE = "scene-in-variable-updates";
export const SCENE_IN_VARIABLE_UPDATES_FIX = "Move [SCENE:...] presentation instructions outside <variable-updates>, for example into a separate sibling <vn-scene-presentation> block. Keep 'emit nothing if no tracked value changed' limited to state updates.";

/** Detect only the known presentation/state-scope conflict, not general markup.
 * An unclosed variable-updates opening still scopes the following instructions.
 * Depth handles a nested opening without letting its first close hide the rest.
 */
export function hasSceneInVariableUpdates(content: string): boolean {
  const tokens = /<\s*(\/?)\s*variable-updates(?=[\s/>])[^>]*>|\[\s*SCENE\s*:/gi;
  let depth = 0;
  for (const match of content.matchAll(tokens)) {
    if (match[0].startsWith("[")) {
      if (depth > 0) return true;
    } else if (match[1]) {
      depth = Math.max(0, depth - 1);
    } else if (!/\/\s*>$/.test(match[0])) {
      depth++;
    }
  }
  return false;
}
