import { displayCharacterName, isVariableActive, readCharacterShowcase, writeCharacterShowcaseCss, type WorldDefinition } from "@yumina/engine";

/** Use the player's viewer with synthetic prose, without sending private profiles or generating text. */
export function buildCharacterShowcasePreview(world: WorldDefinition, characterId: string) {
  const entry = world.entries.find(entry => entry.id === characterId);
  if (!entry || !world.rootComponent) throw new Error("Choose a character to preview.");
  const root = writeCharacterShowcaseCss(world.rootComponent, world.entries,
    // Install compatibility wiring into the preview only; retain every saved override.
    readCharacterShowcase(world.rootComponent.files["character-showcase.ts"]).css);
  const files = { ...root.files };
  files["character-viewer.tsx"] = files["character-viewer.tsx"]!
    .replace(/^function expressionSprites\(/m, "export function expressionSprites(")
    .replace(/^function characterStats\(/m, "export function characterStats(")
    // Older saved viewers predate the read-only preview flag. Adapt only the
    // preview's virtual copy so editor typing never loses focus to the dialog.
    .replace('export function CharacterViewer({ controller }) {', 'export function CharacterViewer({ controller, preview = false }) {')
    .replace('React.useLayoutEffect(() => { dialog.current.querySelector', 'React.useLayoutEffect(() => { if (!preview) dialog.current.querySelector')
    .replace('React.useEffect(() => {\n    function keydown(event)', 'React.useEffect(() => {\n    if (preview) return;\n    function keydown(event)');
  const target = { id: entry.id, name: displayCharacterName(entry.name), label: displayCharacterName(entry.name), portrait: entry.portrait };
  const defaults = Object.fromEntries(world.variables.map(variable => [variable.id, variable.defaultValue]));
  const state = { worldId: world.id, variables: defaults, turnCount: 0, metadata: {} };
  const variables = Object.fromEntries(world.variables.filter(variable => !variable.internal && isVariableActive(variable, state)).map(variable => [variable.id, variable.defaultValue]));
  const entries = world.entries.map(({ id, name, role, tags, enabled }) => ({ id, name, role, tags, enabled, content: "", keywords: [], position: 0, section: "system-presets" as const }));
  const entryFile = "__character-showcase-preview.tsx";
  files[entryFile] = `
import { CharacterViewer, characterViewerStyles, expressionSprites, characterStats } from "./character-viewer";
import { styles } from "./styles";
import { fontRef } from "./font";
export default function CharacterShowcasePreview() {
  const api = useYumina();
  const target = ${JSON.stringify(target)};
  const viewer = { target, images: expressionSprites(api, target), stats: characterStats(api, target, api.variables),
    statsLoading: false, statsError: "", loading: false, available: true, error: "", evidence: {partial: false},
    bullets: ["The generated character summary appears here.", "Only details revealed in the story are shown.", "Sprites and stats use this card’s settings."] };
  return <div className="vn vn-character-design-preview"><style>{styles.replace("__FONT_URL__", fontRef ? api.resolveAssetUrl(fontRef) : "") + characterViewerStyles}</style>
    <CharacterViewer preview controller={{viewer, close:()=>{}, retry:()=>{}}} /></div>;
}`;
  return { entryFile, files, variables, entries };
}
