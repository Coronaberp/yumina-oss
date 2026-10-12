import DOMPurify from "dompurify";
import type { CardShowcase } from "@yumina/engine";
import { getAssetCdnUrl } from "./asset-url";
import { renderCommunityMarkdown } from "./markdown";

function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** A script-disabled iframe contains all author HTML/CSS. */
export function buildCardShowcaseDocument(showcase: CardShowcase, options: {
  name: string; description: string; cover?: string | null;
}) {
  const fallback = `${options.cover ? `<img class="card-showcase-cover" src="${escapeText(options.cover)}" alt="" />` : ""}<h1 class="card-showcase-title">${escapeText(options.name)}</h1><div class="card-showcase-description">${renderCommunityMarkdown(options.description, { theme: "dark" })}</div>`;
  const template = document.createElement("template");
  template.innerHTML = DOMPurify.sanitize(showcase.html.trim() ? showcase.html : fallback, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "link", "meta", "base", "audio", "video"],
    FORBID_ATTR: ["srcdoc"],
  });
  for (const image of template.content.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (src.startsWith("@asset:")) image.src = getAssetCdnUrl(src.slice(7));
  }
  for (const link of template.content.querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  // Escaping '<' prevents a stylesheet from closing its HTML style element.
  const css = showcase.css.replace(/:scope\b/g, ".card-showcase").replaceAll("<", "\\3c ");
  const assetOrigin = new URL(getAssetCdnUrl("")).origin;
  const policy = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${window.location.origin} ${assetOrigin} https: data:; font-src ${window.location.origin} ${assetOrigin} https: data:; connect-src 'none'; media-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${escapeText(policy)}"><style>
html,body{margin:0;background:transparent}*{box-sizing:border-box}body{color:#eadfca;font:15px/1.65 system-ui,sans-serif}.card-showcase{display:flow-root;padding:24px;overflow-wrap:anywhere}.card-showcase img{max-width:100%;height:auto}.card-showcase-cover{display:block;width:100%;border-radius:12px;margin-bottom:24px}.card-showcase-title{margin:0 0 16px;font-size:28px;line-height:1.2}.card-showcase a{color:#d6c391}h1,h2,h3,p{overflow-wrap:anywhere}@media(max-width:480px){.card-showcase{padding:16px}}
${css}</style></head><body><main class="card-showcase">${template.innerHTML}</main></body></html>`;
}
