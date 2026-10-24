const previousStockHelper = "import { messagePassages } from \"./passages\";\n\nconst keyFor = line => line.kind === \"dialogue\" && line.name === \"NPC\" && !line.player\n  && /^(male|female)$/.test(line.npcGender || \"\") && typeof line.npcId === \"string\"\n  && line.npcId.trim() && line.npcId.toLowerCase() !== \"unknown\"\n  ? `${line.npcGender}:${line.npcId}` : null;\n\nconst selectedContentMatches = message => !Array.isArray(message?.swipes) || !message.swipes.length\n  || typeof message.swipes[message.activeSwipeIndex || 0]?.content === \"string\"\n    && message.swipes[message.activeSwipeIndex || 0].content === message.content;\n\nfunction disclosedName(text) {\n  // Only a direct self-introduction at the start of this NPC's displayed\n  // dialogue. Quoted reports, questions, markers and profile text cannot name it.\n  const prefix = /^(?:my name is|call me)\\s+/i.exec(text.trim());\n  if (!prefix) return null;\n  if ([...text.matchAll(/\\b(?:my name is|call me)\\s+/gi)].length !== 1) return \"\";\n  const name = /^([\\p{Lu}\\p{Lo}][\\p{L}\\p{M}'’-]*(?:[ \\t]+[\\p{Lu}\\p{Lo}][\\p{L}\\p{M}'’-]*){0,3})(?=[.!,:;]|$)/u.exec(text.trim().slice(prefix[0].length));\n  return name?.[1] || null;\n}\n\n/** Read-only display aliases, earned after the introduction page. Recompute\n * from the selected history/prefix so rewinds and branch changes forget them.\n * Never replace canonical names, stable NPC IDs, sprite keys or stat ownership. */\nexport function npcSpeakerLabels(api, message, lines) {\n  const defaults = lines.map(line => line.name || (line.kind === \"dialogue\" ? \"NPC\" : \"\"));\n  if (!lines.some(keyFor) || !selectedContentMatches(message)) return defaults;\n  const names = new Map();\n  const learn = line => {\n    const key = keyFor(line), name = key && disclosedName(line.text || \"\");\n    if (!key || name === null) return;\n    if (!names.has(key)) names.set(key, new Set());\n    names.get(key).add(name);\n  };\n  const messages = api.messages || [], at = message?.id ? messages.findIndex(item => item.id === message.id) : -1;\n  for (const prior of messages.slice(0, Math.max(0, at))) {\n    if (prior.role !== \"assistant\" || prior.status === \"failed\" || !selectedContentMatches(prior) || !/\\b(?:my name is|call me)\\s+/i.test(prior.content || \"\")) continue;\n    // The active displayed content is authoritative; raw/inactive swipes never\n    // supply an introduction, even if they contain additional speaker metadata.\n    for (const line of messagePassages(api, { content: prior.content })) learn(line);\n  }\n  return lines.map((line, index) => {\n    const known = names.get(keyFor(line));\n    const label = known?.size === 1 ? [...known][0] : \"\";\n    learn(line);\n    return label || defaults[index];\n  });\n}\n";

const importAnchor = 'import { useMetCharacters, visibleCharacterStatus } from "./character-visibility";';
const importLine = 'import { npcSpeakerLabels } from "./npc-display-name";';
const viewLines = '  const lines = pendingPlayerLine ? pendingPlayerLines : replyLines;';
const logRows = '  const renderedRows = React.useMemo(() => visible.map(({ message, lines, sourceLines }) => {';
const logName = '<SpeakerName name={line.name || "NPC"} className="vn-speaker-name" />';
const stageName = '<SpeakerName name={line.name || (line.kind === "dialogue" ? "NPC" : "")} className="vn-name" truncate={false} />';

/** Upgrade only the shipped display hooks. Preserve all authored passages,
 * canonical identities, viewer behavior, art mappings and custom label code. */
export function upgradeVnNpcLabelFiles(files: Record<string, string>, helperSource: string): Record<string, string> {
  let updated = files;
  // Refresh a shipped helper by exact bytes even when its reader hooks already
  // exist. A creator-modified helper or reader is never replaced.
  for (const [name, source] of Object.entries(files)) {
    if ((name === 'npc-display-name.ts' || name.endsWith('/npc-display-name.ts'))
      && source === previousStockHelper && source !== helperSource) {
      if (updated === files) updated = { ...files };
      updated[name] = helperSource;
    }
  }
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith('.tsx') || !source.includes('function DialogueLog(') || !source.includes('className="vn-stage"')
      || source.includes('npcSpeakerLabels') || source.includes('const npcLabels')
      || [importAnchor, viewLines, logRows, logName, stageName].some(anchor => source.split(anchor).length !== 2)) continue;
    const helper = name.slice(0, name.lastIndexOf('/') + 1) + 'npc-display-name.ts';
    if (updated[helper] !== undefined && updated[helper] !== helperSource) continue;
    if (updated === files) updated = { ...files };
    updated[helper] = helperSource;
    updated[name] = source.replace(importAnchor, importAnchor + '\n' + importLine)
      .replace(viewLines, viewLines + '\n  const npcLabels = npcSpeakerLabels(sceneApi, currentMessage, lines);')
      .replace(logRows, logRows + '\n    const npcLabels = npcSpeakerLabels(api, message, sourceLines);')
      .replace(logName, logName.replace('name={', 'name={npcLabels[sourceLines.indexOf(line)] || '))
      .replace(stageName, stageName.replace('name={', 'name={npcLabels[index] || '));
  }
  return updated;
}
