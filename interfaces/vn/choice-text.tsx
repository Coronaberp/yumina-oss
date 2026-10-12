import { dialogueSpans, plainDialogue } from "./dialogue-spans";

function choiceSpans(text) {
  return dialogueSpans(text).flatMap(span => {
    if (span.kind === "dialogue") return [{ ...span, text: plainDialogue(span.text) }];
    // Choice prose outside spoken quotes describes a proposed action, even
    // when the model omitted its emphasis markers. Keep submission unchanged.
    if (span.kind === "text") return [{ ...span, kind: "action" }];
    if (span.kind !== "action") return [span];
    const marker = /^(\*{1,3}|_{1,3})/.exec(span.text)?.[0] || "";
    let action = span.text.slice(marker.length);
    if (marker && action.endsWith(marker)) action = action.slice(0, -marker.length);
    // An unfinished action marker must not consume the style of quoted speech.
    return dialogueSpans(action).map(part => part.kind === "dialogue" && /^["“«「『]/.test(part.text)
      ? { ...part, text: plainDialogue(part.text) }
      : { ...part, kind: "action" });
  });
}

export function plainChoiceText(text) {
  return choiceSpans(text).map(span => span.text).join("").trim();
}

/** React text keeps choice markup inert; submission uses the original string. */
export function ChoiceText({ text }) {
  return <span className="vn-choice-text" style={{ minWidth: 0, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
    {choiceSpans(text).map((span, index) => span.kind === "action"
      ? <em key={index} className="vn-choice-action" style={{ fontStyle: "italic", fontWeight: "inherit" }}>{span.text}</em>
      : span.kind === "dialogue" ? <span key={index} className="vn-choice-dialogue" style={{ fontStyle: "normal" }}>{span.text}</span>
      : <React.Fragment key={index}>{span.text}</React.Fragment>)}
  </span>;
}
