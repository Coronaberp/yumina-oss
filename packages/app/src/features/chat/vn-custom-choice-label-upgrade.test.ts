import assert from "node:assert/strict";
import test from "node:test";
import { upgradeVnCustomChoiceLabelFiles } from "./vn-custom-choice-label-upgrade";

const stock = '<button className="vn-choice vn-custom-choice" aria-label="Write your own choice" disabled={api.readOnly || generatingChoices || !personaControl.ready || personaControl.saving} onClick={() => setPanel("composer")}><span className="vn-choice-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: choiceIcon }} /><span>...</span></button>';
const plain = stock.replace('<span>...</span>', '<span>Write your own</span>');
const labeled = stock.replace('<span>...</span>', '<ChoiceText text="Write your own" />');
const reader = (button: string) => `import { ChoiceText, plainChoiceText } from "./choice-text";\nconst api = useYumina();\n<main className="vn"><button className="vn-stage" />${button}</main>\n// authored handler stays here`;

test("saved stock custom-choice buttons gain the standard italic action label while authored code stays intact", () => {
  const files = { "__user-root.tsx": reader(stock), "ui/root.tsx": reader(plain), "index.tsx": "composed root", "styles.ts": "creator styles" };
  const next = upgradeVnCustomChoiceLabelFiles(files);
  assert.equal(next["__user-root.tsx"], reader(labeled));
  assert.equal(next["ui/root.tsx"], reader(labeled));
  assert.equal(next["index.tsx"], files["index.tsx"]);
  assert.equal(next["styles.ts"], files["styles.ts"]);
  assert.equal(files["__user-root.tsx"], reader(stock));
  assert.equal(upgradeVnCustomChoiceLabelFiles(next), next);
});

test("already italic stock buttons retain their files and identity", () => {
  const files = { "index.tsx": reader(labeled) };
  assert.equal(upgradeVnCustomChoiceLabelFiles(files), files);
});

test("authored custom-choice handlers, icons, labels and unrelated ellipses remain intact", () => {
  for (const source of [
    stock.replace('setPanel("composer")', 'openMyComposer()'),
    stock.replace('aria-label="Write your own choice"', 'aria-label="Custom action"'),
    stock.replace('__html: choiceIcon', '__html: myIcon'),
    stock.replace('vn-choice vn-custom-choice', 'my-choice vn-custom-choice'),
    stock.replace('<span>...</span>', '<span>My response</span>'),
    '<button>...</button>',
  ]) {
    const files = { "index.tsx": reader(source) };
    assert.equal(upgradeVnCustomChoiceLabelFiles(files), files);
  }
});

test("older stock buttons retain their original disabled conditions", () => {
  for (const label of ['<span>...</span>', '<span>Write your own</span>']) {
    const old = stock.replace(' || !personaControl.ready || personaControl.saving', '').replace('<span>...</span>', label);
    const files = { 'index.tsx': reader(old) };
    assert.equal(upgradeVnCustomChoiceLabelFiles(files)['index.tsx'], reader(old.replace(label, '<ChoiceText text="Write your own" />')));
  }
});

test("missing ChoiceText imports and duplicate stock buttons stay untouched", () => {
  for (const source of [reader(stock).replace('import { ChoiceText, plainChoiceText } from "./choice-text";\n', ''), reader(stock + stock)]) {
    const files = { 'index.tsx': source };
    assert.equal(upgradeVnCustomChoiceLabelFiles(files), files);
  }
});
