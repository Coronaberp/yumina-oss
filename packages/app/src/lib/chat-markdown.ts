import DOMPurify from "dompurify";
import { Marked } from "marked";
import { parseImageEmbeds, renderImageEmbedHtml } from "@yumina/engine";

interface ChatMarkdownOptions {
  resolveImageSrc: (src: string) => string;
  renderHtmlEmbed: (code: string) => string;
  afterSanitize?: (root: Element) => void;
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/** One CommonMark/GFM implementation for live Chat and Studio's preview. */
export function createChatMarkdownRenderer(options: ChatMarkdownOptions): (text: string) => string {
  let htmlEmbeds: string[] = [];
  const richImage = (raw: string) => {
    const embed = parseImageEmbeds(raw).embeds[0];
    return embed ? renderImageEmbedHtml(embed, options.resolveImageSrc) : null;
  };
  const markdown = new Marked({ gfm: true, breaks: true, async: false, renderer: {
    // Authored executable HTML retains its existing explicit, isolated fence.
    // Ordinary HTML in prose is displayed literally.
    html({ text }) { return escape(text); },
    code({ text, lang }) {
      const language = (lang || "").trim().split(/\s+/)[0] || "";
      if (["html", "htm", "ui-html", "yumina-html"].includes(language.toLowerCase())) {
        const index = htmlEmbeds.push(options.renderHtmlEmbed(text)) - 1;
        return `<span data-yumina-html-embed="${index}"></span>`;
      }
      return `<pre><code${language ? ` class="language-${escape(language)}"` : ""}>${escape(text)}${text.endsWith("\n") ? "" : "\n"}</code></pre>`;
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (href.startsWith("choice:")) {
        let choice = href.slice(7);
        try { choice = decodeURIComponent(choice); } catch { /* Preserve a literal malformed escape. */ }
        return `<button type="button" data-yumina-choice="${escape(choice)}">${label}</button>`;
      }
      const external = !href.startsWith("/") || href.startsWith("//");
      return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ""}${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
    },
    image({ href, title, text }) {
      return `<img src="${escape(options.resolveImageSrc(href))}" alt="${escape(text)}"${title ? ` title="${escape(title)}"` : ""} class="rounded-lg max-w-full" loading="lazy" />`;
    },
  }, extensions: [
    {
      name: "chatImageBlock", level: "block",
      start: source => source.search(/^ {0,3}\[image:/im),
      tokenizer(source) {
        const match = /^ {0,3}(\[image:[^\]\n]+\])[\t ]*(?:\n|$)/i.exec(source);
        const html = match && richImage(match[1]!);
        if (match && html) return { type: "chatImageBlock", raw: match[0], html };
      },
      renderer: token => token.html as string,
    },
    {
      name: "chatImageInline", level: "inline",
      start: source => source.search(/\[image:/i),
      tokenizer(source) {
        const match = /^\[image:[^\]\n]+\]/i.exec(source);
        const html = match && richImage(match[0]);
        if (match && html) return { type: "chatImageInline", raw: match[0], html };
      },
      renderer: token => token.html as string,
    },
  ] });

  return text => {
    htmlEmbeds = [];
    const root = DOMPurify.sanitize(markdown.parse(text, { async: false }), {
      RETURN_DOM: true,
      ALLOWED_TAGS: ["span", "div", "p", "br", "hr", "strong", "em", "del", "b", "i", "a", "img", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "input", "table", "thead", "tbody", "tr", "th", "td", "button"],
      ALLOWED_ATTR: ["class", "style", "href", "target", "rel", "title", "src", "alt", "loading", "referrerpolicy", "data-yumina-choice", "data-yumina-html-embed", "align", "start", "type", "checked", "disabled"],
    }) as HTMLBodyElement;
    // Restore only platform-generated, sandboxed iframe shells. Sanitizing
    // their srcdoc as an outer attribute would discard embedded CSS/scripts.
    for (const placeholder of root.querySelectorAll("span[data-yumina-html-embed]")) {
      const embed = htmlEmbeds[Number(placeholder.getAttribute("data-yumina-html-embed"))];
      const template = root.ownerDocument.createElement("template");
      template.innerHTML = embed || "";
      placeholder.replaceWith(template.content);
    }
    for (const table of root.querySelectorAll("table")) {
      const scroll = root.ownerDocument.createElement("div");
      scroll.className = "chat-markdown-table";
      table.replaceWith(scroll);
      scroll.append(table);
    }
    options.afterSanitize?.(root);
    return `<div class="chat-markdown">${root.innerHTML.trim()}</div>`;
  };
}
