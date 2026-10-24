const oldSize = '<label className="vn-setting">Dialogue size<select value={settings.textSize} onChange={e => onSetting("textSize", Number(e.target.value))}><option value={23}>Small</option><option value={27}>Default</option><option value={32}>Large</option></select></label>';
const settingsImport = 'import { VnTextSettings, VnTextStyle } from "./text-settings";';
const drawerClose = `    <aside className="vn-drawer">
      <button className="vn-close vn-menu-close" aria-label="Close menu" onClick={onClose}>Close<MenuIcon api={api} name="close" /></button>`;
const anchoredClose = `    <button className="vn-close vn-menu-close" aria-label="Close menu" onClick={onClose}>Close<MenuIcon api={api} name="close" /></button>
    <aside className="vn-drawer">`;

/** Patch only the shipped settings block; retain every other authored module. */
export function upgradeVnTextFiles(files: Record<string, string>, helpers: Record<string, string>): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !source.includes('className="vn"') || !source.includes('function Menu({ api,') || !source.includes(oldSize) || source.includes(settingsImport)) continue;
    const folder = name.slice(0, name.lastIndexOf("/") + 1);
    if (Object.entries(helpers).some(([file, value]) => file !== "text-defaults.ts" && files[folder + file] !== undefined && files[folder + file] !== value)) continue;
    if (!/<style>\{styles[\s\S]*?<\/style>/.test(source)) continue;
    if (updated === files) updated = { ...files };
    for (const [file, value] of Object.entries(helpers)) updated[folder + file] = files[folder + file] ?? value;
    updated[name] = settingsImport + "\n" + source
      .replace(oldSize, '<VnTextSettings api={api} onResetLegacy={() => onSetting("textSize", 27)} />')
      .replace(/(<style>\{styles[\s\S]*?<\/style>)/, '$1\n    <VnTextStyle api={api} />')
      .replace('return <section className="vn-overlay" role="dialog" aria-modal="true" aria-label="Story menu">', 'return <section className="vn-overlay vn-menu-overlay" role="dialog" aria-modal="true" aria-label="Story menu">')
      .replace(drawerClose, anchoredClose)
      .replace('[turn, index, textSize, choices.length, hidden, spriteLimit]', '[turn, index, textSize, choices.length, hidden, spriteLimit, JSON.stringify(api.vnTextPreferences)]')
      .replace('[turn, index, textSize, choices.length, hidden, spriteLimit, error]', '[turn, index, textSize, choices.length, hidden, spriteLimit, error, JSON.stringify(api.vnTextPreferences)]');
  }
  return updated;
}
