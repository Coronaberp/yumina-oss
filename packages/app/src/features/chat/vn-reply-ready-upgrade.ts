const endLine = "  const end = index >= lines.length - 1;\n";
const readyState = "  const replyReady = pendingPlayerLine && end && !loading && !api.isStreaming && !error && lastMessage?.role === \"assistant\" && lastMessage.id !== playerSpriteRequest.current?.baseMessageId;\n";
const passageOpening = "      {line && <section className=\"vn-dialogue\" onClick={advance} aria-label=\"Current passage\">\n        <SpeakerName name={line.name || (line.kind === \"dialogue\" ? \"NPC\" : \"\")} className=\"vn-name\" truncate={false} /><Copy api={api} text={line.text} className={`vn-text${line.kind === \"narration\" ? \" vn-action\" : \"\"}`} context={{ messageId: currentMessage?.id || \"greeting\", lines: readLines }} onCharacter={characterViewer.open} />\n";
const readyRow = "        <span className=\"vn-reply-announcement\" role=\"status\" aria-live=\"polite\" aria-atomic=\"true\">{replyReady ? \"Reply ready\" : \"\"}</span>\n        {replyReady && <div className=\"vn-reply-ready\"><span aria-hidden=\"true\">Reply ready</span><button onClick={event => { event.stopPropagation(); advance(); }}>Continue</button></div>}\n";
const stockAdvance = "  function advance() {\n    if (hidden) { setHidden(false); return; }\n    if (panel || viewerOpen || error || !line) return;\n    setAuto(false);\n    if (scrollPassage()) return;\n    movePage(1);\n  }\n\n  function movePage(direction) {\n    if (panel || viewerOpen || error || !line) return;\n    setAuto(false);\n    if (pendingPlayerLine) {\n      if (direction > 0 && \x21end || direction < 0 && index > 0) {\n        setPendingPlayerSprite(current => current ? { ...current, index: index + direction } : current);\n      } else if (direction > 0 && !loading && !api.isStreaming && lastMessage?.role === \"assistant\" && lastMessage.id !== playerSpriteRequest.current?.baseMessageId) {\n        playerSpriteRequest.current = null; setPendingPlayerSprite(null); setCursor({ turn: latestTurn, index: 0 });\n      }\n      return;\n    }\n";
const stockCustomChoice = "<button className=\"vn-choice vn-custom-choice\" aria-label=\"Write your own choice\" disabled={api.readOnly || generatingChoices || !personaControl.ready || personaControl.saving} onClick={() => setPanel(\"composer\")}><span className=\"vn-choice-icon\" aria-hidden=\"true\" dangerouslySetInnerHTML={{ __html: choiceIcon }} /><ChoiceText text=\"Write your own\" /></button>";
const readyStyles = ".vn-reply-ready{display:flex;justify-content:center;align-items:center;gap:14px;margin-top:12px;color:var(--gold);font-size:14px;pointer-events:auto}.vn-reply-ready button{min-height:44px;padding:8px 18px;border:1px solid #b69a6970;border-radius:4px;background:#261f18;color:var(--gold);font:inherit;cursor:pointer}.vn-reply-ready button:hover{background:#352b20}.vn-reply-ready button:focus-visible{outline:2px solid var(--gold);outline-offset:3px}.vn-reply-announcement{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}\n.vn-dialogue:has(.vn-reply-ready) .vn-progress{position:static;padding-top:0;margin-top:12px}.vn-dialogue:has(.vn-reply-ready) .vn-continue{display:none}.vn-dialogue:has(.vn-reply-ready) .vn-text{max-height:min(28cqh,max(1lh,calc(100cqh - var(--cast-top,88px) - 220px)))}\n";
const stockStyles = [".vn-dialogue{position:absolute;bottom:calc(85px + var(--error-space,0px));left:5%;width:90%;text-align:center;pointer-events:none}", ".vn-text{font-size:var(--text-size);line-height:1.55;color:rgba(234,223,201,.92);max-height:32vh;overflow:auto;pointer-events:auto;scrollbar-width:thin}", ".vn-progress{position:absolute;top:100%;left:0;width:100%;padding-top:18px;color:var(--gold);font-size:14px;line-height:22px;opacity:.8;pointer-events:none}"];

/** Add the ready affordance only to paired, recognized shipped readers. Unknown
 * pacing, handlers, layout and partial upgrades are left intact for their author. */
export function upgradeVnReplyReadyFiles(files: Record<string, string>): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !source.includes('import { styles } from "./styles";')
      || !source.includes("const pendingPlayerLines =") || !source.includes(stockAdvance)
      || !source.includes(stockCustomChoice) || source.includes("replyReady") || source.includes("vn-reply-ready")
      || source.split(endLine).length !== 2 || source.split(passageOpening).length !== 2) continue;
    const styleName = name.slice(0, name.lastIndexOf("/") + 1) + "styles.ts";
    const styles = files[styleName];
    if (!styles || !/^(?:\/\/[^\n]*\n)*export const styles = `[^`]*`;\n$/.test(styles)
      || styles.includes("vn-reply-ready") || !stockStyles.every(anchor => styles.includes(anchor))) continue;
    if (updated === files) updated = { ...files };
    updated[name] = source.replace(endLine, endLine + readyState).replace(passageOpening, passageOpening + readyRow);
    updated[styleName] = styles.slice(0, -3) + readyStyles + "`;\n";
  }
  return updated;
}
