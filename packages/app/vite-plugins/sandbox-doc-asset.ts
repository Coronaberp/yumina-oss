import crypto from "node:crypto";
import { build, type InlineConfig, type Plugin } from "vite";
import { inlineSandboxDocument } from "./sandbox-inline-doc";

/** Emit the BUILT sandbox document a second time under a content-hashed name
 *  in /assets/, and point the app at that copy.
 *
 *  Why: Cloudflare's cache rules cover /assets/* only. At its authored path the
 *  document is cf-cache-status: DYNAMIC, so every custom-UI card load reaches
 *  the single LA origin — and 503s there for the length of a deploy swap, which
 *  the iframe reports as a boot that simply never finishes. Content-hashed and
 *  under /assets/, it is edge-cached and immutable, the parent page and the
 *  document it loads can never disagree about a version, and a tab that was
 *  open across a deploy keeps resolving the hash it already knows.
 *
 *  The document stays at its authored path too. That copy is the dev-server
 *  URL and the retry fallback: it is never hashed, so it cannot 404.
 */

const SENTINEL = "__YUMINA_SANDBOX_DOC_URL_SENTINEL";
const SOURCE_DOC = "sandbox/index.html";
const PREFIX = "assets/sandbox-doc-";
const SUFFIX = ".html";
/** Sized so the emitted URL is exactly as long as the sentinel it replaces —
 *  an equal-length swap leaves every sourcemap offset in the chunk valid. */
const HASH_LEN = SENTINEL.length - `/${PREFIX}`.length - SUFFIX.length;

export function sandboxDocAsset(makeInlineConfig: () => InlineConfig): Plugin {
  let inlineLocal = false;
  let mode = "production";
  return {
    name: "yumina:sandbox-doc-asset",
    apply: "build",
    // The document is written by vite:build-html in generateBundle, so we have
    // to run after it to hash the final bytes rather than a half-built shell.
    enforce: "post",
    configResolved(config) {
      inlineLocal = config.env.VITE_EDITION === "local";
      mode = config.mode;
    },
    async generateBundle(_options, bundle) {
      const doc = bundle[SOURCE_DOC];
      if (!doc || doc.type !== "asset") {
        this.error(
          `sandbox-doc-asset: no built "${SOURCE_DOC}" in the bundle. The sandbox ` +
            `document is what the iframe loads; shipping without a hashed copy ` +
            `would send every custom-UI card back to the uncached origin path.`,
        );
      }

      if (inlineLocal) {
        // A separate entry is necessary: Rollup cannot inline dynamic imports
        // in the app's multi-entry build. Use the same aliases/CSS transforms.
        const result = await build({ ...makeInlineConfig(), mode });
        if (Array.isArray(result) || !("output" in result)) {
          this.error("sandbox-doc-asset: expected one sandbox build output");
        }
        doc.source = inlineSandboxDocument(
          Object.fromEntries(result.output.map((item) => [item.fileName, item])),
        );
      }
      const source =
        typeof doc.source === "string" ? doc.source : Buffer.from(doc.source).toString("utf8");
      const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, HASH_LEN);
      const fileName = `${PREFIX}${hash}${SUFFIX}`;
      const url = `/${fileName}`;

      if (url.length !== SENTINEL.length) {
        this.error(
          `sandbox-doc-asset: "${url}" is ${url.length} chars but the sentinel is ` +
            `${SENTINEL.length}. An unequal swap would shift sourcemap offsets — ` +
            `adjust PREFIX/HASH_LEN so the two match.`,
        );
      }

      this.emitFile({ type: "asset", fileName, source });

      let replaced = 0;
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk" || !item.code.includes(SENTINEL)) continue;
        const parts = item.code.split(SENTINEL);
        replaced += parts.length - 1;
        item.code = parts.join(url);
      }

      if (replaced === 0) {
        this.error(
          `sandbox-doc-asset: the sentinel never appeared in any chunk, so the app ` +
            `would ship asking for a URL that does not exist and every custom-UI ` +
            `card would fail to boot. Check that src/lib/sandbox-doc-url.ts still ` +
            `holds the literal "${SENTINEL}" and that nothing folded it away.`,
        );
      }

      // ALSO publish the URL through index.html, which is no-store everywhere,
      // so the pointer is re-read fresh on every page load. The sentinel swap
      // above lives in a chunk whose NAME never changes across builds (the
      // equal-length swap happens after Vite hashed it), so edge and browser
      // caches hold it as immutable while its contents drift — after a deploy
      // that stale pointer 404s and every custom-UI card fails to boot
      // (2026-08-31 outage). Runtime prefers this injected value; the swapped
      // sentinel stays as the fallback for a document that missed injection.
      const shell = bundle["index.html"];
      if (!shell || shell.type !== "asset") {
        this.error(
          `sandbox-doc-asset: no built "index.html" in the bundle to inject the ` +
            `sandbox document URL into. Without it the app depends on the ` +
            `immutable-cached chunk pointer, which goes stale across deploys.`,
        );
      }
      const shellSource =
        typeof shell.source === "string" ? shell.source : Buffer.from(shell.source).toString("utf8");
      const inject = `<script>window.__YUMINA_SANDBOX_DOC_URL=${JSON.stringify(url)};</script>`;
      if (!shellSource.includes("</head>")) {
        this.error(`sandbox-doc-asset: built index.html has no </head> to inject before.`);
      }
      shell.source = shellSource.replace("</head>", `${inject}</head>`);

      this.info(`sandbox document → ${url} (${replaced} reference(s) rewritten, shell injected)`);
    },
  };
}
