import assert from "node:assert/strict";
import { test } from "node:test";
import { getSkillContent } from "../studio-skills/index.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { resolveContext } from "./context-resolver.js";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";

test("relationship management on other cards defaults to MRPG current-state progress", async () => {
  const world = migrateWorldDefinition({ id: "another-card", version: "19.0.0", name: "Another card", description: "", author: "test",
    entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: {},
  } as unknown as WorldDefinition);
  const context = await resolveContext(world, "Add relationship management", { userId: "test-user", contextWindow: 120000 });
  const prompt = buildSystemPrompt(context).static;
  assert.match(prompt, /For every card.*relationship management.*Magic Academy RPG \(MRPG\)/);
  assert.match(prompt, /stored current state.*signed progress/);
  assert.match(prompt, /one left-to-right meter/);
  assert.match(prompt, /abs\(progress\).*current.stage capacity/);
  assert.match(prompt, /negative.*black.*positive.*field color/);
  assert.match(prompt, /Never.*separate negative and positive halves/);
  assert.match(prompt, /preserve.*existing.*progress/i);
  assert.match(prompt, /Only.*explicitly.*(?:custom|own).*relationship system/i);
  assert.doesNotMatch(prompt, /should relationships be per-NPC variables or one JSON variable/);
});

test("relationship skill matches MRPG ladders, milestones, event-driven resets and current-stage displays", () => {
  const skill = getSkillContent("world-design")!;
  const relationship = skill.split("## Pattern 2")[1]!.split("## Pattern 3")[0]!;
  for (const [label, capacity] of [["Nemesis",1000],["Detested",700],["Hatred",100],["Distrustful",75],["Wary",50],["Neutral",100],
    ["Acquaintance",100],["Friendly",200],["Trusted",400],["Close",700],["Bonded",1000],["Reviled",1500],["Legendary",1500]]) {
    assert.match(relationship, new RegExp(`${label}\\s*[:|]\\s*${capacity}`), `${label} capacity`);
  }
  for (const literal of ['aiAccess: "read"', 'aiAccess: "none"', 'social-evidence', 'social-limits', 'social-phase', 'social:normalize',
    'social:commit', 'trusted-milestone', 'close-milestone', 'bonded-milestone']) assert.ok(relationship.includes(literal), literal);
  assert.match(relationship, /one stage.*reset.*0/i);
  assert.match(relationship, /discard.*overflow/i);
  assert.match(relationship, /idle.*cannot.*promot/i);
  assert.match(relationship, /credible.*witness|witness.*credible/i);
  assert.match(relationship, /No.*day gates/i);
  assert.match(relationship, /black.*negative|negative.*black/i);
  assert.match(relationship, /one left-to-right meter/);
  assert.match(relationship, /(?:minus|−|-)25.*25\/100.*25%.*black/i);
  assert.doesNotMatch(relationship, /hostile → beloved|will die for the player|Multi-NPC variant|rel-alice/);
  assert.doesNotMatch(relationship, /rel-(?:sera|ryu|diane|cinder)/);
});

test("UI guidance uses MRPG magnitude in one direction and contains no conflicting split-meter example", () => {
  const frontUi = getSkillContent('front-ui')!;
  assert.match(frontUi, /one left-to-right meter/);
  assert.match(frontUi, /Math\.abs\(progress\) \/ currentStage\.capacity/);
  assert.match(frontUi, /negative.*black.*positive.*field color/);
  assert.doesNotMatch(frontUi, /fill from zero separately in each direction/);
  assert.match(frontUi, /Never.*separate negative and positive halves/);
});
