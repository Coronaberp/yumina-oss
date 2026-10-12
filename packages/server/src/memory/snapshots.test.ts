import assert from "node:assert/strict";
import test from "node:test";
import {
  settledPrefixHash,
  remapSnapshot,
  filterForgottenSnapshot,
} from "./snapshots.js";

test("same-session recovery preserves fact, batch and lineage identities", () => {
  const input = {
    sessions: [{ id: "s" }],
    memory_facts: [
      { id: "mf_1", session_id: "s", batch_id: "b_1", superseded_by: "mf_2" },
    ],
    memory_extract_batches: [{ id: "b_1", session_id: "s" }],
    memory_reinforce_log: [{ seq: 1, session_id: "s", fact_id: "mf_1" }],
  } as never;
  const recovered = remapSnapshot(input, "s");
  assert.equal(recovered.memory_facts[0]?.id, "mf_1");
  assert.equal(recovered.memory_extract_batches[0]?.id, "b_1");
  assert.equal(recovered.memory_facts[0]?.superseded_by, "mf_2");
  assert.equal(recovered.memory_reinforce_log[0]?.seq, 1);
  recovered.memory_facts[0]!.id = "changed";
  assert.equal(
    (input as { memory_facts: { id: string }[] }).memory_facts[0]?.id,
    "mf_1",
  );
});

test("snapshot remapping keeps lineage and supersession branch-local without future batches", () => {
  const data = {
    memory_facts: [
      {
        id: "old",
        session_id: "s",
        batch_id: "b",
        superseded_by: "new",
        text: "old",
      },
      {
        id: "new",
        session_id: "s",
        batch_id: "b",
        superseded_by: null,
        text: "new",
      },
    ],
    memory_extract_batches: [{ id: "b", session_id: "s" }],
    memory_clusters: [
      { id: "cluster", session_id: "s", source_batch_ids: '["b"]' },
    ],
    memory_cluster_items: [
      { id: "item", cluster_id: "cluster", fact_id: "old" },
    ],
    sessions: [{ id: "s", user_id: "u" }],
    memory_extract_cursors: [{ session_id: "s", settled_exchanges: 5 }],
    session_secret_reveals: [{ id: "r", session_id: "s", fact_id: "new" }],
  } as never;
  const remapped = remapSnapshot(data, "branch");
  assert.notEqual(remapped.memory_facts[0]?.id, "old");
  assert.equal(
    remapped.memory_facts[0]?.superseded_by,
    remapped.memory_facts[1]?.id,
  );
  assert.equal(
    remapped.memory_cluster_items[0]?.fact_id,
    remapped.memory_facts[0]?.id,
  );
  assert.equal(remapped.sessions[0]?.id, "branch");
});
test("settled snapshot hashes survive copied message ids but reject edited content", () => {
  const rows = [
    { id: "a", role: "user", content: "ask" },
    { id: "b", role: "assistant", content: "answer" },
    { id: "c", role: "user", content: "later" },
  ];
  assert.equal(
    settledPrefixHash(rows, 1),
    settledPrefixHash(
      rows.map((r) => ({ ...r, id: "branch-" + r.id })),
      1,
    ),
  );
  assert.notEqual(
    settledPrefixHash(rows, 1),
    settledPrefixHash(
      [{ ...rows[0]!, content: "edited" }, ...rows.slice(1)],
      1,
    ),
  );
});
