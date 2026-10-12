/** Zero-width spaces are discarded from story text, never kept as metadata padding. */
export function stripZeroWidthSpaces(text: string): string {
  return text.replace(/\u200B/g, "");
}
