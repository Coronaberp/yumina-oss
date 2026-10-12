import { and, asc, eq, sql } from "drizzle-orm";
import { CONTENT_FLAG_POLICY_ID, CONTENT_FLAG_VERSION, conservativeLabel, conservativeRoutingSafe, type ContentFlagAudit } from "@yumina/shared";
import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { createPendingContentFlags, sourceHash, type FlagRole } from "./content-flag-policy.js";
import { kevContentClassifier } from "./kev-content-classifier.js";

type Database = typeof db;
type Message = typeof messages.$inferSelect;
type Classifier = { classify(role: FlagRole, content: string, choices?: readonly string[]): Promise<ContentFlagAudit> };
const canClassify = (row: Message) => row.role === "user" || (row.role === "assistant" && row.status === "complete");

function visibleSource(row: Message) {
  const index = row.role === "assistant" && row.swipes?.length ? row.activeSwipeIndex ?? 0 : null;
  const choices = index === null ? [] : row.swipes?.[index]?.choices ?? [];
  return { index, role: row.role, content: row.content, choices, hash: sourceHash(row.role, row.content, choices) };
}

/** Callers must compare source hashes before using a stored result for routing. */
export function currentContentFlag(row: Message): ContentFlagAudit | null {
  const flag = row.contentFlags;
  if (!flag || flag.policyId !== CONTENT_FLAG_POLICY_ID || flag.version !== CONTENT_FLAG_VERSION) return null;
  if (flag.status === "pending" && flag.sourceHash === "") return flag;
  if (row.role === "assistant" && row.status === "failed" && flag.status === "error" && flag.errorCode === "incomplete_response") return flag;
  return flag.sourceHash === visibleSource(row).hash ? flag : null;
}

export function contentFlagTurn(rows: Message[]) {
  const input = [...rows].reverse().find(row => row.role === "user");
  const output = [...rows].reverse().find(row => row.role === "assistant");
  // An output from before the current input cannot certify the new turn.
  const ordered = input && output && output.status === "complete" && rows.indexOf(output) > rows.indexOf(input);
  const safe = Boolean(ordered && conservativeLabel(currentContentFlag(input!)) === "sfw" && conservativeLabel(currentContentFlag(output!)) === "sfw");
  const routingSafe = Boolean(ordered && conservativeRoutingSafe(currentContentFlag(input!)) && conservativeRoutingSafe(currentContentFlag(output!)));
  return { label: safe ? "sfw" as const : "nsfw" as const, routingSafe, inputMessageId: input?.id ?? null, outputMessageId: ordered ? output?.id ?? null : null };
}

export function createContentFlagService(database: Database, classifier: Classifier = kevContentClassifier) {
  const queued = new Set<string>();
  let chain = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let sweeping = false;

  const writeFlag = async (tx: Parameters<Parameters<Database["transaction"]>[0]>[0], row: Message, index: number | null, audit: ContentFlagAudit) => {
    if (index === null) {
      await tx.update(messages).set({ contentFlags: audit }).where(eq(messages.id, row.id));
    } else {
      const swipes = row.swipes!.map((item, i) => i === index ? { ...item, contentFlags: audit } : item);
      await tx.update(messages).set({ swipes }).where(eq(messages.id, row.id));
    }
  };

  const run = async (id: string) => {
    const captured = await database.transaction(async tx => {
      const [row] = await tx.select().from(messages).where(eq(messages.id, id)).for("update");
      if (!row || !canClassify(row)) return null;
      const source = visibleSource(row);
      if (source.index !== null && !row.swipes?.[source.index]) return null;
      const flag = currentContentFlag(row);
      if (flag && flag.status !== "pending") return null;
      const pending = createPendingContentFlags(source.role, source.content, source.choices);
      if (source.index !== null && row.swipes?.[source.index]?.content !== source.content) {
        await writeFlag(tx, row, source.index, { ...pending, status: "error", completedAt: new Date().toISOString(), errorCode: "message_variant_mismatch" });
        return null;
      }
      await writeFlag(tx, row, source.index, pending);
      return { ...source, pending };
    });
    if (!captured) return;
    let audit: ContentFlagAudit;
    try {
      audit = await classifier.classify(captured.role, captured.content, captured.choices);
    } catch {
      audit = { ...captured.pending, status: "error", label: "nsfw", routingSafe: false, completedAt: new Date().toISOString(), errorCode: "classifier_failed" };
    }
    audit = { ...audit, sourceHash: captured.hash, requestId: captured.pending.requestId, startedAt: captured.pending.startedAt };
    await database.transaction(async tx => {
      const [row] = await tx.select().from(messages).where(eq(messages.id, id)).for("update");
      if (!row || row.role !== captured.role || !canClassify(row)) return;
      // Check the captured variant even if the user has selected another one.
      const content = captured.index === null ? row.content : row.swipes?.[captured.index]?.content;
      const choices = captured.index === null ? [] : row.swipes?.[captured.index]?.choices ?? [];
      const flag = captured.index === null ? row.contentFlags : row.swipes?.[captured.index]?.contentFlags;
      if (content === undefined || sourceHash(row.role, content, choices) !== captured.hash
        || flag?.sourceHash !== captured.hash || flag.requestId !== captured.pending.requestId || flag.startedAt !== captured.pending.startedAt) return;
      await writeFlag(tx, row, captured.index, audit);
    });
  };

  const enqueue = (id: string): boolean => {
    if (stopped || queued.has(id) || queued.size >= 32) return false;
    queued.add(id);
    chain = chain.then(() => run(id)).catch(() => {
      // Database failures leave durable pending rows for the next sweep.
    }).finally(() => { queued.delete(id); });
    return true;
  };
  const recover = async (): Promise<void> => {
    if (stopped || sweeping) return;
    sweeping = true;
    try {
      const rows = await database.select({ id: messages.id }).from(messages)
        .where(and(sql`(${messages.role} = 'user' OR (${messages.role} = 'assistant' AND ${messages.status} = 'complete'))`, sql`(${messages.contentFlags}->>'status' = 'pending' OR ${messages.contentFlags}->>'policyId' IS DISTINCT FROM ${CONTENT_FLAG_POLICY_ID} OR ${messages.contentFlags}->>'version' IS DISTINCT FROM ${String(CONTENT_FLAG_VERSION)})`))
        .orderBy(asc(messages.createdAt), asc(messages.id)).limit(32);
      for (const row of rows) enqueue(row.id);
    } finally { sweeping = false; }
  };
  const retry = async (id: string): Promise<void> => {
    await database.transaction(async tx => {
      const [row] = await tx.select().from(messages).where(eq(messages.id, id)).for("update");
      if (!row || !canClassify(row)) return;
      const source = visibleSource(row);
      await writeFlag(tx, row, source.index, createPendingContentFlags(source.role, source.content, source.choices));
    });
    // If already in flight, its old nonce fails CAS and recovery picks this up.
    enqueue(id);
  };
  return {
    enqueue, recover, retry,
    async waitForIdle() { while (queued.size) await chain; },
    start() {
      if (timer || stopped) return;
      void recover().catch(() => {});
      timer = setInterval(() => { void recover().catch(() => {}); }, 3000);
      timer.unref();
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; },
  };
}

export const contentFlagService = createContentFlagService(db);
