type Routing = { requestedModel?: string; routedModel?: string; reason?: string };
type ReplyModel = { model?: string | null; modelRouting?: Routing; activeSwipeIndex?: number; swipes?: Array<{ model?: string | null; modelRouting?: Routing }> };

const modelName = (value: unknown) => typeof value === "string" && value.trim() ? value.replace(/^custom\//, "") : "Not recorded";
const reasons = {
  "content-fallback": "Content routing used your configured fallback.",
  "content-check-uncertain": "Content checking was uncertain, so your configured fallback was used.",
  "profile-default": "Your saved connection's default model was used.",
};

/** Read saved reply metadata only. A current selection cannot establish why an
 * older reply used another model, and another swipe's model is not its history. */
export function ModelRoutingDetails({ selectedModel, message }: { selectedModel?: string; message?: ReplyModel }) {
  const swipe = message?.swipes?.[message.activeSwipeIndex || 0];
  const source = message?.swipes?.length ? swipe : message;
  const recordedModel = source?.model ?? ((message?.swipes?.length || 0) <= 1 ? message?.model : undefined);
  const routing = source?.modelRouting;
  const reason = routing && Object.hasOwn(reasons, routing.reason || "") ? reasons[routing.reason as keyof typeof reasons] : "";
  return <div className="vn-model-details" aria-label="Model routing details" style={{ marginTop: 12, fontSize: 13, lineHeight: 1.5, overflowWrap: "anywhere" }}>
    <dl style={{ margin: 0, display: "grid", gap: 8 }}>
      <div><dt style={{ opacity: .7 }}>Selected for next reply</dt><dd style={{ margin: 0 }}>{modelName(selectedModel)}</dd></div>
      <div><dt style={{ opacity: .7 }}>Reply model</dt><dd style={{ margin: 0 }}>{modelName(recordedModel)}</dd></div>
      {routing?.requestedModel && routing.requestedModel !== selectedModel && <div><dt style={{ opacity: .7 }}>Requested for this reply</dt><dd style={{ margin: 0 }}>{modelName(routing.requestedModel)}</dd></div>}
    </dl>
    {reason && <p style={{ margin: "8px 0 0", opacity: .8 }}>{reason}</p>}
  </div>;
}
