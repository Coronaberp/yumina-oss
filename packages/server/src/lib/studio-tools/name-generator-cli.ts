import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { executeGenerateNames, NAME_STYLES } from "./name-generator.js";

/** Direct, model-free use of exactly the same generator as Studio. */
export async function generateNameCli(argv: string[]): Promise<string> {
  const { values } = parseArgs({ args: argv, options: {
    style: { type: "string" }, count: { type: "string", short: "n" }, gender: { type: "string", short: "g" },
    weirdness: { type: "string", short: "w" }, seed: { type: "string" }, format: { type: "string" },
    order: { type: "string" }, surname: { type: "string" }, particle: { type: "string" },
    profile: { type: "string" }, profiles: { type: "string" }, config: { type: "string" },
    json: { type: "boolean" }, list: { type: "boolean" },
  } });
  if (values.list) return Object.values(NAME_STYLES).map(style => `${style.key}: ${style.description}`).join("\n");
  const input: Record<string, unknown> = values.config ? JSON.parse(await readFile(values.config, "utf8")) : {};
  for (const key of ["style", "gender", "seed", "format", "order", "surname", "particle"] as const) {
    if (values[key] !== undefined) input[key] = values[key];
  }
  for (const key of ["count", "weirdness"] as const) if (values[key] !== undefined) input[key] = Number(values[key]);
  if (values.profile) input.profileId = values.profile;
  const profiles: unknown = values.profiles ? JSON.parse(await readFile(values.profiles, "utf8")) : [];
  const result = executeGenerateNames(input, [], profiles);
  return values.json ? JSON.stringify(result, null, 2) : result.names.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(await generateNameCli(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
