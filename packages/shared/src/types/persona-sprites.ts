import { z } from "zod";

export const personaSpriteExpressions = ["normal", "happy", "sad", "angry", "shy", "smug"] as const;
export type PersonaSpriteExpression = typeof personaSpriteExpressions[number];

const spriteRef = z.string().trim().min(1).max(2048);

/** Optional uploaded cutouts used by the VN stage for the player character. */
export const personaSpritesSchema = z.object({
  normal: spriteRef.optional(),
  happy: spriteRef.optional(),
  sad: spriteRef.optional(),
  angry: spriteRef.optional(),
  shy: spriteRef.optional(),
  smug: spriteRef.optional(),
}).strict();

export type PersonaSprites = Partial<Record<PersonaSpriteExpression, string>>;
