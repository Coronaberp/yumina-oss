import { messagePassages } from "./passages";

/** Optional backgrounds, keyed by [SCENE:id] or the current-scene variable.
 * Example: gardens: { day: "@asset:ID", evening: "@asset:ID" }
 * A single @asset:… string is also supported for a scene.
 */
export const scenes = {};
// Opening-specific collections are keyed by the stable greeting entry ID.
export const openingScenes = {};

function previousScene(api, message) {
  const messages = api.messages || [];
  const boundary = message ? messages.findIndex(item => item.id === message.id) : messages.length;
  for (let index = boundary - 1; index >= 0; index--) {
    if (messages[index].role !== "assistant") continue;
    const scene = messagePassages(api, messages[index]).findLast(passage => passage.scene)?.scene;
    if (scene) return scene;
  }
}

export function backgroundFor(api, line, message) {
  const messages = api.messages || [];
  let openingId;
  for (let index = messages.length - 1; index >= 0; index--) {
    const id = messages[index].stateSnapshot?.activeGreetingId;
    if (messages[index].role === "assistant" && (typeof id === "string" || id === null)) {
      openingId = messages[index].stateSnapshot.activeGreetingId;
      break;
    }
  }
  if (openingId === undefined && !api.hasEarlierMessages) {
    const greetings = (api.entries || []).filter(entry => entry.role === "greeting" && entry.enabled !== false)
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
    const opening = messages.find(message => message.role === "assistant");
    openingId = greetings[opening?.activeSwipeIndex || 0]?.id;
  }
  const collection = openingScenes[openingId] || {};
  const sceneId = line?.scene || api.variables?.["current-scene"] || previousScene(api, message);
  const period = api.variables?.["current-period"];
  const image = value => typeof value === "string" ? value : value?.[period] || value?.day;
  const openingFallback = sceneId ? collection[sceneId] : collection.opening;
  return image(openingFallback) || image(scenes[sceneId])
    || image(collection.default) || image(scenes.default)
    || api.variables?.["scene-bg"] || api.variables?.scene_bg || api.variables?.current_bg;
}
