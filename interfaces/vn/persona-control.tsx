export const personaControlModes = ['player', 'assisted', 'ai'];
export const personaControlLabels = ['Player controlled', 'Assisted', 'AI controlled'];
const descriptions = [
  'You choose every word and action. Your persona displays the choices you submit.',
  'Describe your intent, draft a response in your persona’s voice, then review and send it.',
  'Your persona speaks and acts throughout each turn, guided by personality and what you write. The story pauses for major new decisions.',
];

export function usePersonaControl(api) {
  const [mode, setMode] = React.useState('player');
  const [ready, setReady] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const active = React.useRef({ sessionId: api.sessionId, request: 0 });
  const savingRef = React.useRef(false);
  active.current.sessionId = api.sessionId;
  React.useEffect(() => {
    let cancelled = false;
    ++active.current.request; savingRef.current = false;
    setMode('player'); setReady(false); setSaving(false); setError('');
    if (!api.sessionId || api.readOnly) { setReady(true); return; }
    if (typeof api.getPersonaControlMode !== 'function') { setReady(true); setError('Reload the app to change persona control.'); return; }
    api.getPersonaControlMode().then(value => {
      if (!cancelled) { setMode(personaControlModes.includes(value) ? value : 'player'); setReady(true); }
    }).catch(err => { if (!cancelled) setError(err?.message || 'Could not load persona control. Reload to try again.'); });
    return () => { cancelled = true; };
  }, [api.sessionId, api.readOnly]);

  async function change(value) {
    if (!ready || savingRef.current || api.readOnly || api.isStreaming || !personaControlModes.includes(value) || value === mode) return;
    const sessionId = api.sessionId, request = ++active.current.request;
    savingRef.current = true; setSaving(true); setError('');
    try {
      const saved = await api.setPersonaControlMode(value);
      if (active.current.sessionId !== sessionId || active.current.request !== request) return;
      if (!personaControlModes.includes(saved)) throw new Error('The server did not save persona control.');
      setMode(saved);
    } catch (err) {
      if (active.current.sessionId === sessionId && active.current.request === request) setError(err?.message || 'Could not save persona control.');
    } finally {
      if (active.current.sessionId === sessionId && active.current.request === request) { savingRef.current = false; setSaving(false); }
    }
  }
  return { mode, ready, saving, error, change };
}

export function PersonaControlSetting({ api, control, busy }) {
  const id = React.useId(), position = Math.max(0, personaControlModes.indexOf(control.mode));
  return <div className="vn-setting vn-persona-control">
    <style>{`.vn-persona-control{gap:8px}.vn-persona-control-heading{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.vn-persona-control-heading output{font-size:14px;color:var(--gold)}.vn-persona-control input[type=range]{min-height:44px;margin:0;cursor:pointer}.vn-persona-control input:disabled{opacity:.5;cursor:wait}.vn-persona-control-stops{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;font-size:12px;line-height:1.4;color:#bfb097}.vn-persona-control-stops span:nth-child(2){text-align:center}.vn-persona-control-stops span:last-child{text-align:right}.vn-persona-control-stops [data-selected=true]{color:var(--gold)}.vn-persona-control p{font-size:14px;line-height:1.6;margin:8px 0 0;color:#bfb097}.vn-persona-control p[role=alert]{color:#e5a99d}`}</style>
    <div className="vn-persona-control-heading"><label htmlFor={id}>Persona control</label><output htmlFor={id} aria-live="polite">{!control.ready ? 'Loading…' : control.saving ? 'Saving…' : personaControlLabels[position]}</output></div>
    <input id={id} type="range" min="0" max="2" step="1" value={position} aria-valuetext={personaControlLabels[position]} aria-describedby={`${id}-description`} disabled={!control.ready || control.saving || busy || api.isStreaming || api.readOnly || !api.sessionId || typeof api.setPersonaControlMode !== 'function'} onChange={event => control.change(personaControlModes[Number(event.target.value)])} />
    <div className="vn-persona-control-stops" aria-hidden="true">{personaControlLabels.map((label, i) => <span key={label} data-selected={i === position}>{label}</span>)}</div>
    <p id={`${id}-description`}>{descriptions[position]}</p>
    {control.error && <p role="alert">{control.error}</p>}
  </div>;
}
