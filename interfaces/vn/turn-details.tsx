/** Facts for this accepted reply only; never compare with current global state. */
export function recordedTurnDetails(message, lines) {
  const accepted = message?.role === "assistant" && message.status !== "failed" && message.status !== "streaming";
  const scenes = [];
  if (accepted) for (const line of lines || []) {
    const scene = typeof line.scene === "string" ? line.scene.trim() : "";
    if (scene && scenes.at(-1) !== scene) scenes.push(scene);
  }
  const swipes = message?.swipes || [], swipe = swipes[message?.activeSwipeIndex || 0];
  // Multiple alternatives must have their own receipt, not the message's latest check.
  const candidate = swipe && Object.hasOwn(swipe, "stateValidation") ? swipe.stateValidation
    : swipes.length <= 1 ? message?.stateValidation : undefined;
  const audit = candidate?.version === 1 ? candidate : null;
  const committed = accepted && audit?.committed === true && ["valid-updates", "explicit-none", "not-required"].includes(audit.outcome);
  const state = committed && Array.isArray(audit.changes) ? "recorded"
    : !accepted || audit?.committed === false ? "not-applied" : "not-recorded";
  const changes = state === "recorded" ? audit.changes.filter(change => typeof change?.variableId === "string").map(change => ({
    label: typeof audit.variableNames?.[change.variableId] === "string" ? audit.variableNames[change.variableId] : change.variableId,
    before: Object.hasOwn(change, "oldValue") ? turnValuePreview(change.oldValue) : { text: "Not recorded", shortened: false },
    after: Object.hasOwn(change, "newValue") ? turnValuePreview(change.newValue) : { text: "Not recorded", shortened: false },
    source: change.source === "rule" ? "Automatic rule" : "AI update", shortened: change.truncated === true,
  })) : [];
  return { scenes, state, changes, omitted: committed && audit.changesTruncated === true };
}

function turnValuePreview(value) {
  let text;
  if (typeof value === "string") text = value || '""';
  else { try { text = JSON.stringify(value, null, 2); } catch { /* Unavailable preview. */ } }
  if (typeof text !== "string") text = "Not recorded";
  return { text: text.length > 1200 ? text.slice(0, 1200) + "…" : text, shortened: text.length > 1200 };
}

export function TurnDetails({ message, lines }) {
  const details = recordedTurnDetails(message, lines);
  return <details className="vn-turn-details vn-thinking">
    <summary>Turn details</summary><style>{turnDetailsStyles}</style>
    <div className="vn-turn-details-body">
      <p><strong>Scene:</strong> {details.scenes.length ? details.scenes.join(" → ") : "Not recorded"}</p>
      <h3>State changes</h3>
      {details.state === "not-applied" ? <p>Not applied.</p> : details.state === "not-recorded" ? <p>Not recorded for this reply.</p>
        : !details.changes.length && !details.omitted ? <p>No tracked value changes.</p> : null}
      {details.changes.map((change, index) => <section className="vn-turn-change" key={index}>
        <h4>{change.label}</h4><small>{change.source}</small>
        <div className="vn-turn-values">{[["Before", change.before], ["After", change.after]].map(([label, value]) => <div key={label}>
          <span>{label}</span><pre>{value.text}</pre>
        </div>)}</div>
        {(change.shortened || change.before.shortened || change.after.shortened) && <p className="vn-turn-preview">Value preview shortened.</p>}
      </section>)}
      {details.omitted && <p className="vn-turn-preview">Some changes are omitted from this preview.</p>}
    </div>
  </details>;
}

const turnDetailsStyles = `
.vn-turn-details{color:var(--cream);font-size:14px;line-height:1.5}
.vn-turn-details summary{width:fit-content;min-height:44px;padding:10px 0;cursor:pointer;color:var(--gold)}
.vn-turn-details summary:focus-visible{outline:2px solid var(--gold);outline-offset:3px}
.vn-turn-details-body{padding:4px 0 12px;overflow-wrap:anywhere}
.vn-turn-details-body p{margin:6px 0 12px}.vn-turn-details-body h3{font:inherit;font-weight:600;margin:18px 0 10px}
.vn-turn-change{padding:12px;margin:10px 0;border:1px solid #b69a694d;border-radius:6px}
.vn-turn-change h4{font:inherit;font-weight:600;margin:0}.vn-turn-change small,.vn-turn-values span{color:var(--gold);font-size:12px}
.vn-turn-values{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:10px}
.vn-turn-values>div{min-width:0}.vn-turn-values pre{max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#1b151080;border-radius:4px;padding:8px;margin:4px 0 0;font:inherit}
.vn-turn-details .vn-turn-preview{color:var(--gold);font-size:12px;margin-bottom:0}
@media(max-width:600px){.vn-turn-values{grid-template-columns:minmax(0,1fr)}}
`;
