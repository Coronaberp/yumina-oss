import { upgradeVnSpriteFiles } from "./vn-sprite-runtime-upgrade.js";
import type { RootComponent, WorldDefinition } from "../types/index.js";
import { personaTemplates } from "./persona-templates.generated.js";
import { formattingUpgradeBases } from "./formatting-upgrade-bases.generated.js";

/** Upgrade recognizable shipped VN helpers in memory; never write an authored card. */
export function upgradePersonaRoot<T extends RootComponent | undefined>(root: T): T {
  if (!root?.files) return root;
  try {
    const spriteFiles=upgradeVnSpriteFiles(root.files);
    if(spriteFiles!==root.files) return upgradePersonaRoot({...root,files:spriteFiles,compiled:undefined} as T);
  } catch { /* Unknown authored sprite code stays intact for an explicit reviewed update. */ }
  const index = root.files[root.entryFile];
  if (!index?.includes('function Menu({ api, onClose, setPanel, settings, onSetting, busy, run })')) return root;
  const files = { ...root.files };
  const upgradeFormatting = () => {
    const dependencies = ['presentation-literals.ts', 'presentation-markup.ts', 'vn-dialogue-spans.ts'];
    if (dependencies.some(name => files[name] && files[name] !== personaTemplates[name])) return;
    let changed = false;
    for (const [name, bases] of Object.entries(formattingUpgradeBases)) {
      if (bases.includes(files[name] || "") && files[name] !== personaTemplates[name]) {
        files[name] = personaTemplates[name]!; changed = true;
      }
    }
    if (changed) for (const name of dependencies) files[name] = personaTemplates[name]!;
  };
  upgradeFormatting();
  let source = index;
  const oldPlayerLine = '  const pendingPlayerLine = pendingPlayerSprite ? { name: sceneApi.user?.name || "You", kind: "dialogue", player: true, emotion: pendingPlayerSprite.expression, text: pendingPlayerSprite.text } : null;';
  const choiceParser = files['passages.ts'] || "";
  const compatibleChoiceParser = choiceParser.includes('export function messagePassages(api, message)')
    && choiceParser.includes('function pages(text)')
    && (choiceParser.includes('import { dialogueSpans, plainDialogue } from "./dialogue-spans";') || choiceParser.includes('from "./vn-dialogue-spans";'))
    && choiceParser.includes('import { stripZeroWidthSpaces } from "./text-normalization";')
    && Boolean(files['dialogue-spans.ts'] && files['text-normalization.ts']);
  if (source.includes(oldPlayerLine) && compatibleChoiceParser) {
    const helper = /export function playerChoicePassages[\s\S]*?(?=\nexport function messageChoices)/.exec(personaTemplates['passages.ts'] || '')?.[0];
    if (helper) {
      if (!choiceParser.includes('export function playerChoicePassages')) files['passages.ts'] = choiceParser + '\n' + helper + '\n';
      source = source
        .replace('import { passages, messagePassages, segmentPassages, messageChoices } from "./passages";', 'import { passages, messagePassages, segmentPassages, messageChoices, playerChoicePassages } from "./passages";')
        .replace(oldPlayerLine, '  const pendingPlayerLines = pendingPlayerSprite ? playerChoicePassages(pendingPlayerSprite.text, sceneApi.user, pendingPlayerSprite.expression) : [];\n  const pendingPlayerLine = !!pendingPlayerLines.length;')
        .replace('const lines = pendingPlayerLine ? [pendingPlayerLine] : replyLines;', 'const lines = pendingPlayerLine ? pendingPlayerLines : replyLines;')
        .replace('pendingPlayerLine ? 0 : cursor.turn === turn', 'pendingPlayerLine ? pendingPlayerSprite.index || 0 : cursor.turn === turn')
        .replace('<Control name="Skip" onClick={() => { setAuto(false); setCursor({ turn, index: Math.max(0, lines.length - 1) }); }} />', '<Control name="Skip" onClick={() => { setAuto(false); if (pendingPlayerSprite) setPendingPlayerSprite(current => current ? { ...current, index: Math.max(0, lines.length - 1) } : current); else setCursor({ turn, index: Math.max(0, lines.length - 1) }); }} />')
        .replace('expression: "normal", text: playerText(choice, api.user?.name)', 'expression: "normal", index: 0, text: playerText(choice, api.user?.name)')
        .replace('if (hydrated && !api.isStreaming) api.storage.set(cursorKey,', 'if (hydrated && !api.isStreaming && !pendingPlayerSprite) api.storage.set(cursorKey,')
        .replace('[hydrated, cursorKey, turn, index, api.isStreaming]);', '[hydrated, cursorKey, turn, index, api.isStreaming, pendingPlayerSprite]);');
      const oldAdvance = '      if (direction > 0 && lastMessage?.role === "assistant" && lastMessage.id !== playerSpriteRequest.current?.baseMessageId) {';
      if (source.includes(oldAdvance)) {
        source = source.replace('if (panel || viewerOpen || loading || api.isStreaming || error || !line) return;', 'if (panel || viewerOpen || error || !line) return;')
          .replace(oldAdvance, '      if (direction > 0 && !end || direction < 0 && index > 0) {\n        setPendingPlayerSprite(current => current ? { ...current, index: index + direction } : current);\n      } else if (direction > 0 && !loading && !api.isStreaming && lastMessage?.role === "assistant" && lastMessage.id !== playerSpriteRequest.current?.baseMessageId) {')
          .replace('    if (direction > 0) {\n      if (!end) setCursor', '    if (loading || api.isStreaming) return;\n    if (direction > 0) {\n      if (!end) setCursor');
      }
    }
  }
  const layoutAnchor = '      node.style.setProperty("--cast-top", `${top}px`);';
  if (source.includes(layoutAnchor) && !source.includes('"--choices-bottom"')) {
    source = source.replace(layoutAnchor, layoutAnchor + '\n      const dialogue = node.querySelector(".vn-dialogue");\n      if (dialogue) {\n        const bottom = bounds.bottom - dialogue.getBoundingClientRect().top + 16;\n        node.style.setProperty("--choices-bottom", `${bottom}px`);\n        node.style.setProperty("--choices-max-height", `${Math.max(44, bounds.height - bottom - top)}px`);\n      }');
  }
  const style = files['styles.ts'];
  if (source.includes('"--choices-bottom"') && style && /^(?:\s|\/\/[^\n]*\n)*export const styles = `/.test(style) && !style.includes('--choices-max-height')) {
    files['styles.ts'] = style.replace(/`;?\s*$/, '\n@media(min-width:901px) and (min-height:601px){.vn-choices{bottom:var(--choices-bottom,25%);max-height:var(--choices-max-height,60%)}}\n`;\n');
  }
  if (!source.includes('from "./player"')) source = 'import { playerText } from "./player";\n' + source;
  source = source.replace('function Thinking({ text })', 'function Thinking({ api, text })')
    .replaceAll('<Thinking text=', '<Thinking api={api} text=')
    .replaceAll('<Thinking key=', '<Thinking api={api} key=')
    .replace('<pre>{text}</pre>', '<pre>{playerText(text, api.user?.name)}</pre>')
    .replaceAll('aria-label={choice}', 'aria-label={playerText(choice, api.user?.name)}')
    .replaceAll('<span>{choice}</span>', '<span>{playerText(choice, api.user?.name)}</span>')
    .replaceAll('playerText(text)', 'playerText(text, api.user?.name)');
  const menuAnchor = '            <button className="vn-menu-item" onClick={() => setPanel("settings")}';
  if (!source.includes('api.openPersonaManager()') && source.includes(menuAnchor)) {
    source = source.replace(menuAnchor, '            {api.sessionId && !api.readOnly && <button className="vn-menu-item vn-menu-persona" onClick={() => { onClose(); api.openPersonaManager(); }}><Icons.UserRound /><span>Persona</span></button>}\n' + menuAnchor);
  }
  const legacyPersona = '{api.sessionId && !api.readOnly && <button className="vn-menu-item vn-menu-persona" onClick={() => { onClose(); api.openPersonaManager(); }}><Icons.UserRound /><span>Persona</span></button>}';
  const settingsRowEnd = '            <button className="vn-menu-item" onClick={() => setPanel("settings")}><MenuIcon api={api} name="settings" /><span>Settings</span></button>\n          </div>';
  if (source.includes(legacyPersona) && source.includes(settingsRowEnd) && !source.includes('vn-menu-persona-row') && !files['persona-menu.ts']) {
    source = 'import { canSelectPersona } from "./persona-menu";\n' + source.replace(legacyPersona, '')
      .replace('function Menu({ api, onClose, setPanel, settings, onSetting, busy, run }) {', 'function Menu({ api, onClose, setPanel, settings, onSetting, busy, run }) {\n  const personaAvailable = canSelectPersona(api);')
      .replace(settingsRowEnd, settingsRowEnd + '\n          <div className="vn-menu-action-row vn-menu-persona-row" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>\n            {personaAvailable && <button className="vn-menu-item vn-menu-persona" onClick={() => { onClose(); api.openPersonaManager(); }}><Icons.UserRound /><span>Persona</span></button>}\n            <button type="button" className="vn-menu-item vn-menu-export" style={{ gridColumn: 2 }} onClick={event => event.stopPropagation()}><Icons.Download /><span>Export</span></button>\n          </div>');
    files['persona-menu.ts'] = personaTemplates['persona-menu.ts']!;
  }
  if (source.includes('const personaAvailable = canSelectPersona(api);')) {
    source = source.replace('<button type="button" className="vn-menu-item vn-menu-export" style={{ gridColumn: 2 }}', '<button type="button" className="vn-menu-item vn-menu-export" style={{ gridColumn: personaAvailable ? 2 : "1 / -1", justifySelf: personaAvailable ? undefined : "center", width: personaAvailable ? undefined : "fit-content" }}');
  }
  source = source.replace('assetRef={line.portrait} name={line.name} npcGender={line.npcGender}', 'assetRef={line.portrait} name={line.name} player={line.player} npcGender={line.npcGender}');
  if (source.includes('choices.map((choice, i)') && source.includes('<span>{playerText(choice, api.user?.name)}</span>') && files['dialogue-spans.ts']
    && !files['choice-text.tsx'] && personaTemplates['choice-text.tsx']) {
    source = 'import { ChoiceText, plainChoiceText } from "./choice-text";\n' + source
      .replace('<span>{playerText(choice, api.user?.name)}</span>', '<ChoiceText text={playerText(choice, api.user?.name)} />')
      .replace('aria-label={playerText(choice, api.user?.name)}', 'aria-label={plainChoiceText(playerText(choice, api.user?.name))}');
    files['choice-text.tsx'] = personaTemplates['choice-text.tsx'];
  }
  const oldChoiceSpans = `function choiceSpans(text) {
  return dialogueSpans(text).map(span => ({
    ...span,
    text: span.kind === "action"
      ? span.text.replace(/^(\\*{1,3}|_{1,3})([\\s\\S]*?)\\1$/, "$2")
      : span.kind === "dialogue" ? plainDialogue(span.text) : span.text,
  }));
}`;
  const currentChoiceSpans = /function choiceSpans[\s\S]*?(?=\n\nexport function plainChoiceText)/.exec(personaTemplates['choice-text.tsx'] || '')?.[0];
  if (currentChoiceSpans && files['choice-text.tsx']?.includes(oldChoiceSpans)) files['choice-text.tsx'] = files['choice-text.tsx'].replace(oldChoiceSpans, () => currentChoiceSpans);
  files[root.entryFile] = source;
  // Only replace the old shipped perspective helper and its known passage shape.
  const oldPlayer = files['player.ts'];
  if (oldPlayer?.includes('export function playerText(text: string): string') && (!oldPlayer.includes('const verbs:') || oldPlayer.includes('const word = possessive ? "your" : "you";'))) files['player.ts'] = personaTemplates['player.ts']!;
  const viewer = files['character-viewer.tsx'];
  if (viewer?.includes('export function CharacterCopy({ api, text,')) files['character-viewer.tsx'] = viewer.replaceAll('playerText(text)', 'playerText(text, api.user?.name)');
  const passages = files['passages.ts'];
  if (passages?.includes('export function messagePassages(api, message)') && passages.includes('portrait: definedSpeaker?.portrait || null,') && !passages.includes('const playerSpeaker =')) {
    // Patch only the shipped attribution anchors; preserve custom paging/parser code.
    files['passages.ts'] = passages
      .replace('rawContent = content) {', 'rawContent = content, player = null) {')
      .replace('  return chunks.flatMap(chunk => {', '  const playerSpeaker = name => /^(?:\\{\\{user\\}\\}|you|user|player)$/i.test(name || "") || !!player?.name && String(name).toLocaleLowerCase() === player.name.toLocaleLowerCase() && !character(entries, name);\n  return chunks.flatMap(chunk => {')
      .replace('    const known = character(entries, chunk.name);', '    const declared = character(entries, chunk.name);\n    const known = declared || (playerSpeaker(chunk.name) ? { name: chunk.name, role: "character", enabled: true, portrait: player?.avatar || null } : null);')
      .replace('    const speakerEntries = !known && explicitSpeaker ? [...(entries || []), explicitSpeaker] : entries;', '    const speakerEntries = known && !declared ? [...(entries || []), known] : !known && explicitSpeaker ? [...(entries || []), explicitSpeaker] : entries;')
      .replace('        const definedSpeaker = spoken && speaker ? character(entries, speaker.name) : null;', '        const isPlayer = spoken && !!speaker && playerSpeaker(speaker.name);\n        const definedSpeaker = spoken && speaker && !isPlayer ? character(entries, speaker.name) : null;')
      .replace('name: spoken ? definedSpeaker ?', 'name: isPlayer ? player?.name ? `${player.name} (You)` : "You" : spoken ? definedSpeaker ?')
      .replace('portrait: definedSpeaker?.portrait || null,', 'portrait: isPlayer ? player?.avatar || null : definedSpeaker?.portrait || null,\n          ...(isPlayer ? { player: true } : {}),')
      .replace('swipe?.rawContent || message.content);', 'swipe?.rawContent || message.content, api.user);');
  }
  // Repair only recognizable shipped parser anchors, keeping authored helpers
  // and paging intact. Saved replies and stored card files stay unchanged.
  const dialogue = files['dialogue-spans.ts'];
  const oldQuoteGuard = `if (closing && !(text[i] === "'" && word(text[i - 1]))) {`;
  const currentQuoteGuard = personaTemplates['dialogue-spans.ts']?.split('\n').find(line => line.includes('if (closing &&'))?.trim();
  if (dialogue?.includes('export function dialogueSpans(text: string): DialogueSpan[]') && currentQuoteGuard) {
    files['dialogue-spans.ts'] = dialogue.replace(oldQuoteGuard, currentQuoteGuard);
  }
  const currentPassages = files['passages.ts'];
  const sectionsAnchor = '    return splitSpeakerSections(speakerEntries, chunk.text, tag + chunk.text, chunk.explicit).flatMap(section => {';
  const oldSpoken = 'span.kind === "text" && !hasQuotes && !!(section.speaker || (chunk.explicit && tagged))';
  if (currentPassages?.includes('export function messagePassages(api, message)') && currentPassages.includes(sectionsAnchor)
    && currentPassages.includes(oldSpoken) && !currentPassages.includes('const chunkHasQuotes =')) {
    files['passages.ts'] = currentPassages
      .replace(sectionsAnchor, '    const chunkHasQuotes = dialogueSpans(chunk.text).some(span => span.kind === "dialogue");\n' + sectionsAnchor)
      .replace(oldSpoken, 'span.kind === "text" && !hasQuotes && !!(section.speaker || (!chunkHasQuotes && chunk.explicit && tagged))');
  }
  upgradeFormatting();
  const changed = Object.keys(files).some(key => files[key] !== root.files[key]);
  return (changed ? { ...root, files, compiled: undefined } : root) as T;
}

export function upgradePersonaWorld(world: WorldDefinition): WorldDefinition {
  const rootComponent = upgradePersonaRoot(world.rootComponent);
  return rootComponent === world.rootComponent ? world : { ...world, rootComponent };
}
