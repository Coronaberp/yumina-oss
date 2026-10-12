/** Apply the versioned VN presentation to an owned local card, with a rollback
 * snapshot and the same optimistic concurrency check as the editor. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { bundleTSX } from "../packages/app/src/features/studio/lib/tsx-bundler";
import { hashRootFiles, COMPILED_FORMAT_VERSION } from "../packages/app/src/features/studio/lib/compiled-format";
import { mergeVnPresentationFiles } from "../packages/engine/src/world/vn-presentation-upgrade.js";

const worldId = process.argv[2];
if (!worldId || !/^[\da-f-]{36}$/i.test(worldId)) throw new Error("Pass the target local world UUID");
const base = "http://127.0.0.1:3000";
const folder = fileURLToPath(new URL("../interfaces/vn/", import.meta.url));
const login = await fetch(base + "/api/local-auth/sign-in", { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "{}" });
if (!login.ok) throw new Error("Local sign-in failed: " + login.status);
const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(base + path, { ...options, headers: { Cookie: cookie, Origin: base, ...options.headers } });
  if (!response.ok) throw new Error(`Local request ${path} failed: ${response.status}`);
  return response;
}
const world = (await (await request(`/api/worlds/${worldId}?forEdit=1`)).json()).data;
if (world.editingLocked) throw new Error("The card is locked. Unlock it deliberately before reapplying VN.");
const template = Object.fromEntries(readdirSync(folder).filter(name => /\.(tsx?|jsx?)$/.test(name)).map(name => [name, readFileSync(folder + name, "utf8")]));
// Validate/preserve configuration before any uploads or saved-card mutations.
const files = mergeVnPresentationFiles(world.schema.rootComponent?.files ?? {}, template);
const backup = `/tmp/yumina-vn-backup-${worldId}-${Date.now()}.json`;
writeFileSync(backup, JSON.stringify(world), { mode: 0o600 });
const assetList = (await (await request(`/api/worlds/${worldId}/assets`)).json()).data;
const filename = "vn-DejaVuSans.ttf";
let font = assetList.find((asset: { filename: string }) => asset.filename === filename);
if (!font) {
  const bytes = readFileSync(folder + "assets/DejaVuSans.ttf");
  const prepared = (await (await request(`/api/worlds/${worldId}/assets/upload-url`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename, contentType: "font/ttf", type: "font" }) })).json()).data;
  const uploadUrl = new URL(prepared.uploadUrl, base);
  if (uploadUrl.origin !== base) throw new Error("Expected a local font upload URL");
  const upload = await fetch(uploadUrl, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "font/ttf" }, body: bytes });
  if (!upload.ok) throw new Error("Font upload failed: " + upload.status);
  font = (await (await request(`/api/worlds/${worldId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: prepared.key, filename, type: "font", mimeType: "font/ttf", sizeBytes: bytes.length }) })).json()).data;
}
files["font.ts"] = `// Bundled DejaVu Sans: the exact family specified in the supplied SVG references.\nexport const fontRef = "@asset:${font.id}";\n`;
const menuFilename = "vn-menu.png";
let menu = assetList.filter((asset: { filename: string }) => [menuFilename, "vn-menu.webp"].includes(asset.filename)).at(-1);
if (!menu) {
  const bytes = readFileSync(folder + "assets/menu-vn.png");
  const prepared = (await (await request(`/api/worlds/${worldId}/assets/upload-url`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: menuFilename, contentType: "image/png", type: "image" }) })).json()).data;
  const uploadUrl = new URL(prepared.uploadUrl, base);
  if (uploadUrl.origin !== base) throw new Error("Expected a local menu upload URL");
  const upload = await fetch(uploadUrl, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "image/png" }, body: bytes });
  if (!upload.ok) throw new Error("Menu asset upload failed: " + upload.status);
  menu = (await (await request(`/api/worlds/${worldId}/assets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: prepared.key, filename: menuFilename, type: "image", mimeType: "image/png", sizeBytes: bytes.length }) })).json()).data;
}
files["menu-asset.ts"] = `// Unmodified supplied menu_vn.png; its icons are cropped in CSS.\nexport const menuRef = "@asset:${menu.id}";\n`;
const result = bundleTSX({ files, entryFile: "index.tsx" });
if (result.error || !result.code) throw new Error(result.error || "Empty VN bundle");
const schema = structuredClone(world.schema);
schema.rootComponent = { ...schema.rootComponent, name: "VN", interfaceId: "vn", entryFile: "index.tsx", files, updatedAt: new Date().toISOString(), compiled: { code: result.code, filesHash: hashRootFiles("index.tsx", files), compilerVersion: COMPILED_FORMAT_VERSION } };
const updated = await request(`/api/worlds/${worldId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schema, baseUpdatedAt: world.updatedAt }) });
const verified = (await (await request(`/api/worlds/${worldId}?forEdit=1`)).json()).data;
if (!isDeepStrictEqual(verified.schema.rootComponent.files, files)) throw new Error("Saved VN files differ from local source");
const before = structuredClone(world.schema); delete before.rootComponent;
const after = structuredClone(verified.schema); delete after.rootComponent;
if (!isDeepStrictEqual(before, after)) throw new Error("Unexpected change outside root presentation; inspect rollback snapshot");
console.log(JSON.stringify({ applied: true, worldId, status: updated.status, files: Object.keys(files), backup, storyUnchanged: true, fontAsset: font.id }));
