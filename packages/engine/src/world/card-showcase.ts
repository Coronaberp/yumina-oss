import { z } from "zod";

export const CARD_SHOWCASE_HTML_LIMIT = 100_000;
export const CARD_SHOWCASE_CSS_LIMIT = 30_000;

/** Creator-authored public presentation, independent of the playable interface. */
export const cardShowcaseSchema = z.object({
  html: z.string().max(CARD_SHOWCASE_HTML_LIMIT).default(""),
  css: z.string().max(CARD_SHOWCASE_CSS_LIMIT).default(""),
}).strict();

export type CardShowcase = z.infer<typeof cardShowcaseSchema>;

export function readCardShowcase(value: unknown): CardShowcase {
  return cardShowcaseSchema.parse(value ?? {});
}

/** Replace only supplied fields; clearing CSS keeps the public HTML intact. */
export function updateCardShowcase(value: unknown, patch: Partial<CardShowcase>): CardShowcase {
  return cardShowcaseSchema.parse({ ...readCardShowcase(value), ...patch });
}
