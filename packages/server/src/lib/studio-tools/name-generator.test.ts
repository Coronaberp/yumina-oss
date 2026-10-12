import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("TypeScript name generator preserves the Python script's seeded names across styles and genders", async () => {
  const modulePath = "./name-generator.js";
  const implementation = await import(modulePath).catch(() => null);
  assert.ok(implementation, "The TypeScript generator must be available");
  const fixture = JSON.parse(await readFile(new URL("./fixtures/name-generator-python.json", import.meta.url), "utf8"));
  for (const example of fixture.cases) {
    const generator = new implementation.FictionalNameGenerator(example.seed);
    assert.deepEqual(generator.batch(example.style, example.names.length, example.gender, example.weirdness), example.names,
      `${example.style}/${example.gender}/${example.weirdness}/${example.seed}`);
  }
});

test("name tool excludes existing card names, validates parameters, and stays local", async () => {
  const modulePath = "./name-generator.js";
  const implementation = await import(modulePath).catch(() => null);
  assert.ok(implementation, "The TypeScript generator must be available");
  const original = implementation.executeGenerateNames({ style: "japanese", count: 10, seed: "world" }, []);
  const filtered = implementation.executeGenerateNames({ style: "japanese", count: 10, seed: "world" }, original.names);
  assert.equal(filtered.names.length, 10);
  assert.equal(new Set(filtered.names.map((name: string) => name.toLowerCase())).size, 10);
  assert.ok(filtered.names.every((name: string) => !original.names.includes(name)));
  assert.throws(() => implementation.executeGenerateNames({ count: 101 }, []));
  assert.throws(() => implementation.executeGenerateNames({ style: "unknown" }, []));
  assert.throws(() => implementation.executeGenerateNames({ gender: "invalid" }, []));
  assert.throws(() => implementation.executeGenerateNames({ weirdness: 2 }, []));
  assert.deepEqual(implementation.executeGenerateNames({ seed: 0 }, []), implementation.executeGenerateNames({ seed: 0 }, []));
});

test("full names preserve creator family names and particles in either order", async () => {
  const { executeGenerateNames } = await import("./name-generator.js");
  const input = { style: "romance", format: "full", surname: "Vale", particle: "de", count: 5, seed: "family" };
  const givenFirst = executeGenerateNames(input, []);
  const familyFirst = executeGenerateNames({ ...input, order: "family-given" }, []);
  assert.ok(givenFirst.names.every(name => name.endsWith(" de Vale")));
  assert.ok(familyFirst.names.every(name => name.startsWith("de Vale ")));
  assert.deepEqual(givenFirst.parts.map(part => part.givenName), familyFirst.parts.map(part => part.givenName));
  assert.ok(givenFirst.parts.every(part => part.familyName === "Vale" && part.particle === "de"));
});

test("culture profiles and constraints use configured syllables and produce repeatable names", async () => {
  const { executeGenerateNames } = await import("./name-generator.js");
  const profiles = [{ id: "moon-clan", label: "Moon clan", style: "celtic", region: "North", species: "Elf", clan: "Moon",
    format: "full", surname: "Lune", constraints: { minLength: 6, maxLength: 14, minSyllables: 2, maxSyllables: 4, prefix: "Al", suffix: "ia" },
    phonetics: { starts: [["ka", 1], ["ne", 1]], middles: [["ri", 1]], endings: { neutral: [["la", 1], ["na", 1]] } },
  }];
  const result = executeGenerateNames({ profileId: "moon-clan", count: 3, seed: "profile", avoidSimilar: false }, [], profiles);
  assert.equal(result.profileId, "moon-clan");
  assert.ok(result.parts.every(part => /^Al(?:ka|ne).*ia$/.test(part.givenName)));
  assert.ok(result.parts.every(part => part.givenName.length <= 14 && part.givenName.length >= 6));
  assert.deepEqual(result, executeGenerateNames({ profileId: "moon-clan", count: 3, seed: "profile", avoidSimilar: false }, [], profiles));
  assert.throws(() => executeGenerateNames({ profileId: "missing" }, [], profiles), /profile/i);
  assert.throws(() => executeGenerateNames({ constraints: { minLength: 12, maxLength: 4 } }, []));
  assert.throws(() => executeGenerateNames({ constraints: { prefix: "ThisAffixIsTooLong", maxLength: 5 }, count: 1 }, []), /constraints/i);
});

test("near duplicates are flagged by local edit distance and can be avoided", async () => {
  const modulePath = "./name-generator.js";
  const { findSimilarNames, executeGenerateNames } = await import(modulePath);
  assert.deepEqual(findSimilarNames("Karen", ["Karin", "Karen", "Zophiel"]), ["Karin"]);
  assert.deepEqual(findSimilarNames("Ryu", ["Ria", "Ryu"]), []);
  const args = { style: "romance", count: 10, seed: "duplicates", avoidSimilar: true };
  const original = executeGenerateNames(args, []);
  const protectedBatch = executeGenerateNames(args, original.names);
  assert.ok(protectedBatch.names.every((name: string) => findSimilarNames(name, original.names).length === 0));
  assert.deepEqual(protectedBatch.warnings, []);
  const warningArgs = { style: "romance", count: 1, seed: "warning", avoidSimilar: false };
  const candidate = executeGenerateNames(warningArgs, []).names[0]!;
  const similar = candidate.slice(0, -1) + (candidate.endsWith("a") ? "e" : "a");
  const flagged = executeGenerateNames(warningArgs, [similar]);
  assert.deepEqual(flagged.names, [candidate]);
  assert.deepEqual(flagged.warnings, [{ name: candidate, similarTo: [similar] }]);
});

test("full-name uniqueness allows the same given name with distinct generated surnames", async () => {
  const { executeGenerateNames } = await import("./name-generator.js");
  const result = executeGenerateNames({ style: "romance", format: "full", count: 2, seed: "reuse", avoidSimilar: false, weirdness: 0,
    phonetics: { starts: [["ka", 1]], endings: { neutral: [["la", 1]] }, syllableWeights: [1], joiners: [""] },
  }, []);
  assert.equal(result.names.length, 2);
  assert.deepEqual(result.parts.map(part => part.givenName), ["Kala", "Kala"]);
  assert.equal(new Set(result.parts.map(part => part.familyName)).size, 2);
});

test("partial constraints are checked after merging with a profile", async () => {
  const { executeGenerateNames } = await import("./name-generator.js");
  const profiles = [{ id: "long", label: "Long", style: "romance", constraints: { maxLength: 30, prefix: "Alexandria", suffix: "valia" } }];
  const result = executeGenerateNames({ profileId: "long", count: 1, seed: "partial", constraints: { minLength: 20 } }, [], profiles);
  assert.ok(result.names[0]!.length >= 20 && result.names[0]!.length <= 30);
  assert.throws(() => executeGenerateNames({ count: 1, constraints: { minLength: 20 } }, []), /Minimum length/);
  const family = executeGenerateNames({ format: "surname", count: 1, surname: "Abcdefghijklmnopqrstuv",
    constraints: { minLength: 20 }, surnameConstraints: { maxLength: 30 }, seed: "long-surname" }, []);
  assert.deepEqual(family.names, ["Abcdefghijklmnopqrstuv"]);
});
