/** Classification metadata is not a visible edit or generation baseline. */
export function withoutContentFlags<T extends { contentFlags?: unknown }>(swipes: T[] | null): Omit<T, "contentFlags">[] | null {
  return swipes?.map(({ contentFlags: _flag, ...rest }) => rest) ?? null;
}
