import { and, eq, desc, sql } from "drizzle-orm";
import { GameStateManager, PromptBuilder, type GameState, type WorldDefinition } from "@yumina/engine";
import { db } from "../db/index.js";
import { messages } from "../db/schema.js";
import { resolveStoryWardrobes, type WardrobeBranchMessage } from "./story-sprite-wardrobe.js";

type Selection = { type: string; variant: string };
type Selections = Record<string, Selection>;
type Row = {
  id: string; role: string; content: string; createdAt: Date | null;
  status?: string | null; model?: string | null; activeSwipeIndex?: number | null;
  stateSnapshot?: Record<string, unknown> | null;
  swipes?: Array<{ content?: string; rawContent?: string }> | null;
};
export type SpriteWardrobeSnapshot = {
  version: 1; openingId: string | null; before: Selections; after: Selections; activeSwipeIndex: number;
};
const selections = (items: ReturnType<typeof resolveStoryWardrobes>): Selections =>
  Object.fromEntries(items.map(({ name, type, variant }) => [name, { type, variant }]));
const rawMessage = (row: Row): WardrobeBranchMessage => ({
  role: row.role, content: row.content, stateSnapshot: row.stateSnapshot,
  rawContent: row.swipes?.[row.activeSwipeIndex ?? 0]?.rawContent,
});

/** Pure page replay. Only before is exposed to the current reading cursor;
 * after is useful for subsequent replies and never reveals a future passage. */
export function replayStoryWardrobePage<T extends Row>(args: {
  world: WorldDefinition; rows: readonly T[]; openingId: string | null; initialSelections?: Selections;
}): Array<T & { spriteWardrobeSnapshot?: SpriteWardrobeSnapshot }> {
  const state = new GameStateManager(args.world).getSnapshot();
  let openingId = args.openingId;
  state.activeGreetingId = openingId;
  let current = selections(resolveStoryWardrobes({world:args.world,state,branchMessages:[],initialSelections:args.initialSelections,allCharacters:true}));
  return args.rows.map(row => {
    if (row.role !== "assistant" || row.status && row.status !== "complete") return row;
    const id = row.stateSnapshot?.activeGreetingId;
    if ((typeof id === "string" || id === null) && id !== openingId) {
      openingId = id;
      state.activeGreetingId = id;
      current = selections(resolveStoryWardrobes({world:args.world,state,branchMessages:[],allCharacters:true}));
    }
    const before = selections(resolveStoryWardrobes({world:args.world,state,branchMessages:[],initialSelections:current,allCharacters:true}));
    const after = selections(resolveStoryWardrobes({world:args.world,state,branchMessages:[rawMessage(row)],initialSelections:before,allCharacters:true}));
    current = after;
    return {...row,spriteWardrobeSnapshot:{version:1,openingId,before,after,activeSwipeIndex:row.activeSwipeIndex ?? 0}};
  });
}

/** Reconstruct the earliest page's accepted baseline, then replay the bounded
 * page once. Old compacted/pruned rows remain readable without changing stored
 * snapshots or granting a partial visual record game-state restore semantics. */
export async function hydrateStoryWardrobePage<T extends Row>(args: {
  sessionId: string; world: WorldDefinition; rows: readonly T[]; database?: typeof db;
}): Promise<Array<T & { spriteWardrobeSnapshot?: SpriteWardrobeSnapshot }>> {
  if (args.world.rootComponent?.interfaceId !== "vn" || !args.rows.length) return [...args.rows];
  const database = args.database ?? db;
  const first = args.rows[0]!;
  const orderedTime = sql`COALESCE(${messages.createdAt},'1970-01-01'::timestamp)`;
  // The opening comes from the actual first accepted reply, never live session
  // state (which can describe a different point on the selected timeline).
  const [greeting] = await database.select({id:messages.id,model:messages.model,activeSwipeIndex:messages.activeSwipeIndex,stateSnapshot:messages.stateSnapshot})
    .from(messages).where(and(eq(messages.sessionId,args.sessionId),eq(messages.role,"assistant"),eq(messages.status,"complete")))
    .orderBy(orderedTime,messages.id).limit(1);
  const greetingId = (greeting?.stateSnapshot as Record<string,unknown> | null)?.activeGreetingId;
  let openingId: string | null = typeof greetingId === "string" || greetingId === null ? greetingId
    : greeting && !greeting.model ? new PromptBuilder().buildGreetingEntries(args.world)[greeting.activeSwipeIndex ?? 0]?.id ?? null : null;
  const pageFirstAssistant = args.rows.find(row=>row.role === "assistant");
  // Its own snapshot is valid historical evidence at the page boundary.
  const pageOpening = pageFirstAssistant?.stateSnapshot?.activeGreetingId;
  if (typeof pageOpening === "string" || pageOpening === null) openingId = pageOpening;
  const state = new GameStateManager(args.world).getSnapshot();
  state.activeGreetingId = openingId;
  const unresolved = new Set(resolveStoryWardrobes({world:args.world,state,branchMessages:[],allCharacters:true}).map(item=>item.name));
  const selected: WardrobeBranchMessage[] = [];
  let cursor: {id:string;createdAt:Date|null} = first;
  let stopped = false;
  while (unresolved.size && !stopped) {
    const rows = await database.select({
      id:messages.id,role:messages.role,content:messages.content,createdAt:messages.createdAt,stateSnapshot:messages.stateSnapshot,
      rawContent:sql<string>`COALESCE(${messages.swipes}->(COALESCE(${messages.activeSwipeIndex},0))->>'rawContent',${messages.content})`,
    }).from(messages).where(and(eq(messages.sessionId,args.sessionId),eq(messages.role,"assistant"),eq(messages.status,"complete"),
      sql`(${orderedTime},${messages.id}) < (${cursor.createdAt?.toISOString() ?? '1970-01-01'}::timestamp,${cursor.id})`,
    )).orderBy(desc(orderedTime),desc(messages.id)).limit(128);
    if (!rows.length) break;
    for (const row of rows) {
      const id = (row.stateSnapshot as Record<string,unknown> | null)?.activeGreetingId;
      if ((typeof id === "string" || id === null) && id !== openingId) { stopped = true; break; }
      const resolved = resolveStoryWardrobes({world:args.world,state,branchMessages:[row],allCharacters:true});
      const latest = resolved.filter(item=>item.observed && unresolved.has(item.name));
      if (latest.length) { selected.push(row); latest.forEach(item=>unresolved.delete(item.name)); }
      if (row.content.includes("[CHARACTER_CREATE]")) { stopped = true; break; }
      if (!unresolved.size) break;
    }
    cursor = rows.at(-1)!;
    if (rows.length < 128) break;
  }
  const baseline = selections(resolveStoryWardrobes({world:args.world,state,branchMessages:selected.reverse(),allCharacters:true}));
  return replayStoryWardrobePage({world:args.world,rows:args.rows,openingId,initialSelections:baseline});
}
