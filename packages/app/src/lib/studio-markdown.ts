import DOMPurify from "dompurify";
import { Marked } from "marked";
import { escapeHtml } from "./markdown";
import { resolveImageUrl } from "./asset-url";

// Keep full Markdown parsing scoped to assistant messages; player prose and
// authored HTML embeds have their own rendering rules.
const markdown = new Marked({ gfm: true, breaks: true, async: false, renderer: {
  html({ text }) { return escapeHtml(text); },
  link({ href, title, tokens }) {
    const external = !href.startsWith("/") || href.startsWith("//");
    return `<a href="${escapeHtml(href)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${this.parser.parseInline(tokens)}</a>`;
  },
  image({ href, title, text }) {
    const src = /^(?:@asset:)?[0-9a-f-]{36}$/i.test(href) ? resolveImageUrl(href) ?? href : href;
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ""} loading="lazy" />`;
  },
} });

export function renderStudioMarkdown(raw: string): string {
  const html = DOMPurify.sanitize(markdown.parse(raw, { async: false }), {
    ALLOWED_TAGS: ["p", "br", "hr", "strong", "em", "del", "a", "img", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "input", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "target", "rel", "src", "alt", "title", "loading", "class", "align", "start", "type", "checked", "disabled"],
  });
  return html.replace(/<table>/g, '<div class="studio-markdown-table"><table>').replace(/<\/table>/g, "</table></div>");
}
