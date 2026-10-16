/**
 * Sandbox-side markdown renderer.
 *
 * Messages and greetings use the same CommonMark/GFM implementation as the
 * Studio preview. This adapter owns sandbox asset URLs, isolated HTML embeds,
 * sentence capitalization and the completed-message cache.
 */

import { capitalizeSentenceStarts } from "./sentence-case";
import { createChatMarkdownRenderer } from "../../src/lib/chat-markdown";

// ── HTML embed types ───────────────────────────────────────────────

interface HtmlEmbedPayload {
  html: string;
  css?: string;
  js?: string;
  height?: number;
}

interface HtmlEmbed {
  srcDoc: string;
  height: number;
}

const DEFAULT_HTML_EMBED_HEIGHT = 320;
const MIN_HTML_EMBED_HEIGHT = 120;
const MAX_HTML_EMBED_HEIGHT = 1200;

// ── Helpers ────────────────────────────────────────────────────────

const ASSET_SRC_RE =
  /^(?:@asset:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CDN_PATH_RE = /^\/cdn\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Widest a picture in a message can be painted: the chat column tops out
 * around 800 CSS px and phones run 2–3× DPR, so 1280 device px covers every
 * slot without the edge ever upscaling (it never does; the browser would).
 */
const CHAT_IMAGE_WIDTH = 1280;

/**
 * The picture a message actually downloads. Creators upload whatever came out
 * of their tools — the live Maid Mansion opening is a 3.4 MB PNG — and a chat
 * cannot make a player pull that over 4G for a picture a few hundred pixels
 * wide. Cloudflare Image Transformations (`/cdn-cgi/image/…`, the same path
 * hub cards use via `cardImageUrl`) turns that file into a ~190 KB webp at
 * the edge; `onerror=redirect` hands back the original when a transform is
 * refused (unsupported format, oversize source), and `hardenImageEl` in the
 * component host swaps to the plain `/cdn/` path if the transform endpoint
 * itself is missing (local dev, self-hosted). Root-relative on purpose — see
 * `resolveSandboxImageSrc`.
 */
export function chatImageUrl(assetId: string): string {
  // Vite's dev server has no /cdn-cgi/image; skip the detour there.
  if (import.meta.env?.DEV) return `/cdn/${assetId}`;
  return `/cdn-cgi/image/width=${CHAT_IMAGE_WIDTH},quality=85,format=auto,onerror=redirect/cdn/${assetId}`;
}

/**
 * Creators put library pictures in greetings and messages two ways —
 * `![](@asset:{uuid})` and `[image:@asset:{uuid}]`. Left alone an `@asset:` ref
 * is a relative URL the browser can never load, so map the asset shapes
 * (`@asset:{uuid}`, a bare uuid, `/cdn/{uuid}`) onto the edge-sized CDN
 * picture and leave every other src (https, data:, relative paths) untouched.
 *
 * Root-relative on purpose. This renderer runs inside the sandbox iframe,
 * which is mounted with `sandbox="allow-scripts"` and no `allow-same-origin`,
 * so its origin is opaque and anything derived from `location.origin` is
 * unusable in here. A root-relative path resolves against the iframe's
 * document URL — the app's own host — and is the same shape sandbox-context
 * hands card code.
 */
export function resolveSandboxImageSrc(src: string): string {
  const trimmed = src.trim();
  const cdn = CDN_PATH_RE.exec(trimmed);
  if (cdn) return chatImageUrl(cdn[1]!);
  if (!ASSET_SRC_RE.test(trimmed)) return trimmed;
  const assetId = trimmed.startsWith("@asset:") ? trimmed.slice(7) : trimmed;
  return chatImageUrl(assetId);
}

function clampHeight(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_HTML_EMBED_HEIGHT;
  return Math.min(
    MAX_HTML_EMBED_HEIGHT,
    Math.max(MIN_HTML_EMBED_HEIGHT, Math.round(value)),
  );
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── HTML embed builder ─────────────────────────────────────────────

function buildHtmlEmbedSrcDoc(payload: HtmlEmbedPayload): string {
  const htmlBody = payload.html.trim();
  if (/<html[\s>]/i.test(htmlBody) || /<!doctype/i.test(htmlBody)) {
    return htmlBody;
  }

  const css = (payload.css ?? "").trim();
  const js = (payload.js ?? "").trim();
  const inlineCss = css.length > 0 ? `<style>${css}</style>` : "";
  const inlineJs =
    js.length > 0 ? `<script>${escapeInlineScript(js)}</script>` : "";

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        min-height: 100%;
        background: transparent;
        max-width: 100%;
        overflow-x: hidden;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      *, *::before, *::after {
        box-sizing: border-box;
        max-width: 100%;
      }
      img, video, canvas, svg, iframe {
        max-width: 100%;
        height: auto;
      }
      table {
        width: 100%;
      }
    </style>
    ${inlineCss}
  </head>
  <body>
    ${htmlBody}
    ${inlineJs}
  </body>
</html>`;
}

function parseHtmlEmbed(code: string): HtmlEmbed {
  const trimmed = code.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<HtmlEmbedPayload>;
      if (typeof parsed.html === "string" && parsed.html.trim().length > 0) {
        const payload: HtmlEmbedPayload = {
          html: parsed.html,
          css: typeof parsed.css === "string" ? parsed.css : undefined,
          js: typeof parsed.js === "string" ? parsed.js : undefined,
          height:
            typeof parsed.height === "number" ? parsed.height : undefined,
        };
        return {
          srcDoc: buildHtmlEmbedSrcDoc(payload),
          height: clampHeight(payload.height ?? DEFAULT_HTML_EMBED_HEIGHT),
        };
      }
    } catch {
      // Fall through and treat block as raw HTML.
    }
  }

  return {
    srcDoc: buildHtmlEmbedSrcDoc({ html: code }),
    height: DEFAULT_HTML_EMBED_HEIGHT,
  };
}

function renderHtmlEmbedHtml(embed: HtmlEmbed): string {
  const srcDoc = escapeHtmlAttribute(embed.srcDoc);
  return `<iframe class="my-2 w-full rounded-lg border border-border/50 bg-transparent" style="height:${embed.height}px;" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" loading="lazy" srcdoc="${srcDoc}"></iframe>`;
}

// ── Render cache ──────────────────────────────────────────────────

const _renderCache = new Map<string, string>();
const RENDER_CACHE_MAX = 2000;

// ── Main render pipeline ───────────────────────────────────────────

/**
 * Render a chat message to safe HTML (cached).
 *
 * Completed messages have stable content, so caching avoids re-running
 * the full markdown + DOMPurify pipeline on every React re-render.
 * Only the actively-streaming message misses cache (content changes per token).
 */
export function renderMessage(raw: string): string {
  const cached = _renderCache.get(raw);
  if (cached !== undefined) return cached;

  const html = renderMessageUncached(raw);

  // LRU eviction — Map iteration order = insertion order
  if (_renderCache.size >= RENDER_CACHE_MAX) {
    const firstKey = _renderCache.keys().next().value;
    if (firstKey !== undefined) _renderCache.delete(firstKey);
  }
  _renderCache.set(raw, html);
  return html;
}

const renderMessageUncached = createChatMarkdownRenderer({
  resolveImageSrc: resolveSandboxImageSrc,
  renderHtmlEmbed: code => renderHtmlEmbedHtml(parseHtmlEmbed(code)),
  afterSanitize: capitalizeSentenceStarts,
});

/**
 * Render markdown to safe HTML.
 * This is the utility exposed to message renderer components via props.
 */
export function renderMarkdown(text: string): string {
  return renderMessage(text);
}
