import { z } from "zod";

export const NAME_STYLE_KEYS = ["japanese", "romance", "germanic", "slavic", "celtic", "arabic", "nordic", "finnic", "persian"] as const;
const affix = z.string().max(40).regex(/^[A-Za-z'-]*$/, "Phonetic affixes use Latin letters, apostrophes or hyphens.");
export const nameConstraintsSchema = z.object({
  minLength: z.number().int().min(3).max(40).optional(),
  maxLength: z.number().int().min(3).max(40).optional(),
  minSyllables: z.number().int().min(1).max(12).optional(),
  maxSyllables: z.number().int().min(1).max(12).optional(),
  prefix: affix.optional(), suffix: affix.optional(),
}).strict().superRefine((value, ctx) => {
  // An override can supply one side; validate defaults after profile merging.
  if (value.minLength !== undefined && value.maxLength !== undefined && value.minLength > value.maxLength) ctx.addIssue({ code: "custom", message: "Minimum length exceeds maximum length." });
  if (value.minSyllables !== undefined && value.maxSyllables !== undefined && value.minSyllables > value.maxSyllables) ctx.addIssue({ code: "custom", message: "Minimum syllable count exceeds maximum." });
});
const fragments = z.array(z.tuple([z.string().max(20).regex(/^[A-Za-z'-]*$/), z.number().int().positive().max(1000)])).min(1).max(200);
export const namePhoneticsSchema = z.object({
  starts: fragments.optional(), middles: fragments.optional(),
  endings: z.object({ masculine: fragments.optional(), feminine: fragments.optional(), neutral: fragments.optional() }).strict().optional(),
  syllableWeights: z.array(z.number().int().positive().max(1000)).min(1).max(8).optional(),
  joiners: z.array(z.string().max(1).regex(/^[-']?$/)).min(1).max(3).optional(),
}).strict();
const literalName = z.string().trim().min(1).max(60).regex(/^[\p{L}\p{M}'’ -]+$/u, "Use letters, spaces, apostrophes or hyphens.");
export const nameGeneratorOptionsSchema = z.object({
  style: z.enum([...NAME_STYLE_KEYS, "random"]).optional(),
  surnameStyle: z.enum(NAME_STYLE_KEYS).optional(),
  gender: z.enum(["masculine", "feminine", "neutral"]).optional(),
  weirdness: z.number().min(0).max(1).optional(),
  format: z.enum(["given", "surname", "full"]).optional(),
  order: z.enum(["given-family", "family-given"]).optional(),
  surname: literalName.optional(), particle: literalName.optional(),
  constraints: nameConstraintsSchema.optional(), surnameConstraints: nameConstraintsSchema.optional(),
  maxFullLength: z.number().int().min(3).max(120).optional(),
  avoidSimilar: z.boolean().optional(),
  phonetics: namePhoneticsSchema.optional(),
}).strict();
export const nameGeneratorProfileSchema = nameGeneratorOptionsSchema.extend({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  label: z.string().trim().min(1).max(80),
  region: z.string().max(80).optional(), species: z.string().max(80).optional(),
  clan: z.string().max(80).optional(), family: z.string().max(80).optional(),
}).strict();
export const nameGeneratorProfilesSchema = z.array(nameGeneratorProfileSchema).max(100).superRefine((profiles, ctx) => {
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) ctx.addIssue({ code: "custom", message: "Culture profile IDs must be unique." });
});
export type NameConstraints = z.infer<typeof nameConstraintsSchema>;
export type NamePhonetics = z.infer<typeof namePhoneticsSchema>;
export type NameGeneratorProfile = z.infer<typeof nameGeneratorProfileSchema>;
