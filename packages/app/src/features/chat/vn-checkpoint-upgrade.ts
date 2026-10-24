const previousCheckpointSource = "export function nextCheckpointName(checkpoints) {\n  const names = new Set(checkpoints.map(checkpoint => checkpoint.name.trim().toLowerCase()));\n  let number = 1;\n  while (names.has(`checkpoint #${number}`)) number++;\n  return `Checkpoint #${number}`;\n}\n\nexport function SaveCheckpoint({ api, onClose }) {\n  const [name, setName] = React.useState(\"\");\n  const [loading, setLoading] = React.useState(true);\n  const [saving, setSaving] = React.useState(false);\n  const [error, setError] = React.useState(\"\");\n  const input = React.useRef(null);\n  const inFlight = React.useRef(false);\n  const defaultName = React.useRef(\"\");\n\n  React.useEffect(() => {\n    let cancelled = false;\n    api.loadCheckpoints().then(checkpoints => {\n      if (!cancelled) { defaultName.current = nextCheckpointName(checkpoints); setName(defaultName.current); setLoading(false); }\n    }).catch(err => {\n      if (!cancelled) { setError(err?.message || \"Could not load checkpoints. Please reopen Save to try again.\"); setLoading(false); }\n    });\n    return () => { cancelled = true; };\n  }, [api.sessionId]);\n\n  React.useEffect(() => {\n    if (!loading) { input.current?.focus(); input.current?.select(); }\n  }, [loading]);\n\n  async function save(event) {\n    event.preventDefault();\n    if (inFlight.current || loading || !name.trim() || api.readOnly || api.isStreaming) return;\n    inFlight.current = true; setSaving(true); setError(\"\");\n    try { await api.saveCheckpoint(name.trim() === defaultName.current ? undefined : name.trim()); onClose(); }\n    catch (err) { setError(err?.message || \"Could not save the checkpoint. Please try again.\"); }\n    finally { inFlight.current = false; setSaving(false); }\n  }\n\n  const dismiss = () => { if (!inFlight.current) onClose(); };\n  return <section className=\"vn-overlay vn-composer vn-save\" role=\"dialog\" aria-modal=\"true\" aria-label=\"Save checkpoint\" onKeyDown={event => {\n    if (event.key === \"Escape\") { event.preventDefault(); event.stopPropagation(); dismiss(); }\n  }}>\n    <button className=\"vn-menu-shade\" aria-label=\"Dismiss checkpoint naming\" disabled={saving} onClick={dismiss} />\n    <form className=\"vn-composer-card vn-save-card\" onSubmit={save}>\n      <button className=\"vn-close\" type=\"button\" aria-label=\"Close checkpoint naming\" disabled={saving} onClick={dismiss}><Icons.X /></button>\n      <h1>Save checkpoint</h1>\n      <label htmlFor=\"vn-checkpoint-name\">Checkpoint name</label>\n      <input ref={input} id=\"vn-checkpoint-name\" type=\"text\" value={name} disabled={loading || saving} onInput={event => setName(event.currentTarget.value)} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === \"Enter\") save(event); }} placeholder={loading ? \"Loading saved checkpoints\u2026\" : \"Enter a checkpoint name\"} autoComplete=\"off\" />\n      {error && <p className=\"vn-save-error\" role=\"alert\">{error}</p>}\n      <div className=\"vn-composer-actions\"><button type=\"button\" disabled={saving} onClick={dismiss}>Cancel</button><button className=\"vn-send-choice\" type=\"submit\" onClick={save} disabled={loading || saving || !name.trim() || api.readOnly || api.isStreaming}>{saving ? \"Saving\u2026\" : \"Save\"}</button></div>\n    </form>\n  </section>;\n}\n";

const rootChanges: readonly (readonly [string, string])[] = [
  [
    "function Menu({ api, onClose, setPanel, settings, onSetting, busy, run }) {",
    "function Menu({ api, onClose, setPanel, settings, onSetting, busy, run, onRestore }) {"
  ],
  [
    "await api.restoreCheckpoint(checkpoint.id); onClose();",
    "await api.restoreCheckpoint(checkpoint.id); onRestore(); onClose();"
  ],
  [
    "{settings.panel === \"load\" ? <>\n",
    "{settings.panel === \"load\" ? <>\n            <p>Loading returns to the first page of the saved reply.</p>\n"
  ],
  [
    "  const [cursor, setCursor] = React.useState({ turn: \"\", index: 0 });",
    "  const [cursor, setCursor] = React.useState({ turn: \"\", index: 0 });\n  const cursorRevision = React.useRef(0);"
  ],
  [
    "    let cancelled = false;\n    setHydrated(false);",
    "    let cancelled = false;\n    const revision = cursorRevision.current;\n    setHydrated(false);"
  ],
  [
    "if (value && typeof value.turn === \"string\" && Number.isInteger(value.index) && value.index >= 0) setCursor(value);",
    "if (revision === cursorRevision.current && value && typeof value.turn === \"string\" && Number.isInteger(value.index) && value.index >= 0) setCursor(value);"
  ],
  [
    "onSetting={onSetting} busy={busy} run={run} />",
    "onSetting={onSetting} busy={busy} run={run} onRestore={() => { cursorRevision.current++; setCursor({ turn: \"\", index: 0 }); setPendingPlayerSprite(null); playerSpriteRequest.current = null; setAuto(false); }} />"
  ]
];

/** Update only the byte-exact stock save module and recognized stock reader
 * boundaries. Keep authored checkpoint code, layouts, assets and preferences. */
export function upgradeVnCheckpointFiles(files: Record<string, string>, checkpointSource: string): Record<string, string> {
  if (!checkpointSource.startsWith('export function nextCheckpointName(checkpoints) {')
    || !checkpointSource.includes('api.showToast?.("Checkpoint saved", "success")')) return files;
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if ((name === 'checkpoints.tsx' || name.endsWith('/checkpoints.tsx')) && source === previousCheckpointSource) {
      if (updated === files) updated = { ...files };
      updated[name] = checkpointSource;
      continue;
    }
    if (!name.endsWith('.tsx') || !source.includes('export default function VN() {') || !source.includes('className="vn-stage"')
      || !source.includes('const [auto, setAuto] = React.useState(false);') || source.includes('cursorRevision')) continue;
    const hasPendingIdentifiers = source.includes('setPendingPlayerSprite') || source.includes('playerSpriteRequest');
    if (hasPendingIdentifiers && (!source.includes('const [pendingPlayerSprite, setPendingPlayerSprite] = React.useState(null);')
      || !source.includes('const playerSpriteRequest = React.useRef(null);'))) continue;
    let next = source;
    for (const [before, after] of rootChanges) {
      if (next.split(before).length !== 2) { next = source; break; }
      const replacement = hasPendingIdentifiers ? after : after.replace(' setPendingPlayerSprite(null); playerSpriteRequest.current = null;', '');
      next = next.replace(before, replacement);
    }
    if (next === source) continue;
    if (updated === files) updated = { ...files };
    updated[name] = next;
  }
  return updated;
}
