/** Normalize the executed page, including JSON's null/numeric-string coercion,
 * so the executor, repeat-read guard and activity label describe the same read. */
export function normalizeStudioVisualAuditPage(offset: unknown = 0, limit: unknown = 20): { offset: number; limit: number } {
  const numericOffset = Number(offset);
  const numericLimit = Number(limit);
  return {
    offset: Number.isFinite(numericOffset) ? Math.max(0, Math.floor(numericOffset)) : 0,
    limit: Number.isFinite(numericLimit) ? Math.min(20, Math.max(1, Math.floor(numericLimit))) : 20,
  };
}
