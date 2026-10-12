import { useMemo } from "react";
import { renderStudioMarkdown } from "@/lib/studio-markdown";
import { stripDirectives } from "@/lib/strip-directives";

/** Renders markdown text that grows token-by-token during streaming. */
export function StreamingText({ content }: { content: string }) {
  const html = useMemo(() => (content ? renderStudioMarkdown(stripDirectives(content)) : ""), [content]);
  if (!content) return null;
  return (
    <div
      className="studio-markdown max-w-none text-xs [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
