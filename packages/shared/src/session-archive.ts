import { z } from "zod";

// Reserve space for base64 and authored source below the browser string limit.
export const ARCHIVE_MAX_FILE_BYTES = 512 * 1024 * 1024;
export const ARCHIVE_MAX_MEDIA_BYTES = 350 * 1024 * 1024;
export const ARCHIVE_MAX_ASSET_BYTES = 100 * 1024 * 1024;

const jsonRecord = z.record(z.unknown());
const timestamp = z.string().datetime({ offset: true });
const attachment = z.object({ type: z.string(), mimeType: z.string(), name: z.string(), url: z.string() });
const swipe = z.object({ content: z.string(), createdAt: timestamp }).passthrough();
export const archiveMessageSchema = z.object({
  id: z.string().min(1), role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(2_000_000), createdAt: timestamp,
  attachments: z.array(attachment).nullable().optional(),
  swipes: z.array(swipe).nullable().optional(),
  activeSwipeIndex: z.number().int().nonnegative().nullable().optional(),
}).passthrough();

export const sessionArchiveSchema = z.object({
  format: z.literal("yumina-chat"), version: z.literal(1),
  mode: z.enum(["transcript", "full-save"]), exportedAt: timestamp,
  session: z.object({ id: z.string(), name: z.string().nullable(), createdAt: timestamp, updatedAt: timestamp }),
  world: z.object({ id: z.string(), name: z.string(), description: z.string(), thumbnailUrl: z.string().nullable().optional(), schema: jsonRecord.optional() }),
  player: z.object({ name: z.string(), avatar: z.string().nullable() }),
  participants: z.array(z.object({ id: z.string(), name: z.string(), avatar: z.string().nullable() })).default([]),
  messages: z.array(archiveMessageSchema).max(50_000),
  display: z.array(z.object({ messageId: z.string(), speakerId: z.string(), kind: z.enum(["dialogue", "narration", "choice"]), text: z.string(), turn: z.number().int().nonnegative() })).default([]),
  assets: z.record(z.string().regex(/^data:(?:image\/(?:png|jpeg|webp|gif)|audio\/[\w.+-]+|video\/[\w.+-]+|font\/[\w.+-]+|application\/(?:octet-stream|font-[\w-]+|vnd\.ms-opentype)|text\/plain);base64,[A-Za-z0-9+/]*={0,2}$/)).default({}),
  restore: z.object({
    state: jsonRecord, persona: jsonRecord.nullable(), settings: jsonRecord,
    checkpoints: z.array(z.object({ id: z.string(), name: z.string(), state: jsonRecord, messages: z.array(archiveMessageSchema), summary: z.string().nullable(), createdAt: timestamp })),
    memories: z.array(z.object({ content: z.string(), category: z.enum(["event", "relationship", "fact", "decision", "item", "location", "agreement", "world_state"]), importance: z.number().int().min(0).max(10), createdAt: timestamp })),
    snippets: z.array(jsonRecord), continuityNotes: z.array(z.string()).default([]),
  }).optional(),
}).superRefine((archive, ctx) => {
  const ids = new Set<string>();
  for (const message of archive.messages) {
    if (ids.has(message.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate message IDs" });
    ids.add(message.id);
    if (message.swipes?.length && (message.activeSwipeIndex ?? 0) >= message.swipes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid selected reply" });
  }
  if (archive.mode === "full-save" && (!archive.restore || !archive.world.schema)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Full save is missing its world or restore data" });
  if (archive.mode === "transcript" && (archive.restore || archive.world.schema)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Transcript contains full-save data" });
  const participants = new Set(archive.participants.map(p => p.id));
  for (const row of archive.display) if (!ids.has(row.messageId) || !participants.has(row.speakerId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Dialogue refers to a missing message or speaker" });
});

export type SessionArchive = z.infer<typeof sessionArchiveSchema>;
export type ArchiveMode = SessionArchive["mode"];

// Match entire URLs before root-relative paths, including CDN key routes.
const mediaPattern = /@asset:[A-Za-z0-9_-]{8,}|(?:https?:\/\/[^\s"'<>\\/)]+)?\/(?:cdn\/(?:key\/[A-Za-z0-9_-]+|[A-Za-z0-9_-]{8,})|vn-assets\/[\w./%-]+\.[A-Za-z0-9]+)(?:\?[^\s"'<>\\)]+)?/g;
export function archiveMediaReferences(text: string): string[] {
  return [...text.matchAll(mediaPattern)].map(match => match[0]);
}
export function replaceArchiveMediaReferences(text: string, references: ReadonlyMap<string, string>): string {
  return text.replace(mediaPattern, source => references.get(source) ?? source);
}
