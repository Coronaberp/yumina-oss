export function LoadingStatus({ api }) {
  const tokens = api.isStreaming ? api.streamingTokenCount ?? Math.ceil(((api.streamingContent || "").length + (api.streamingReasoning || "").length) / 4) : 0;
  return <div className="vn-status" role="status">
    <span className="vn-spinner" aria-hidden="true" />
    <span>Generating and checking…<span style={{ fontVariantNumeric: "tabular-nums" }} title="Estimated generated tokens, including thinking"> · {tokens > 0 ? "~" : ""}{tokens.toLocaleString()} tokens</span></span>
  </div>;
}
