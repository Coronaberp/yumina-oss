const hook = '      <div data-turn-id={message.id} aria-hidden="true" />\n      {!characters.length && <Thinking api={api} key={`${message.id}:${message.activeSwipeIndex || 0}`} text={swipe?.reasoningContent} />}\n';
const details = '      {!characters.length && <TurnDetails key={`details:${message.id}:${message.activeSwipeIndex || 0}`} message={message} lines={sourceLines} />}\n';
const importLine = 'import { TurnDetails } from "./turn-details";\n';
const context = [
  'function DialogueLog({ api, onClose, currentTurnId, onCharacter, blocked }) {',
  'const renderedRows = React.useMemo(() => visible.map(({ message, lines, sourceLines }) => {',
  'const swipe = message.swipes?.[message.activeSwipeIndex || 0];',
  'const lines = reusable ? previous.row.lines : message.role === "user" ? [] : messagePassages(api, message);',
];

/** Add only the exact shipped log hook; preserve custom layouts and helpers. */
export function upgradeVnTurnDetailsFiles(files: Record<string, string>, helperSource: string): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith('.tsx') || !helperSource || source.includes('TurnDetails')
      || source.split(hook).length !== 2 || !context.every(anchor => source.includes(anchor))) continue;
    const helper = name.slice(0, name.lastIndexOf('/') + 1) + 'turn-details.tsx';
    if (files[helper] !== undefined && files[helper] !== helperSource) continue;
    if (updated === files) updated = { ...files };
    updated[name] = importLine + source.replace(hook, hook + details);
    updated[helper] = helperSource;
  }
  return updated;
}
