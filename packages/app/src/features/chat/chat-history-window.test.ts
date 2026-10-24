import assert from "node:assert/strict";
import test from "node:test";
import * as history from "../../../sandbox/chat/chat-history-window";
import {
  chatHistoryRange, shiftChatHistory, MAX_CHAT_ROWS, INITIAL_CHAT_ROWS,
  type ChatHistoryWindow,
} from "../../../sandbox/chat/chat-history-window";

test("working-set windows leave all 1000 saved messages reachable in both directions", () => {
  const saved = Object.freeze(Array.from({ length: 1000 }, (_, index) => Object.freeze({
    id: `saved-${index}`, content: `Original saved message ${index}`,
  })));
  const api = { messages: saved };
  const original = saved.map(row => ({ ...row }));
  const expectedIds = saved.map(row => row.id);
  let selection: ChatHistoryWindow | null = null;
  let range = chatHistoryRange(api.messages, selection);
  const olderIds = new Set<string>(), newerIds = new Set<string>();
  const visit = (target: Set<string>) => {
    assert.ok(range.end - range.start <= MAX_CHAT_ROWS, "Only the mounted working set is bounded");
    for (const row of api.messages.slice(range.start, range.end)) target.add(row.id);
  };

  assert.equal(range.end - range.start, INITIAL_CHAT_ROWS);
  visit(olderIds);
  while (range.start > 0) {
    const previous = range.start;
    selection = shiftChatHistory(api.messages, range, -1);
    range = chatHistoryRange(api.messages, selection);
    assert.ok(range.start < previous, "Every older action makes progress");
    visit(olderIds);
  }
  assert.deepEqual([...olderIds].sort(), [...expectedIds].sort(), "Every saved ID is reachable while moving older");

  visit(newerIds);
  while (range.end < api.messages.length) {
    const previous = range.end;
    selection = shiftChatHistory(api.messages, range, 1);
    range = chatHistoryRange(api.messages, selection);
    assert.ok(range.end > previous, "Every newer action makes progress");
    visit(newerIds);
  }
  assert.deepEqual([...newerIds].sort(), [...expectedIds].sort(), "Every saved ID is reachable while moving newer");
  assert.equal(api.messages, saved, "The source API array keeps its identity");
  assert.equal(api.messages.length, 1000, "The working-set bound never truncates saved messages");
  assert.deepEqual(api.messages, original, "All saved IDs, order and contents remain exact");
});

test("explicit loaded-history jumps bound working rows and preserve every saved source row", () => {
  assert.equal(typeof history.jumpChatHistory, "function");
  const rows = Object.freeze(Array.from({length:1000},(_,n)=>Object.freeze({id:`m${n}`,content:`Saved ${n}`})));
  const original = rows.map(row=>({...row}));
  const oldest = history.jumpChatHistory(rows,"oldest");
  assert.deepEqual(chatHistoryRange(rows,oldest),{start:0,end:100});
  assert.equal(oldest?.followLatest,false);
  assert.deepEqual(chatHistoryRange(rows,shiftChatHistory(rows,chatHistoryRange(rows,oldest),1)),{start:50,end:150});
  const newest = history.jumpChatHistory(rows,"newest");
  assert.deepEqual(chatHistoryRange(rows,newest),{start:900,end:1000});
  assert.equal(newest?.followLatest,true);
  const appended = [...rows,...Array.from({length:100},(_,n)=>({id:`m${n+1000}`,content:"New"}))];
  assert.deepEqual(chatHistoryRange(appended,oldest),{start:0,end:100});
  assert.deepEqual(chatHistoryRange(appended,newest),{start:1000,end:1100});
  assert.deepEqual(chatHistoryRange(rows,shiftChatHistory(rows,chatHistoryRange(rows,newest),-1)),{start:850,end:950});
  assert.deepEqual(chatHistoryRange(rows.slice(0,25),history.jumpChatHistory(rows.slice(0,25),"oldest")),{start:0,end:25});
  assert.equal(history.jumpChatHistory([],"oldest"),null); assert.equal(history.jumpChatHistory([],"newest"),null);
  assert.deepEqual(rows,original,"navigation leaves all saved IDs, order and content intact");
});
