/** Persona selection belongs only to the original, uncontinued greeting. */
export function canSelectPersona(api) {
  if (!api.sessionId || api.readOnly || api.isStreaming || api.hasEarlierMessages || api.personaSelectable !== true) return false;
  const messages = (api.messages || []).filter(message => message.role !== "system");
  const opening = messages[0];
  const swipe = opening?.swipes?.[opening.activeSwipeIndex || 0];
  return messages.length === 1 && opening?.role === "assistant" && opening.model == null && swipe?.model == null;
}
