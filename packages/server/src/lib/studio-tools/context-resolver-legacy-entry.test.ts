import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorldDefinition, WorldEntry } from "@yumina/engine";
import { resolveContext } from "./context-resolver.js";

test("context resolution tolerates legacy lore entries without condition arrays", async () => {
  const entry = {
    id: "signynn",
    name: "Signynn",
    role: "character",
    section: "characters",
    position: 0,
    enabled: true,
    keywords: ["Signynn"],
    content: "A character used for image-generation identity context.",
  } as unknown as WorldEntry;
  const world = {
    id: "legacy-world",
    version: "21.0.0",
    name: "Legacy world",
    description: "",
    author: "test",
    entries: [entry],
    variables: [],
    rules: [],
    reactions: [],
    components: [],
    audioTracks: [],
    customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
  } as unknown as WorldDefinition;

  const context = await resolveContext(world, "Generate a portrait for Signynn", {
    userId: "test-user",
    contextWindow: 120_000,
  });

  assert.match(context.inventory, /Signynn/);
  assert.match(context.preloadedEntities, /A character used for image-generation identity context/);
});
