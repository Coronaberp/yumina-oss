import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { upgradeVnSkipFiles } from "./vn-skip-upgrade";

const source = readFileSync(new URL("../../../../../interfaces/vn/index.tsx", import.meta.url), "utf8");
const oldSkip = '<Control name="Skip" onClick={() => { setAuto(false); if (pendingPlayerSprite) setPendingPlayerSprite(current => current ? { ...current, index: Math.max(0, lines.length - 1) } : current); else setCursor({ turn, index: Math.max(0, lines.length - 1) }); }} />';
const newSkip = source.match(/<Control name="Skip" onClick=\{\(\) => \{[\s\S]*?\}\} \/>/)?.[0];
assert.ok(newSkip);
const oldSource = source.replace(newSkip, oldSkip);
const legacySource = oldSource.replace('  const cursorRevision = React.useRef(0);\n', '').replace('    const revision = cursorRevision.current;\n', '').replace('revision === cursorRevision.current && ', '').replace('cursorRevision.current++; ', '');

test("older shipped readers get the same Skip while their existing hydration stays intact", () => {
  const next = upgradeVnSkipFiles({ "index.tsx": legacySource });
  assert.equal(next["index.tsx"], legacySource.replace(oldSkip, newSkip));
  const plainSkip = '<Control name="Skip" onClick={() => { setAuto(false); setCursor({ turn, index: Math.max(0, lines.length - 1) }); }} />';
  for (const root of [
    legacySource.replace(oldSkip, plainSkip),
    legacySource.replace(oldSkip, plainSkip).replace('const lines = pendingPlayerLine ? pendingPlayerLines : replyLines;', 'const lines = pendingPlayerLine ? [pendingPlayerLine] : replyLines;').replace('const pendingPlayerLines = pendingPlayerSprite ? playerChoicePassages(pendingPlayerSprite.text, sceneApi.user, pendingPlayerSprite.expression) : [];\n  const pendingPlayerLine = !!pendingPlayerLines.length;', 'const pendingPlayerLine = pendingPlayerSprite ? { name: sceneApi.user?.name || "You", kind: "dialogue", player: true, emotion: pendingPlayerSprite.expression, text: pendingPlayerSprite.text } : null;'),
    legacySource.replace(oldSkip, plainSkip).replace(/^  const pendingPlayerLines =.*\n|^  const pendingPlayerLine =.*\n/gm, '').replace('const lines = pendingPlayerLine ? pendingPlayerLines : replyLines;', 'const lines = segments.length ? segments : currentMessage ? messagePassages(sceneApi, currentMessage) : passages(sceneApi.entries, api.greetingContent || "");'),
  ]) {
    const files = { "index.tsx": root };
    const updated = upgradeVnSkipFiles(files);
    assert.notEqual(updated, files);
    assert.ok(updated["index.tsx"].includes(newSkip));
    assert.equal(upgradeVnSkipFiles(updated), updated);
  }
});

test("saved stock VN readers receive exactly the canonical source Skip handler", () => {
  const files = { "index.tsx": oldSource, "sprites.ts": "custom art", "scenes.ts": "custom backgrounds", "status-layout.tsx": "custom status", "story.ts": "custom story" };
  const next = upgradeVnSkipFiles(files);
  assert.equal(next["index.tsx"], source);
  for (const key of ["sprites.ts", "scenes.ts", "status-layout.tsx", "story.ts"] as const) assert.equal(next[key], files[key]);
  assert.equal(files["index.tsx"], oldSource);
  assert.equal(upgradeVnSkipFiles(next), next);
});

test("all recognized composed and nested VN roots get Skip while other customization survives", () => {
  const authored = oldSource + "\n// Creator integration\n";
  const files = { "index.tsx": "Composed interface", "__user-root.tsx": authored, "ui/root.tsx": authored, "custom.tsx": "export default function Custom() {}" };
  const next = upgradeVnSkipFiles(files);
  assert.equal(next["__user-root.tsx"], source + "\n// Creator integration\n");
  assert.equal(next["ui/root.tsx"], next["__user-root.tsx"]);
  assert.equal(next["index.tsx"], files["index.tsx"]);
  assert.equal(next["custom.tsx"], files["custom.tsx"]);
  assert.equal(upgradeVnSkipFiles(next), next);
});

test("custom Skip, accepted-scene buffering, turn identity, paging and partial handlers stay untouched", () => {
  const variants = [
    source,
    oldSource.replace(oldSkip, '<Control name="Skip" onClick={customSkip} />'),
    oldSource.replace('className="vn-stage"', 'className="creator-stage"'),
    oldSource.replace("if (!api.isStreaming) completed.current =", "if (creatorAccepted) completed.current ="),
    oldSource.replace("const sceneApi = { ...api, ...completed.current };", "const sceneApi = customScene(api);"),
    oldSource.replace('const latest = replies.at(-1);', 'const latest = customLatest(replies);'),
    oldSource.replace('const latestTurn = messageTurn(latest);', 'const latestTurn = creatorTurn;'),
    oldSource.replace('const lastMessage = (api.messages || []).at(-1);', 'const lastMessage = creatorLastMessage;'),
    oldSource.replace('const loading = !error && (waiting || api.isStreaming);', 'const loading = customLoading;'),
    oldSource.replace('const pendingPlayerLines =', 'const creatorPlayerLines ='),
    oldSource + oldSkip,
    oldSource.replace(oldSkip, oldSkip.replace('setCursor({ turn,', 'customCursor({ turn,')),
  ];
  for (const root of variants) {
    const files = { "index.tsx": root, "sprites.ts": "custom art" };
    assert.equal(upgradeVnSkipFiles(files), files);
  }
});

test("the host upgrades saved VN Skip at runtime after its existing reader prerequisites", () => {
  const host = readFileSync(new URL("./world-renderer.tsx", import.meta.url), "utf8");
  const pipeline = readFileSync(new URL("./vn-compatible-files.ts", import.meta.url), "utf8");
  assert.match(host, /import \{ upgradeCompatibleVnFiles \} from "\.\/vn-compatible-files"/);
  assert.match(host, /return upgradeCompatibleVnFiles\(adapted, interfaceId, vnCompatibilitySources\)/);
  assert.match(pipeline, /import \{ upgradeVnSkipFiles \} from "\.\/vn-skip-upgrade"/);
  assert.equal(pipeline.split("updated = upgradeVnSkipFiles(updated)").length, 2);
  assert.ok(pipeline.indexOf("updated = upgradeVnSkipFiles(updated)") > pipeline.indexOf("updated = upgradeVnReplyReadyFiles(updated)"));
});
