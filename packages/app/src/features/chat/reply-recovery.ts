type RecoveryMessage = { id: string; role: string; content: string };

/** Locate the exact user turn whose existing reply the client is waiting for. */
export function findReplyRecoveryAnchor(
  messages: readonly RecoveryMessage[],
  opts: { sentContent: string; lastMessageIdAtSend: string | null; retryMessageId?: string },
): number {
  if (opts.retryMessageId) {
    return messages.findIndex(message => message.id === opts.retryMessageId && message.role === "user");
  }
  const previousIndex = opts.lastMessageIdAtSend
    ? messages.findIndex(message => message.id === opts.lastMessageIdAtSend)
    : -1;
  for (let index = messages.length - 1; index > previousIndex; index--) {
    const message = messages[index];
    if (message.role === "user") return message.content === opts.sentContent ? index : -1;
  }
  return -1;
}

/** A reply to a replacement turn cannot settle recovery of the original choice. */
export function hasReplyAfterAnchor(messages: readonly RecoveryMessage[], anchorIndex: number): boolean {
  if (anchorIndex < 0 || messages.at(-1)?.role !== "assistant") return false;
  const next = messages.slice(anchorIndex + 1).find(message => message.role !== "system");
  return next?.role === "assistant";
}
