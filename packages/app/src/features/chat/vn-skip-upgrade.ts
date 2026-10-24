const stockSkip = '<Control name="Skip" onClick={() => { setAuto(false); if (pendingPlayerSprite) setPendingPlayerSprite(current => current ? { ...current, index: Math.max(0, lines.length - 1) } : current); else setCursor({ turn, index: Math.max(0, lines.length - 1) }); }} />';
const legacySkip = '<Control name="Skip" onClick={() => { setAuto(false); setCursor({ turn, index: Math.max(0, lines.length - 1) }); }} />';
const latestSkip = `<Control name="Skip" onClick={() => {
          setAuto(false);
          if (panel || viewerOpen || error) return;
          if (pendingPlayerSprite && (loading || api.isStreaming || lastMessage?.role !== "assistant" || lastMessage.id === playerSpriteRequest.current?.baseMessageId)) {
            setPendingPlayerSprite(current => current ? { ...current, index: Math.max(0, lines.length - 1) } : current);
            return;
          }
          const latestSegments = segmentPassages(sceneApi);
          const latestLines = latestSegments.length ? latestSegments : latest ? messagePassages(sceneApi, latest) : passages(sceneApi.entries, api.greetingContent || "");
          playerSpriteRequest.current = null; setPendingPlayerSprite(null);
          setCursor({ turn: latestTurn, index: Math.max(0, latestLines.length - 1) });
        }} />`;
const stockContext = [
  'className="vn"', 'className="vn-stage"',
  'const [pendingPlayerSprite, setPendingPlayerSprite] = React.useState(null);',
  'const playerSpriteRequest = React.useRef(null);',
  'if (!api.isStreaming) completed.current = { variables: api.variables, entries: api.entries, messages: api.messages };',
  'const sceneApi = { ...api, ...completed.current };',
  'const replies = (sceneApi.messages || []).filter(m => m.role === "assistant");',
  'const latest = replies.at(-1);',
  'const messageTurn = message => `${message?.id || "greeting"}:${message?.activeSwipeIndex || 0}`;',
  'const latestTurn = messageTurn(latest);',
  'const lastMessage = (api.messages || []).at(-1);',
  'const loading = !error && (waiting || api.isStreaming);',
];
const stockReading = [
  ['const pendingPlayerLines = pendingPlayerSprite ? playerChoicePassages(pendingPlayerSprite.text, sceneApi.user, pendingPlayerSprite.expression) : [];', 'const lines = pendingPlayerLine ? pendingPlayerLines : replyLines;'],
  ['const pendingPlayerLine = pendingPlayerSprite ? { name: sceneApi.user?.name || "You", kind: "dialogue", player: true, emotion: pendingPlayerSprite.expression, text: pendingPlayerSprite.text } : null;', 'const lines = pendingPlayerLine ? [pendingPlayerLine] : replyLines;'],
  ['const lines = segments.length ? segments : currentMessage ? messagePassages(sceneApi, currentMessage) : passages(sceneApi.entries, api.greetingContent || "");'],
];
const viewerState = 'const viewerOpen = !!characterViewer.viewer;';

/** Replace only the exact shipped Skip handler with its source equivalent.
 * Custom handlers and readers with different acceptance/turn contracts stay intact. */
export function upgradeVnSkipFiles(files: Record<string, string>): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    const skips = [stockSkip, legacySkip].filter(skip => source.split(skip).length === 2);
    if (!name.endsWith(".tsx") || skips.length !== 1 || !stockContext.every(anchor => source.includes(anchor))
      || !stockReading.some(anchors => anchors.every(anchor => source.includes(anchor)))
      || source.includes("const viewerOpen") && !source.includes(viewerState)) continue;
    if (updated === files) updated = { ...files };
    // The oldest saved draft has no character viewer to gate.
    updated[name] = source.replace(skips[0], source.includes(viewerState) ? latestSkip : latestSkip.replace('panel || viewerOpen || error', 'panel || error'));
  }
  return updated;
}
