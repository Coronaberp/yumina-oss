import assert from "node:assert/strict";
import test from "node:test";
import { type WorldDefinition } from "@yumina/engine";
import { guardStoryCharacterIdentity } from "./story-character-guard.js";

const world = { entries: [
  { id: "sera", name: "Sera (Seraphine)", role: "character", enabled: true, conditions: [], content: "Full Name: Seraphine\nAge: 247 (appears mid-twenties)\nSpecies: Angel\nOccupation: Divine Combat Instructor" },
  ...Array.from({ length: 100 }, (_, i) => ({ id: `staff-${i}`, name: `Staff ${i}`, role: "character", enabled: true, conditions: [], content: `Full Name: Staff ${i}\nAge: ${30+i}\nSpecies: Human\nOccupation: Gardener` })),
] } as unknown as WorldDefinition;

const valid = JSON.stringify({ valid: true, issues: [] });
const invalid = JSON.stringify({ valid: false, issues: [{ claim: "first-year student", authoredFact: "Divine Combat Instructor" }] });

test("only the introduced character is reviewed, even with a hundred other profiles", async () => {
  let calls = 0;
  const result = await guardStoryCharacterIdentity({ world, raw: "Seraphine begins the divine combat lesson.", signal: new AbortController().signal, request: async request => {
    calls++;
    const body = JSON.stringify(request.messages);
    assert.match(body, /247|Angel|Seraphine/);
    assert.doesNotMatch(body, /Gardener|Staff 99/);
    return { raw: valid };
  } });
  assert.equal(calls, 1);
  assert.equal(result.raw, "Seraphine begins the divine combat lesson.");
});

test("existing-profile contradictions are corrected once and the correction is rechecked", async () => {
  const stages: string[] = [];
  const responses = [invalid, "Seraphine, the 247-year-old angel instructor, begins the lesson.", valid];
  const result = await guardStoryCharacterIdentity({ world, raw: "Seraphine is a first-year student.", signal: new AbortController().signal, request: async request => { stages.push(request.stage); return { raw: responses.shift()! }; } });
  assert.deepEqual(stages, ["review", "correction", "review"]);
  assert.match(result.raw, /247-year-old angel instructor/);
  assert.equal(result.corrected, true);
});

test("a still-contradictory correction is rejected without another retry", async () => {
  let calls = 0;
  await assert.rejects(guardStoryCharacterIdentity({ world, raw: "Seraphine is a first-year student.", signal: new AbortController().signal, request: async () => ({ raw: [invalid, "Seraphine is a first-year student.", invalid][calls++]! }) }), /character_identity_invalid/);
  assert.equal(calls, 3);
});

test("unsupported or malformed review evidence fails closed", async () => {
  for (const raw of ["not JSON", '{"valid":true,"issues":[{}]}', '{"valid":false,"issues":[]}', JSON.stringify({ valid: false, issues: [{ claim: "absent", authoredFact: "Divine Combat Instructor" }] })]) {
    let calls = 0;
    await assert.rejects(guardStoryCharacterIdentity({ world, raw: "Seraphine is a first-year student.", signal: new AbortController().signal, request: async () => { calls++; return { raw }; } }), /character_identity_review_invalid/);
    assert.equal(calls, 1);
  }
});

test("new contradictions in a different actor introduced by correction are reviewed", async () => {
  let calls = 0;
  const result = await guardStoryCharacterIdentity({ world, raw: "Seraphine is a first-year student.", signal: new AbortController().signal, request: async request => {
    calls++;
    if (calls === 1) return { raw: invalid };
    if (calls === 2) return { raw: "Seraphine calls Staff 99, the gardener." };
    assert.match(JSON.stringify(request.messages), /Age: 129/);
    return { raw: valid };
  } });
  assert.equal(result.corrected, true);
});

test("empty scenes, hidden actors and unknown characters need no provider request", async () => {
  const hidden = structuredClone(world); hidden.entries[0]!.memory = { hidden: true };
  for (const [card, raw] of [[world, "The empty hall is quiet."], [hidden, "Seraphine opens a door."], [world, "A newly met stranger enters."]] as const) {
    const result = await guardStoryCharacterIdentity({ world: card, raw, signal: new AbortController().signal, request: async () => { throw Error("not expected"); } });
    assert.equal(result.raw, raw);
  }
});

test("user cancellation and truncated review prevent acceptance", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(guardStoryCharacterIdentity({ world, raw: "Seraphine enters.", signal: controller.signal, request: async () => ({ raw: valid }) }), /cancelled/);
  await assert.rejects(guardStoryCharacterIdentity({ world, raw: "Seraphine enters.", signal: new AbortController().signal, request: async () => ({ raw: valid, stopReason: "max_tokens" }) }), /character_identity_review_incomplete/);
});

test("saved identity context cannot expose AI-hidden or inactive variables", async () => {
  const card = { ...world, variables: [
    { id: "characterSecrets", name: "Secrets", type: "json", aiAccess: "none", defaultValue: {} },
    { id: "characterInactive", name: "Inactive", type: "json", aiAccess: "read", enabled: false, defaultValue: {} },
    { id: "characterRoles", name: "Roles", type: "json", aiAccess: "read", defaultValue: {} },
  ] } as unknown as WorldDefinition;
  const state = { variables: { characterSecrets: { sera: "HIDDEN_SECRET" }, characterInactive: { sera: "INACTIVE_SECRET" }, characterRoles: { sera: "Accepted role" } }, ruleState: {}, metadata: {} } as any;
  await guardStoryCharacterIdentity({ world: card, state, raw: "Seraphine arrives.", signal: new AbortController().signal, request: async request => {
    const packet = JSON.stringify(request.messages);
    assert.doesNotMatch(packet, /HIDDEN_SECRET|INACTIVE_SECRET/);
    assert.match(packet, /Accepted role/);
    return { raw: valid };
  } });
});
