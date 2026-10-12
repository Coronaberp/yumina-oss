import { createMemoryDatabase } from "../database.js";
import {
  ensureRegistry,
  ensureProfileSchema,
  ensureIdentity,
} from "../schema.js";
import { ProfileRepository } from "../profiles.js";
import { createMemoryRepositories } from "../repositories/index.js";
import type { TranscriptMessage, TurnMemoryContext } from "../types.js";
export async function memoryFixture(dimensions = 3) {
  const db = await createMemoryDatabase();
  await ensureRegistry(db);
  const profiles = new ProfileRepository(db, {
    encrypt: (s) => s,
    decrypt: (s) => s,
  });
  const profile = await profiles.create("owner", {
    baseUrl: "http://fixture.invalid/v1",
    model: "test-space",
    dimensions,
  });
  await ensureProfileSchema(db, profile);
  await profiles.setStatus("owner", profile.id, "ready");
  await profiles.activate("owner", profile.id, profile.revision);
  const scope = {
    profileId: profile.id,
    schemaName: profile.schemaName,
    ownerUserId: "owner",
    sessionId: "session",
    charId: "char",
  };
  await ensureIdentity(db, scope);
  const key = Buffer.alloc(32, 23),
    repositories = createMemoryRepositories(db, scope, key);
  const vector = Array.from({ length: dimensions }, (_, i) =>
    i === 0 ? 1 : 0,
  );
  return { db, profiles, profile, scope, key, repositories, vector };
}
export function messages(pairs: number): TranscriptMessage[] {
  return Array.from({ length: pairs }, (_, i) => [
    {
      id: `u${i}`,
      role: "user",
      content: `Player acted in scene ${i}.`,
      sourceVersion: `user-v${i}`,
    },
    {
      id: `a${i}`,
      role: "assistant",
      content: `Mira answered in scene ${i}.`,
      sourceVersion: `answer-v${i}`,
      selectedAnswerId: `selected${i}`,
    },
  ]).flat();
}
export function context(pairs: number): TurnMemoryContext {
  return {
    ownerUserId: "owner",
    actingUserId: "actor",
    sessionId: "session",
    worldId: "world",
    mode: "solo",
    epoch: 0,
    sourceHash: `source-${pairs}`,
    cutoffMessageId: `a${pairs - 1}`,
    query: "What happened at the gate?",
    messages: messages(pairs),
    charName: "Mira",
    userName: "Player",
    language: "English",
    castNames: [],
    canonicalLocation: "Gate",
    loreEntries: [],
  };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
