export const INITIAL_CHAT_ROWS = 50;
export const MAX_CHAT_ROWS = 100;
const WINDOW_STEP = 50;

export interface ChatHistoryWindow {
  firstId: string;
  lastId: string;
  size: number;
  followLatest: boolean;
}
export interface ChatHistoryRange { start: number; end: number }
export type ChatHistoryEdge = "oldest" | "newest";
type Row = { id?: unknown };

/** IDs keep a reading window stable when the server prepends or edits rows. */
export function chatHistoryRange(rows: readonly Row[], selection: ChatHistoryWindow | null): ChatHistoryRange {
  const size = Math.min(MAX_CHAT_ROWS, selection?.size ?? INITIAL_CHAT_ROWS);
  if (!selection || selection.followLatest) return { start: Math.max(0, rows.length - size), end: rows.length };
  const first = rows.findIndex(row => row.id === selection.firstId);
  const last = rows.findIndex(row => row.id === selection.lastId);
  if (first >= 0) return { start: first, end: Math.min(rows.length, first + MAX_CHAT_ROWS, last >= first ? last + 1 : first + size) };
  if (last >= 0) return { start: Math.max(0, last + 1 - size), end: last + 1 };
  // A revert/branch may remove both boundaries. Use the surviving latest page.
  return { start: Math.max(0, rows.length - INITIAL_CHAT_ROWS), end: rows.length };
}

export function selectChatHistory(rows: readonly Row[], range: ChatHistoryRange, followLatest = false): ChatHistoryWindow | null {
  const first = rows[range.start], last = rows[range.end - 1];
  return typeof first?.id === "string" && typeof last?.id === "string"
    ? { firstId: first.id, lastId: last.id, size: Math.min(MAX_CHAT_ROWS, range.end - range.start), followLatest } : null;
}

export function shiftChatHistory(rows: readonly Row[], range: ChatHistoryRange, direction: -1 | 1): ChatHistoryWindow | null {
  const start = direction < 0 ? Math.max(0, range.start - WINDOW_STEP) : Math.max(0, Math.min(rows.length, range.end + WINDOW_STEP) - MAX_CHAT_ROWS);
  const end = direction < 0 ? Math.min(rows.length, start + MAX_CHAT_ROWS) : Math.min(rows.length, range.end + WINDOW_STEP);
  // Window navigation preserves the reading anchor; reaching the newest data
  // is not the same as the reader reaching its physical bottom.
  return selectChatHistory(rows, { start, end });
}

/** Jump only within data the host already loaded; never request server history. */
export function jumpChatHistory(rows: readonly Row[], edge: ChatHistoryEdge): ChatHistoryWindow | null {
  const range = edge === "oldest" ? { start: 0, end: Math.min(rows.length, MAX_CHAT_ROWS) }
    : { start: Math.max(0, rows.length - MAX_CHAT_ROWS), end: rows.length };
  return selectChatHistory(rows, range, edge === "newest");
}

export function chatHistoryAround(rows: readonly Row[], anchorId: string): ChatHistoryWindow | null {
  const index = rows.findIndex(row => row.id === anchorId);
  if (index < 0) return null;
  const start = Math.max(0, Math.min(index - Math.floor(MAX_CHAT_ROWS / 2), rows.length - MAX_CHAT_ROWS));
  return selectChatHistory(rows, { start, end: Math.min(rows.length, start + MAX_CHAT_ROWS) });
}
