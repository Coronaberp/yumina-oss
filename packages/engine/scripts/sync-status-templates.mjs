import { readFileSync, writeFileSync } from 'node:fs';
const writeChanged = (url, content) => { let previous; try { previous = readFileSync(url, 'utf8'); } catch {} if (previous !== content) writeFileSync(url, content); };
const source = new URL('../../../interfaces/vn/', import.meta.url);
// One syntax implementation serves new model output and sandboxed saved cards.
for (const [engineFile, cardFile] of [['sprite-expressions.ts', 'expressions.ts'], ['presentation-literals.ts', 'presentation-literals.ts'], ['presentation-markup.ts', 'presentation-markup.ts'], ['response-choices.ts', 'choices.ts'], ['response-metadata.ts', 'metadata.ts']]) {
  const shared = readFileSync(new URL('../src/parser/' + engineFile, import.meta.url), 'utf8')
    .replaceAll('../prompts/speaker-tag.js', './speaker-tag')
    .replaceAll('./presentation-literals.js', './presentation-literals')
    .replaceAll('./text-normalization.js', './text-normalization')
    .replaceAll('./sprite-expressions.js', './expressions');
  writeChanged(new URL(cardFile, source), shared);
}
const dialogue = readFileSync(new URL('dialogue-spans.ts', source), 'utf8').replace('from "./speaker-tag"', 'from "@yumina/engine"').replace('from "./presentation-literals"', 'from "@yumina/engine"');
writeChanged(new URL('../../app/sandbox/chat/dialogue-spans.ts', import.meta.url), dialogue);
const target = new URL('../src/world/status-templates.generated.ts', import.meta.url);
const names = ['status-data.ts', 'status-view.tsx', 'status-gauge.tsx', 'status-widgets.tsx', 'status-sheet.tsx', 'status-layout.tsx'];
const templates = Object.fromEntries(names.map(name => [name, readFileSync(new URL(name, source), 'utf8')]));
const content = '// Generated from interfaces/vn by scripts/sync-status-templates.mjs.\nexport const statusTemplates: Record<string, string> = ' + JSON.stringify(templates, null, 2) + ';\n';
let previous;
try { previous = readFileSync(target, 'utf8'); } catch { /* First build. */ }
if (previous !== content) writeFileSync(target, content);

const personaFiles = Object.fromEntries(['player.ts', 'passages.ts', 'dialogue-spans.ts', 'vn-dialogue-spans.ts', 'choice-text.tsx', 'persona-menu.ts', 'choices.ts', 'metadata.ts', 'presentation-literals.ts', 'presentation-markup.ts', 'speaker.ts', 'speaker-tag.ts', 'expressions.ts', 'text-normalization.ts'].map(name => [name, readFileSync(new URL(name, source), 'utf8')]));
const personaTarget = new URL('../src/world/persona-templates.generated.ts', import.meta.url);
const personaContent = '// Generated from interfaces/vn; do not edit.\nexport const personaTemplates: Record<string, string> = ' + JSON.stringify(personaFiles, null, 2) + ';\n';
let oldPersona;
try { oldPersona = readFileSync(personaTarget, 'utf8'); } catch {}
if (oldPersona !== personaContent) writeFileSync(personaTarget, personaContent);

// Keep the narrowly scoped saved-card sprite upgrader in step with its source.
await import("./sync-sprite-runtime.mjs");
