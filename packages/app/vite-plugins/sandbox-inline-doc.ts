import type { Rollup } from "vite";

/** Local sandboxes have an opaque origin. Access-protected module requests
 * cannot carry the parent's login cookie, so embed the complete runtime in the
 * authenticated iframe navigation instead. Keep the sandbox origin opaque. */
export function inlineSandboxDocument(bundle: Rollup.OutputBundle): string {
  const doc = bundle["sandbox/index.html"];
  if (!doc || doc.type !== "asset") throw new Error("Missing sandbox HTML");
  const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
  if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) {
    throw new Error("Sandbox runtime must be one chunk with no external imports");
  }
  const assetText = (asset: Rollup.OutputAsset) =>
    typeof asset.source === "string" ? asset.source : Buffer.from(asset.source).toString("utf8");
  let html = assetText(doc);
  let scripts = 0;
  html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/gi, (_tag, url: string) => {
    const chunk = bundle[url.replace(/^\//, "")];
    if (!chunk || chunk.type !== "chunk" || chunk !== chunks[0]) {
      throw new Error(`Unknown sandbox script: ${url}`);
    }
    scripts++;
    // HTML's raw-text parser recognizes closing tags even inside JS strings.
    return `<script type="module">${chunk.code.replace(/<\/script/gi, (tag) => tag.replace("/", "\\/"))}</script>`;
  });
  if (scripts !== 1) throw new Error("Sandbox HTML must reference its runtime exactly once");
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (/\brel="modulepreload"/i.test(tag)) return "";
    if (!/\brel="stylesheet"/i.test(tag)) return tag;
    const url = /\bhref="([^"]+)"/i.exec(tag)?.[1];
    const asset = url && bundle[url.replace(/^\//, "")];
    if (!asset || asset.type !== "asset" || !asset.fileName.endsWith(".css")) {
      throw new Error(`Unknown sandbox stylesheet: ${url}`);
    }
    return `<style>${assetText(asset).replace(/<\/style/gi, (closingTag) => closingTag.replace("/", "\\/"))}</style>`;
  });
  for (const item of Object.values(bundle)) {
    if (item.type === "asset" && item !== doc && !item.fileName.endsWith(".css")) {
      throw new Error(`Sandbox has an external asset: ${item.fileName}`);
    }
  }
  return html;
}
