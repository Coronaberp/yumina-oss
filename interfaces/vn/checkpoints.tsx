export function nextCheckpointName(checkpoints) {
  const names = new Set(checkpoints.map(checkpoint => checkpoint.name.trim().toLowerCase()));
  let number = 1;
  while (names.has(`checkpoint #${number}`)) number++;
  return `Checkpoint #${number}`;
}

export function SaveCheckpoint({ api, onClose }) {
  const [name, setName] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const input = React.useRef(null);
  const inFlight = React.useRef(false);
  const defaultName = React.useRef("");

  React.useEffect(() => {
    let cancelled = false;
    api.loadCheckpoints().then(checkpoints => {
      if (!cancelled) { defaultName.current = nextCheckpointName(checkpoints); setName(defaultName.current); setLoading(false); }
    }).catch(err => {
      if (!cancelled) { setError(err?.message || "Could not load checkpoints. Please reopen Save to try again."); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [api.sessionId]);

  React.useEffect(() => {
    if (!loading) { input.current?.focus(); input.current?.select(); }
  }, [loading]);

  async function save(event) {
    event.preventDefault();
    if (inFlight.current || loading || !name.trim() || api.readOnly || api.isStreaming) return;
    inFlight.current = true; setSaving(true); setError("");
    try { await api.saveCheckpoint(name.trim() === defaultName.current ? undefined : name.trim()); onClose(); }
    catch (err) { setError(err?.message || "Could not save the checkpoint. Please try again."); }
    finally { inFlight.current = false; setSaving(false); }
  }

  const dismiss = () => { if (!inFlight.current) onClose(); };
  return <section className="vn-overlay vn-composer vn-save" role="dialog" aria-modal="true" aria-label="Save checkpoint" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
  }}>
    <button className="vn-menu-shade" aria-label="Dismiss checkpoint naming" disabled={saving} onClick={dismiss} />
    <form className="vn-composer-card vn-save-card" onSubmit={save}>
      <button className="vn-close" type="button" aria-label="Close checkpoint naming" disabled={saving} onClick={dismiss}><Icons.X /></button>
      <h1>Save checkpoint</h1>
      <label htmlFor="vn-checkpoint-name">Checkpoint name</label>
      <input ref={input} id="vn-checkpoint-name" type="text" value={name} disabled={loading || saving} onInput={event => setName(event.currentTarget.value)} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") save(event); }} placeholder={loading ? "Loading saved checkpoints…" : "Enter a checkpoint name"} autoComplete="off" />
      {error && <p className="vn-save-error" role="alert">{error}</p>}
      <div className="vn-composer-actions"><button type="button" disabled={saving} onClick={dismiss}>Cancel</button><button className="vn-send-choice" type="submit" onClick={save} disabled={loading || saving || !name.trim() || api.readOnly || api.isStreaming}>{saving ? "Saving…" : "Save"}</button></div>
    </form>
  </section>;
}
