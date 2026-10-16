/** Apply before emphasis, after code and HTML embeds have been protected. */
export function renderChatThematicBreaks(html: string): string {
  // A whole line of three or more matching markers; never consume newlines
  // or turn punctuation within prose, code, or image attributes into rules.
  return html.replace(
    /^ {0,3}(?:-(?:[\t ]*-){2,}|\*(?:[\t ]*\*){2,}|_(?:[\t ]*_){2,})[\t ]*\r?$/gm,
    '<hr class="border-0 border-t border-border/60" />',
  );
}
