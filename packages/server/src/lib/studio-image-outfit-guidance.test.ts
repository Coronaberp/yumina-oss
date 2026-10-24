import assert from "node:assert/strict";
import test from "node:test";
import type { WorldDefinition } from "@yumina/engine";
import { resolveAutomaticStudioImageContext, studioImageReferenceGuidance } from "./studio-image-references.js";
import { normalizeImageProposal } from "./studio-tools/image-proposal.js";
import { executeListVnAssets } from "./studio-tools/vn-asset-tools.js";

function world(description = "A silver raincoat and dark boots."): WorldDefinition {
  const source = `export const sprites = {};
export const spriteWardrobeDescriptions = { Alice: { normal: "A red base dress." } };
export const spriteVariants = { normal: { rain: "Rain", missing: "No description" } };
export const spriteVariantWardrobeDescriptions = ${JSON.stringify({ Alice: { normal: { rain: description } }, Clara: { normal: { rain: "A description-only character's coat." } } })};`;
  return { id: "wardrobe-guidance", entries: [{id:"alice", name:"Character: Alice", role:"character", content:"Identity biography", enabled:true}],
    rootComponent: { id:"root", interfaceId:"vn", files:{"sprites.ts":source,"scenes.ts":"export const backgrounds = {};"} } } as unknown as WorldDefinition;
}
const target = { kind:"sprite", characterId:"alice", spriteType:"normal", spriteVariant:"rain", expression:"normal" };

test("automatic generation uses exact authored variant clothing even before any art exists", async () => {
  const context = await resolveAutomaticStudioImageContext("owner", "world", world(), "Draw Alice", target);
  assert.match(context.outfitInstructions ?? "", /silver raincoat/);
  assert.match(context.outfitInstructions!, /variant=rain/);
  assert.doesNotMatch(context.outfitInstructions!, /red base dress/);
  assert.equal(context.referenceImages.length, 0);
  const proposal = normalizeImageProposal({source:"codex",prompt:"Alice standing",outfitInstructions:context.outfitInstructions});
  assert.equal(proposal!.outfitInstructions, context.outfitInstructions);
  const guidance = studioImageReferenceGuidance([{key:"portrait",url:"portrait",name:"Alice portrait",role:"identity"}], "Watercolor", proposal!.outfitInstructions);
  assert.match(guidance, /Project visual style:\nWatercolor/);
  assert.match(guidance, /Exact target outfit/);
  assert.match(guidance, /takes precedence over clothing visible in identity portraits/);
});

test("missing or invalid variant descriptions never borrow Base clothing", async () => {
  const empty = await resolveAutomaticStudioImageContext("owner","world",world(),"",{...target,spriteVariant:"missing"});
  assert.match(empty.outfitInstructions ?? "", /unspecified/);
  assert.doesNotMatch(empty.outfitInstructions!, /red base dress|silver raincoat/);
  const invalid = await resolveAutomaticStudioImageContext("owner","world",world(),"",{...target,spriteVariant:"unknown"});
  assert.equal(invalid.outfitInstructions, undefined);
  const base = await resolveAutomaticStudioImageContext("owner","world",world(),"",{...target,spriteVariant:""});
  assert.match(base.outfitInstructions ?? "", /red base dress/);
  assert.doesNotMatch(base.outfitInstructions!, /silver raincoat/);
});

test("outfit guidance is bounded independently of style and description-only names remain discoverable", async () => {
  const current = world("x".repeat(2500) + "END-OF-LONG-DESCRIPTION");
  const context = await resolveAutomaticStudioImageContext("owner","world",current,"",target);
  assert.ok(context.outfitInstructions!.length <= 3000);
  assert.doesNotMatch(context.outfitInstructions!, /END-OF-LONG-DESCRIPTION/);
  assert.equal(normalizeImageProposal({source:"codex",prompt:"Alice",outfitInstructions:"x".repeat(4000)})!.outfitInstructions!.length,3000);
  const inventory = executeListVnAssets(current, {kind:"sprites",name:"Clara",spriteType:"normal",spriteVariant:"rain"});
  assert.deepEqual(inventory.characters,["Clara"]);
  assert.match(inventory.wardrobeDescriptions![0]!.description,/description-only/);
  assert.deepEqual(inventory.outfits![0]!.availableExpressions,[]);
});
