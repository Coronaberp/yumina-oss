import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { nameGeneratorOptionsSchema, nameGeneratorProfilesSchema, type NameConstraints, type NamePhonetics, type NameGeneratorProfile } from "@yumina/shared";
import { NAME_STYLES, type NameGender, type NameStyleKey, type WeightedFragment, type NameStyleDefinition } from "./name-styles.js";
export { NAME_STYLES } from "./name-styles.js";

/** Python Random's MT19937 seeding and draws keep existing seeds reproducible. */
class PythonRandom {
  private state = new Uint32Array(624);
  private index = 624;

  constructor(seed?: string | number) {
    let integer: bigint;
    if (typeof seed === "number") {
      if (!Number.isSafeInteger(seed)) throw new Error("Seed must be a safe integer or string.");
      integer = BigInt(Math.abs(seed));
    } else {
      const bytes = seed === undefined ? randomBytes(32) : Buffer.from(seed, "utf8");
      const material = seed === undefined ? bytes : Buffer.concat([bytes, createHash("sha512").update(bytes).digest()]);
      integer = BigInt(`0x${material.toString("hex")}`);
    }
    const words: number[] = [];
    do { words.push(Number(integer & 0xffffffffn)); integer >>= 32n; } while (integer > 0n);
    this.state[0] = 19650218;
    for (let i = 1; i < 624; i++) {
      const previous = this.state[i - 1]!;
      this.state[i] = (Math.imul(previous ^ (previous >>> 30), 1812433253) + i) >>> 0;
    }
    let i = 1; let j = 0;
    for (let k = Math.max(624, words.length); k > 0; k--) {
      const previous = this.state[i - 1]!;
      this.state[i] = ((this.state[i]! ^ Math.imul(previous ^ (previous >>> 30), 1664525)) + words[j]! + j) >>> 0;
      i++; j++;
      if (i >= 624) { this.state[0] = this.state[623]!; i = 1; }
      if (j >= words.length) j = 0;
    }
    for (let k = 623; k > 0; k--) {
      const previous = this.state[i - 1]!;
      this.state[i] = ((this.state[i]! ^ Math.imul(previous ^ (previous >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { this.state[0] = this.state[623]!; i = 1; }
    }
    this.state[0] = 0x80000000;
  }

  private uint32(): number {
    if (this.index >= 624) {
      for (let i = 0; i < 624; i++) {
        const combined = (this.state[i]! & 0x80000000) | (this.state[(i + 1) % 624]! & 0x7fffffff);
        this.state[i] = this.state[(i + 397) % 624]! ^ (combined >>> 1) ^ ((combined & 1) ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let value = this.state[this.index++]!;
    value ^= value >>> 11;
    value ^= (value << 7) & 0x9d2c5680;
    value ^= (value << 15) & 0xefc60000;
    value ^= value >>> 18;
    return value >>> 0;
  }

  random(): number { return ((this.uint32() >>> 5) * 67108864 + (this.uint32() >>> 6)) / 9007199254740992; }

  choice<T>(values: readonly T[]): T {
    const bits = Math.floor(Math.log2(values.length)) + 1;
    let index: number;
    do { index = this.uint32() >>> (32 - bits); } while (index >= values.length);
    return values[index]!;
  }

  weighted<T>(items: readonly (readonly [T, number])[]): T {
    let threshold = this.random() * items.reduce((sum, item) => sum + item[1], 0);
    for (const [value, weight] of items) { threshold -= weight; if (threshold < 0) return value; }
    return items.at(-1)![0];
  }
}

export function cleanName(value: string): string {
  return value.replace(/[^A-Za-z'-]/g, "").replace(/'{2,}/g, "'").replace(/-{2,}/g, "-").replace(/^['-]+|['-]+$/g, "")
    .split("-").map(chunk => chunk.split("'").map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join("'")).join("-");
}

export function squashBadRepetitions(value: string): string {
  return value.replace(/([aeiou])\1{2,}/gi, "$1").replace(/([^aeiou])\1{3,}/gi, "$1$1");
}

export function looksPronounceable(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.length >= 3 && lower.length <= 15 && !/[^aeiouy'\-]{5,}|[aeiouy]{4,}|(.{2})\1\1/.test(lower);
}

export function estimateNameSyllables(name: string): number {
  return name.toLowerCase().match(/[aeiouy]+/g)?.length ?? 1;
}

function obeysConstraints(name: string, constraints: NameConstraints): boolean {
  const syllables = estimateNameSyllables(name);
  return name.length >= (constraints.minLength ?? 3) && name.length <= (constraints.maxLength ?? 15)
    && syllables >= (constraints.minSyllables ?? 1) && syllables <= (constraints.maxSyllables ?? 12)
    && (!constraints.prefix || name.toLowerCase().startsWith(constraints.prefix.toLowerCase()))
    && (!constraints.suffix || name.toLowerCase().endsWith(constraints.suffix.toLowerCase()));
}

function canonicalName(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Local edit distance, including adjacent transpositions; no model scoring. */
export function findSimilarNames(candidate: string, existingNames: readonly string[]): string[] {
  const left = canonicalName(candidate);
  return existingNames.filter(existing => {
    const right = canonicalName(existing);
    if (left === right || Math.min(left.length, right.length) < 4) return false;
    const allowed = Math.max(left.length, right.length) >= 10 ? 2 : 1;
    if (Math.abs(left.length - right.length) > allowed) return false;
    const rows = Array.from({ length: left.length + 1 }, (_, i) => Array.from({ length: right.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
    for (let i = 1; i <= left.length; i++) for (let j = 1; j <= right.length; j++) {
      rows[i]![j] = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) rows[i]![j] = Math.min(rows[i]![j]!, rows[i - 2]![j - 2]! + 1);
    }
    return rows[left.length]![right.length]! <= allowed;
  });
}

export class FictionalNameGenerator {
  private rng: PythonRandom;
  private used: Set<string>;
  constructor(seed?: string | number, excluded: readonly string[] = []) {
    this.rng = new PythonRandom(seed);
    this.used = new Set(excluded.map(name => name.trim().toLowerCase()));
  }

  generate(style: NameStyleKey, gender: NameGender = "neutral", weirdness = 0.35, constraints: NameConstraints = {}, phonetics?: NamePhonetics, remember = true): string {
    if (!Object.hasOwn(NAME_STYLES, style)) throw new Error(`Unknown name style: ${style}`);
    if (!["masculine", "feminine", "neutral"].includes(gender)) throw new Error(`Unknown name gender: ${gender}`);
    if (!Number.isFinite(weirdness)) throw new Error("Weirdness must be finite.");
    weirdness = Math.max(0, Math.min(1, weirdness));
    const base = NAME_STYLES[style];
    const definition: NameStyleDefinition = { ...base, ...phonetics, endings: {
      masculine: phonetics?.endings?.masculine ?? base.endings.masculine,
      feminine: phonetics?.endings?.feminine ?? base.endings.feminine,
      neutral: phonetics?.endings?.neutral ?? base.endings.neutral,
    } };
    const fragment = (items: readonly WeightedFragment[]) => this.rng.weighted(items);
    for (let attempt = 0; attempt < 250; attempt++) {
      const syllables = this.rng.weighted(definition.syllableWeights.map((weight, index) =>
        [index + 1, Math.max(1, Math.trunc(weight * (1 + weirdness * index * 0.55)))] as const));
      const start = fragment(definition.starts);
      let middle = "";
      for (let i = 0; i < Math.max(0, syllables - 2); i++) middle += fragment(definition.middles);
      const endings = definition.endings[gender];
      const ending = fragment(endings);
      if (this.rng.random() < weirdness * 0.22) middle += fragment(definition.middles);
      let candidate = start + middle + ending;
      if (definition.joiners.length > 1 && this.rng.random() < weirdness * 0.10) {
        candidate += this.rng.choice(definition.joiners) + fragment(definition.starts) + fragment(endings);
      }
      candidate = cleanName(squashBadRepetitions(candidate));
      candidate = cleanName((constraints.prefix ?? "") + candidate + (constraints.suffix ?? ""));
      const key = candidate.toLowerCase();
      // Keep original pronunciation rules, allowing an explicitly configured longer name.
      const pronounceable = candidate.length >= 3 && !/[^aeiouy'\-]{5,}|[aeiouy]{4,}|(.{2})\1\1/.test(candidate.toLowerCase());
      if (!candidate || (remember && this.used.has(key)) || !pronounceable || !obeysConstraints(candidate, constraints)) continue;
      if (remember) this.used.add(key);
      return candidate;
    }
    throw new Error("Could not generate a unique pronounceable name within these constraints after 250 attempts. Relax the constraints or provide more syllable fragments.");
  }

  batch(style: NameStyleKey, count: number, gender: NameGender = "neutral", weirdness = 0.35): string[] {
    if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("Count must be between 1 and 100.");
    return Array.from({ length: count }, () => this.generate(style, gender, weirdness));
  }

  randomStyle(): NameStyleKey { return this.rng.choice(Object.keys(NAME_STYLES) as NameStyleKey[]); }
}

const inputSchema = nameGeneratorOptionsSchema.extend({
  profileId: z.string().min(1).max(80).optional(),
  count: z.number().int().min(1).max(100).default(20),
  seed: z.union([z.string().max(1000), z.number().int().safe()]).optional(),
  exclude: z.array(z.string().max(200)).max(1000).default([]),
});

export function executeGenerateNames(input: unknown, existingNames: readonly string[], profiles: readonly NameGeneratorProfile[] | unknown = []) {
  const supplied = inputSchema.parse(input);
  const cultures = nameGeneratorProfilesSchema.parse(profiles);
  const profile = cultures.find(item => item.id === supplied.profileId);
  if (supplied.profileId && !profile) throw new Error(`Unknown naming profile: ${supplied.profileId}`);
  const format = supplied.format ?? profile?.format ?? "given";
  const { id: _id, label: _label, region: _region, species: _species, clan: _clan, family: _family, ...profileOptions } = profile ?? {};
  const args = inputSchema.parse({ ...profileOptions, ...supplied,
    constraints: { ...(format === "surname" ? {} : { minLength: 3, maxLength: 15, minSyllables: 1, maxSyllables: 12 }), ...profile?.constraints, ...supplied.constraints },
    surnameConstraints: { ...profile?.surnameConstraints, ...supplied.surnameConstraints },
    phonetics: profile?.phonetics || supplied.phonetics ? { ...profile?.phonetics, ...supplied.phonetics,
      endings: { ...profile?.phonetics?.endings, ...supplied.phonetics?.endings } } : undefined,
  });
  const gender = args.gender ?? "neutral";
  const weirdness = args.weirdness ?? 0.35;
  const excluded = [...existingNames, ...args.exclude];
  const generator = new FictionalNameGenerator(args.seed, format === "given" ? excluded : []);
  const style = !args.style || args.style === "random" ? generator.randomStyle() : args.style;
  const surnameStyle = args.surnameStyle ?? style;
  const names: string[] = [];
  const parts: Array<{ givenName: string; familyName: string; particle: string; displayName: string }> = [];
  const warnings: Array<{ name: string; similarTo: string[] }> = [];
  const exact = new Set(excluded.map(canonicalName));
  const familyConstraints = { ...(format === "surname" ? { ...profile?.constraints, ...supplied.constraints } : {}),
    ...profile?.surnameConstraints, ...supplied.surnameConstraints };
  if ((familyConstraints.minLength ?? (args.surname ? 1 : 3)) > (familyConstraints.maxLength ?? (args.surname ? 60 : 15))) {
    throw new Error("Minimum length exceeds maximum length in surname constraints.");
  }
  if (format !== "given" && args.surname && !obeysConstraints(args.surname, { minLength: 1, maxLength: 60, ...familyConstraints })) {
    throw new Error("The supplied surname conflicts with the surname constraints.");
  }
  for (let attempt = 0; names.length < args.count && attempt < args.count * 250; attempt++) {
    const givenName = format === "surname" ? "" : generator.generate(style, gender, weirdness, args.constraints, args.phonetics, format !== "full");
    const familyName = format === "given" ? "" : args.surname ?? generator.generate(surnameStyle, "neutral", weirdness, familyConstraints, format === "surname" ? args.phonetics : undefined, format !== "full");
    const particle = format === "given" ? "" : args.particle ?? "";
    const family = [particle, familyName].filter(Boolean).join(" ");
    const displayName = format === "given" ? givenName : format === "surname" ? family
      : args.order === "family-given" ? `${family} ${givenName}` : `${givenName} ${family}`;
    if (args.maxFullLength && displayName.length > args.maxFullLength) continue;
    if (exact.has(canonicalName(displayName))) continue;
    const similarTo = findSimilarNames(displayName, [...excluded, ...names]);
    if (similarTo.length && (args.avoidSimilar ?? true)) continue;
    if (similarTo.length) warnings.push({ name: displayName, similarTo });
    exact.add(canonicalName(displayName));
    names.push(displayName);
    parts.push({ givenName, familyName, particle, displayName });
  }
  if (names.length !== args.count) throw new Error("Could not fill this batch within the naming constraints. Relax them or use a broader profile.");
  return { style, surnameStyle, format, order: args.order ?? "given-family", gender, weirdness, ...(args.seed === undefined ? {} : { seed: args.seed }),
    ...(profile ? { profileId: profile.id } : {}), names, parts, warnings,
    description: NAME_STYLES[style].description,
    source: "phonetic-generator" as const };
}
