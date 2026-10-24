const rootChanges: readonly (readonly [string, string])[] = [
  [
    "    function layout() {\n      if (cancelled) return;\n      const bounds = node.getBoundingClientRect();\n      const controls = node.querySelector(\".vn-controls\");\n      const top = controls ? controls.getBoundingClientRect().bottom - bounds.top + 12 : 12;\n      const reading = [...node.querySelectorAll(\".vn-dialogue,.vn-choices\")].filter(element => element.getClientRects().length);\n      const edge = reading.length ? Math.min(...reading.map(element => element.getBoundingClientRect().top)) : bounds.bottom - bounds.height * .19;\n      node.style.setProperty(\"--cast-top\", `${top}px`);\n      const dialogue = node.querySelector(\".vn-dialogue\");\n      if (dialogue) {\n        const bottom = bounds.bottom - dialogue.getBoundingClientRect().top + 16;\n        node.style.setProperty(\"--choices-bottom\", `${bottom}px`);\n        node.style.setProperty(\"--choices-max-height\", `${Math.max(44, bounds.height - bottom - top)}px`);\n      }\n      node.style.setProperty(\"--reading-shade-height\", `${Math.min(bounds.height, Math.max(0, bounds.bottom - edge + 80))}px`);\n    }",
    "    function layout() {\n      if (cancelled) return;\n      const bounds = node.getBoundingClientRect();\n      const controls = node.querySelector(\".vn-controls\");\n      const top = controls ? controls.getBoundingClientRect().bottom - bounds.top + 12 : 12;\n      const dialogue = node.querySelector(\".vn-dialogue\"), text = node.querySelector(\".vn-text\"), progress = node.querySelector(\".vn-progress\");\n      const errorBanner = node.querySelector(\".vn-error\");\n      if (errorBanner && dialogue && text) {\n        const passageBottom = Math.max(dialogue.getBoundingClientRect().bottom, progress?.getBoundingClientRect().bottom || 0);\n        const chrome = passageBottom - dialogue.getBoundingClientRect().top - text.getBoundingClientRect().height;\n        const lineHeight = parseFloat(window.getComputedStyle(text).lineHeight) || 44;\n        node.style.setProperty(\"--error-max-height\", `${Math.max(44, bounds.height - top - chrome - lineHeight - 36)}px`);\n        const offset = parseFloat(node.style.getPropertyValue(\"--error-space\")) || 0;\n        node.style.setProperty(\"--error-space\", `${Math.max(0, offset + passageBottom - errorBanner.getBoundingClientRect().top + 16)}px`);\n      } else {\n        node.style.setProperty(\"--error-space\", \"0px\");\n        node.style.removeProperty(\"--error-max-height\");\n      }\n      const reading = [...node.querySelectorAll(\".vn-dialogue,.vn-choices\")].filter(element => element.getClientRects().length);\n      const edge = reading.length ? Math.min(...reading.map(element => element.getBoundingClientRect().top)) : bounds.bottom - bounds.height * .19;\n      node.style.setProperty(\"--cast-top\", `${top}px`);\n      if (dialogue) {\n        const bottom = bounds.bottom - dialogue.getBoundingClientRect().top + 16;\n        node.style.setProperty(\"--choices-bottom\", `${bottom}px`);\n        node.style.setProperty(\"--choices-max-height\", `${Math.max(44, bounds.height - bottom - top)}px`);\n      }\n      node.style.setProperty(\"--reading-shade-height\", `${Math.min(bounds.height, Math.max(0, bounds.bottom - edge + 80))}px`);\n    }"
  ],
  [
    "node.querySelectorAll(\".vn-dialogue,.vn-choices,.vn-controls\")",
    "node.querySelectorAll(\".vn-dialogue,.vn-progress,.vn-choices,.vn-controls,.vn-error\")"
  ],
  [
    "hidden, spriteLimit, JSON.stringify(api.vnTextPreferences)",
    "hidden, spriteLimit, error, JSON.stringify(api.vnTextPreferences)"
  ]
];

const styleChanges: readonly (readonly [string, string])[] = [
  [
    ".vn-dialogue{position:absolute;bottom:85px;",
    ".vn-dialogue{position:absolute;bottom:calc(85px + var(--error-space,0px));"
  ],
  [
    ".vn-dialogue{bottom:7.8704vh}",
    ".vn-dialogue{bottom:calc(7.8704vh + var(--error-space,0px))}"
  ],
  [
    ".vn-dialogue{bottom:7%;left:6%;",
    ".vn-dialogue{bottom:calc(7% + var(--error-space,0px));left:6%;"
  ],
  [
    "inset:auto 20px var(--reader-bottom);",
    "inset:auto 20px calc(var(--reader-bottom) + var(--error-space,0px));"
  ],
  [
    "max-height:calc(100% - var(--reader-top) - var(--reader-bottom));",
    "max-height:calc(100% - var(--reader-top) - var(--reader-bottom) - var(--error-space,0px));"
  ],
  [
    "inset:auto 5% 16px;",
    "inset:auto 5% calc(16px + var(--error-space,0px));"
  ],
  [
    "max-height:calc(100% - 92px);",
    "max-height:calc(100% - 92px - var(--error-space,0px));"
  ],
  [
    "flex-wrap:wrap;max-height:40vh;overflow:auto;position:absolute;",
    "flex-wrap:wrap;max-height:min(40vh,var(--error-max-height,40vh));overflow:auto;position:absolute;"
  ]
];

const constrainedPassage = "/* Keep a long passage scrollable above wrapped recovery errors and the toolbar. */\n.vn:has(>.vn-error) .vn-reading{max-height:calc(100% - var(--cast-top,88px) - var(--reader-bottom,16px) - var(--error-space,0px))}\n.vn:has(>.vn-error) .vn-text{max-height:min(28cqh,max(1lh,calc(100cqh - var(--error-space,0px) - var(--cast-top,88px) - 200px)))}\n";

function replaceStock(source: string, changes: readonly (readonly [string, string])[]): string | null {
  let next = source;
  for (const [before, after] of changes) {
    if (next.split(before).length !== 2) return null;
    next = next.replace(before, after);
  }
  return next;
}

/** Upgrade only recognized shipped reader anchors; retain authored interface
 * files and decline customized layout hooks or CSS rather than replacing them. */
export function upgradeVnErrorLayoutFiles(files: Record<string, string>): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !source.includes('className="vn-stage"') || !source.includes('className="vn-error"')
      || !source.includes('import { styles } from "./styles";')) continue;
    const styleName = name.slice(0, name.lastIndexOf("/") + 1) + "styles.ts";
    const styles = files[styleName];
    if (!styles || !/export const styles = `[^`]*`;\n$/.test(styles)) continue;
    const root = replaceStock(source, rootChanges), css = replaceStock(styles, styleChanges);
    if (root === null || css === null || styles.includes("--error-space")) continue;
    if (updated === files) updated = { ...files };
    updated[name] = root;
    updated[styleName] = css.slice(0, -3) + constrainedPassage + "`;\n";
  }
  return updated;
}
