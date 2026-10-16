/** Openings and their chapter groups can only be picked before play begins.
 * Inspect history as well as session markers so legacy and paged saves stay locked. */
export function canSelectStoryOpening(state: {
  session: { state?: { turnCount?: number }; personaSelectable?: boolean; sessionPersona?: { started?: boolean } | null } | null;
  messages: readonly { role: string; model?: string | null; swipes?: unknown[] }[];
  isStreaming: boolean;
  readOnly: boolean;
  hasEarlierMessages: boolean;
}): boolean {
  if (!state.session || state.readOnly || state.isStreaming || state.hasEarlierMessages || state.session.personaSelectable === false || state.session.sessionPersona?.started || Number(state.session.state?.turnCount ?? 0) > 0) return false;
  const messages = state.messages.filter(message => message.role !== "system");
  return messages.length === 1 && messages[0]?.role === "assistant" && !messages[0].model && !!messages[0].swipes?.length;
}
