import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { upgradeVnCustomChoiceLabelFiles } from "./vn-custom-choice-label-upgrade";
import { upgradeVnReplyReadyFiles } from "./vn-reply-ready-upgrade";
import { beforeAutoReading, beforeModelRouting } from "./test-fixtures/vn-reader-before-polish";

const read = (name: string) => readFileSync(new URL(`../../../../../interfaces/vn/${name}`, import.meta.url), "utf8");
// Ready migration predates the separate NPC, Auto and model-routing migrations.
const currentRoot = beforeAutoReading(beforeModelRouting(read("index.tsx"))).replace("name={npcLabels[index] || line.name", "name={line.name"), currentStyles = read("styles.ts");
const oldRoot = currentRoot.replace(/^ {2}const replyReady =.*\n/m, "").replace(/^ {8}\{replyReady &&.*\n/m, "").replace(/^ {8}<span className="vn-reply-announcement".*\n/m, "");
const oldStyles = currentStyles.replace(/^\.vn-reply-ready\{.*\n/m, "").replace(/^\.vn-dialogue:has\(\.vn-reply-ready\).*\n/m, "");
const upgrade = (files: Record<string, string>) => upgradeVnReplyReadyFiles(upgradeVnCustomChoiceLabelFiles(files));

test("stock readers with original, recent, or italic custom labels receive the canonical ready cue", () => {
  for (const label of ['<span>...</span>', '<span>Write your own</span>', '<ChoiceText text="Write your own" />']) {
    const source = oldRoot.replace('<ChoiceText text="Write your own" />', label);
    const files = { "index.tsx": source, "styles.ts": oldStyles };
    const next = upgrade(files);
    assert.equal(next["index.tsx"], currentRoot);
    assert.equal(next["styles.ts"], currentStyles);
    assert.equal(files["index.tsx"], source, "input remains immutable");
    assert.equal(upgrade(next), next, "applying twice preserves identity");
  }
});

test("nested stock readers sharing a stylesheet preserve authored files and unrelated edits", () => {
  const authoredRoot = oldRoot + "// creator story integration\n";
  const authoredStyles = oldStyles.replace("`;", ".creator-theme{color:gold}\n`;");
  const files = { "ui/root.tsx": authoredRoot, "ui/other.tsx": authoredRoot, "ui/styles.ts": authoredStyles, "sprites.ts": "creator artwork", "story.ts": "creator story" };
  const next = upgradeVnReplyReadyFiles(files);
  assert.equal(next["ui/root.tsx"], currentRoot + "// creator story integration\n");
  assert.equal(next["ui/other.tsx"], next["ui/root.tsx"]);
  assert.match(next["ui/styles.ts"], /\.creator-theme\{color:gold\}/);
  assert.equal(next["ui/styles.ts"].split('.vn-reply-ready{').length, 2);
  assert.equal(next["sprites.ts"], files["sprites.ts"]);
  assert.equal(next["story.ts"], files["story.ts"]);
  assert.equal(upgradeVnReplyReadyFiles(next), next);
});

test("custom handlers, choice UI, layout, partial upgrades and missing dependencies remain untouched", () => {
  const cases: Record<string, string>[] = [
    { "index.tsx": oldRoot.replace('if (scrollPassage()) return;', 'if (customReader()) return;'), "styles.ts": oldStyles },
    { "index.tsx": oldRoot.replace('playerSpriteRequest.current = null; setPendingPlayerSprite(null);', 'customAdvance();'), "styles.ts": oldStyles },
    { "index.tsx": oldRoot.replace('onClick={advance} aria-label="Current passage"', 'onClick={customAdvance} aria-label="Current passage"'), "styles.ts": oldStyles },
    { "index.tsx": oldRoot.replace('setPanel("composer")}><span className="vn-choice-icon"', 'openCustomComposer()}><span className="vn-choice-icon"'), "styles.ts": oldStyles },
    { "index.tsx": oldRoot.replace('from "./styles"', 'from "../creator/styles"'), "styles.ts": oldStyles },
    { "index.tsx": oldRoot, "styles.ts": oldStyles.replace('bottom:calc(85px + var(--error-space,0px));', 'bottom:99px;') },
    { "index.tsx": oldRoot, "styles.ts": oldStyles + 'export const custom = `creator`;\n' },
    { "index.tsx": oldRoot.replace('const pendingPlayerLines =', 'const customPlayerLines ='), "styles.ts": oldStyles },
    { "index.tsx": oldRoot },
    { "index.tsx": currentRoot, "styles.ts": oldStyles },
    { "index.tsx": oldRoot, "styles.ts": currentStyles },
    { "index.tsx": oldRoot.replace('  const end = index >= lines.length - 1;', '  const end = index >= lines.length - 1;\n  const end = index >= lines.length - 1;'), "styles.ts": oldStyles },
  ];
  for (const files of cases) assert.equal(upgradeVnReplyReadyFiles(files), files);
});
