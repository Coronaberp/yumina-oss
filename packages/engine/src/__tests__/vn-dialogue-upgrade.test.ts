import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { upgradePersonaRoot } from "../world/persona-runtime-upgrade.js";
import type { RootComponent } from "../types/index.js";

const source = new URL("../../../../interfaces/vn/", import.meta.url);
const oldGuard = `if (closing && !(text[i] === "'" && word(text[i - 1]))) {`;
const oldChoiceSpans = `function choiceSpans(text) {
  return dialogueSpans(text).map(span => ({
    ...span,
    text: span.kind === "action"
      ? span.text.replace(/^(\\*{1,3}|_{1,3})([\\s\\S]*?)\\1$/, "$2")
      : span.kind === "dialogue" ? plainDialogue(span.text) : span.text,
  }));
}`;

function savedRoot(): RootComponent {
  let dialogue = readFileSync(new URL("dialogue-spans.ts", source), "utf8");
  dialogue = dialogue.replace(/^.*if \(closing &&.*$/m, `    ${oldGuard}`);
  let passages = readFileSync(new URL("passages.ts", source), "utf8");
  passages = passages.replace(/^.*const chunkHasQuotes =.*\n/m, "")
    .replace('(!chunkHasQuotes && chunk.explicit && tagged)', '(chunk.explicit && tagged)');
  return {
    entryFile: "index.tsx", compiled: "saved old compilation", files: {
      "index.tsx": 'function Menu({ api, onClose, setPanel, settings, onSetting, busy, run }) {}',
      "dialogue-spans.ts": dialogue + "\n// Authored helper customization stays.\n",
      "passages.ts": passages + "\n// Authored paging customization stays.\n",
    },
  } as RootComponent;
}

it("upgrades recognized saved VN apostrophe and narration helpers in memory", () => {
  const root = savedRoot();
  const upgraded = upgradePersonaRoot(root);
  expect(upgraded).not.toBe(root);
  expect(upgraded.files!["dialogue-spans.ts"]).not.toContain(oldGuard);
  expect(upgraded.files!["passages.ts"]).toContain("const chunkHasQuotes =");
  expect(upgraded.files!["dialogue-spans.ts"]).toContain("Authored helper customization stays.");
  expect(upgraded.files!["passages.ts"]).toContain("Authored paging customization stays.");
  expect(upgraded.compiled).toBeUndefined();
  expect(root.compiled).toBe("saved old compilation");
  expect(root.files!["dialogue-spans.ts"]).toContain(oldGuard);
  expect(upgradePersonaRoot(upgraded)).toBe(upgraded);
});

it("does not change an unrelated authored renderer", () => {
  const root = savedRoot();
  root.files!["index.tsx"] = "export default function Custom(){ return null; }";
  expect(upgradePersonaRoot(root)).toBe(root);
});

it("upgrades saved choice labels without replacing authored interface code", () => {
  const root = savedRoot();
  root.files!["index.tsx"] = readFileSync(new URL("index.tsx", source), "utf8")
    .replace(/^import \{ ChoiceText, plainChoiceText \} from "\.\/choice-text";\n/m, "")
    .replace('<ChoiceText text={playerText(choice, api.user?.name)} />', '<span>{choice}</span>')
    .replace('aria-label={plainChoiceText(playerText(choice, api.user?.name))}', 'aria-label={choice}') + '\n// Authored menu stays.\n';
  const upgraded = upgradePersonaRoot(root);
  expect(upgraded.files!["index.tsx"]).toContain('<ChoiceText text={playerText(choice, api.user?.name)} />');
  expect(upgraded.files!["index.tsx"]).toContain('aria-label={plainChoiceText(playerText(choice, api.user?.name))}');
  expect(upgraded.files!["choice-text.tsx"]).toContain('export function ChoiceText');
  expect(upgraded.files!["index.tsx"]).toContain('Authored menu stays.');
  expect(root.files!["index.tsx"]).toContain('<span>{choice}</span>');
  expect(upgradePersonaRoot(upgraded)).toBe(upgraded);
});

it('repairs the shipped saved choice formatter while retaining surrounding custom code', () => {
  const root = savedRoot();
  const sourceFile = readFileSync(new URL('choice-text.tsx', source), 'utf8');
  root.files['choice-text.tsx'] = sourceFile.replace(/function choiceSpans[\s\S]*?(?=\n\nexport function plainChoiceText)/, oldChoiceSpans) + '\n// Authored choice customization stays.\n';
  const upgraded = upgradePersonaRoot(root);
  expect(upgraded.files['choice-text.tsx']).not.toContain(oldChoiceSpans);
  expect(upgraded.files['choice-text.tsx']).toContain('action.endsWith(marker)');
  expect(upgraded.files['choice-text.tsx']).toContain('Authored choice customization stays.');
});

it('moves the old shipped Persona button into a greeting-only row without touching status configuration', () => {
  const root = savedRoot();
  let index = readFileSync(new URL('index.tsx', source), 'utf8');
  const row = /          <div className="vn-menu-action-row vn-menu-persona-row"[\s\S]*?\n          <\/div>/.exec(index)![0];
  index = index.replace(row, '').replace('import { canSelectPersona } from "./persona-menu";\n', '').replace('  const personaAvailable = canSelectPersona(api);\n', '');
  const button = '{api.sessionId && !api.readOnly && <button className="vn-menu-item vn-menu-persona" onClick={() => { onClose(); api.openPersonaManager(); }}><Icons.UserRound /><span>Persona</span></button>}';
  index = index.replace('            <button className="vn-menu-item" onClick={() => setPanel("settings")}', `            ${button}\n            <button className="vn-menu-item" onClick={() => setPanel("settings")}`);
  root.files['index.tsx'] = index + '\n// Authored menu customization stays.\n';
  root.files['status-config.ts'] = 'CUSTOM_STATS';
  const upgraded = upgradePersonaRoot(root);
  expect(upgraded.files['index.tsx']).not.toContain(button);
  expect(upgraded.files['index.tsx']).toContain('vn-menu-persona-row');
  expect(upgraded.files['index.tsx']).toContain('const personaAvailable = canSelectPersona(api)');
  expect(upgraded.files['index.tsx']).toContain('Authored menu customization stays.');
  expect(upgraded.files['persona-menu.ts']).toContain('api.personaSelectable !== true');
  expect(upgraded.files['status-config.ts']).toBe('CUSTOM_STATS');
  expect(upgraded.files['index.tsx']).toContain('gridColumn: personaAvailable ? 2 : "1 / -1"');
});

it('centers the shipped Export button when Persona is hidden without replacing custom menu code', () => {
  const root = savedRoot();
  root.files['index.tsx'] = readFileSync(new URL('index.tsx', source), 'utf8')
    .replace('style={{ gridColumn: personaAvailable ? 2 : "1 / -1", justifySelf: personaAvailable ? undefined : "center", width: personaAvailable ? undefined : "fit-content" }}', 'style={{ gridColumn: 2 }}')
    + '\n// Authored menu customization stays.\n';
  root.files['persona-menu.ts'] = readFileSync(new URL('persona-menu.ts', source), 'utf8');
  const upgraded = upgradePersonaRoot(root);
  expect(upgraded.files['index.tsx']).toContain('gridColumn: personaAvailable ? 2 : "1 / -1"');
  expect(upgraded.files['index.tsx']).toContain('Authored menu customization stays.');
  expect(root.files['index.tsx']).toContain('style={{ gridColumn: 2 }}');
  expect(upgradePersonaRoot(upgraded)).toBe(upgraded);
});
