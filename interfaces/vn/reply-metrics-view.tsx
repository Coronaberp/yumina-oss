import { replyMetrics } from "./reply-metrics";

export function ReplyMetrics({ message }) {
  const metrics = replyMetrics(message);
  if (!metrics) return null;
  const input = metrics.inputTokens === null ? "—" : `~${metrics.inputTokens.toLocaleString()}`;
  const speed = metrics.estimatedTps === null ? "—" : metrics.estimatedTps.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const output = metrics.outputTokens.toLocaleString();
  return <span className="vn-reply-metrics" aria-label={`Generation usage: approximately ${input.replace("~", "")} input tokens; estimated ${speed} tokens per second; approximately ${output} output tokens including thinking`}>
    <span aria-hidden="true"> | </span><span>in {input} toks</span><span aria-hidden="true"> | </span><span>est {speed} tps</span><span aria-hidden="true"> | </span><span>out ~{output} toks</span>
  </span>;
}
