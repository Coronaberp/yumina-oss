import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React, { type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { OfficialBadge, OFFICIAL_SUPPORT_EMAIL, OFFICIAL_USER_ID, OFFICIAL_USERNAME } from "../../lib/official-account";

const require = createRequire(import.meta.url);
const settingsUrl = new URL("./settings-page.tsx", import.meta.url);
const settingsText = readFileSync(settingsUrl, "utf8");
const settingsSource = ts.createSourceFile("settings-page.tsx", settingsText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const about = settingsSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "AboutSection");
assert.ok(about, "The actual About settings section is available");
const aboutText = about.getText(settingsSource);

function evaluate(code: string, dependencies: (name: string) => unknown, scope: Record<string, unknown> = {}) {
  const module = { exports: {} as Record<string, unknown> };
  const transformed = ts.transpileModule(code, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function("require", "module", "exports", ...Object.keys(scope), transformed)(dependencies, module, module.exports, ...Object.values(scope));
  return module.exports;
}

function renderAbout(language = "en") {
  // Real link modules and real About markup; fixture hooks avoid mounting the
  // entire authenticated settings application or contacting any service.
  const docs = evaluate(readFileSync(new URL("../../lib/docs-urls.ts", import.meta.url), "utf8"), name => {
    assert.equal(name, "@/lib/i18n");
    return { default: { language } };
  });
  const links = evaluate(readFileSync(new URL("../../lib/community-links.ts", import.meta.url), "utf8"), require);
  const imports = settingsSource.statements.filter(ts.isImportDeclaration).filter(node =>
    ts.isStringLiteral(node.moduleSpecifier) && ["@/lib/docs-urls", "@/lib/community-links"].includes(node.moduleSpecifier.text),
  ).map(node => node.getText(settingsSource)).join("\n");
  const labels = JSON.parse(readFileSync(new URL("../../locales/en/settings.json", import.meta.url), "utf8"));
  const icon = () => React.createElement("svg");
  const scope = {
    useTranslation: () => ({ t: (key: string) => key.split(".").reduce((value, part) => value?.[part], labels) ?? key }),
    useRouter: () => ({ navigate() {} }), useStartDm: () => async () => {},
    useEdition: () => ({ features: { dm: false }, edition: "local", release: null }),
    useCopyFeedback: () => ({ copied: false, copy: async () => {} }), useCallback: React.useCallback,
    getUserProfileHref: () => null, OFFICIAL_SUPPORT_EMAIL, OFFICIAL_USER_ID, OFFICIAL_USERNAME, OfficialBadge,
    SectionHeader: ({ title }: { title: string }) => React.createElement("h2", null, title),
    MessageSquare: icon, Check: icon, Mail: icon, ChevronRight: icon,
  };
  const { AboutSection } = evaluate(imports + "\n" + aboutText + "\nexports.AboutSection = AboutSection;", name => {
    if (name === "@/lib/docs-urls") return docs;
    if (name === "@/lib/community-links") return links;
    return require(name);
  }, scope);
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(AboutSection as ComponentType)));
  return { dom, links, docs };
}

test("Settings GitHub OSS opens this installation's requested source repository", () => {
  const { dom } = renderAbout();
  try {
    const anchors = [...dom.window.document.querySelectorAll("a")];
    const source = anchors.find(anchor => anchor.textContent?.trim() === "GitHub OSS");
    assert.ok(source, "GitHub OSS remains visible under the existing label");
    assert.equal(source.getAttribute("href"), "https://github.com/Coronaberp/yumina-oss");
    assert.equal(source.target, "_blank");
    assert.equal(source.rel, "noopener noreferrer");
  } finally { dom.window.close(); }
});

test("Settings keeps legal documentation, support and upstream community destinations", () => {
  for (const [language, prefix] of [["en", ""], ["ja", "/ja"]]) {
    const { dom, links, docs } = renderAbout(language);
    try {
      const hrefs = [...dom.window.document.querySelectorAll("a")].map(anchor => anchor.getAttribute("href"));
      assert.ok(hrefs.includes(`https://docs.yumina.io${prefix}/legal/terms-of-use`));
      assert.ok(hrefs.includes(`https://docs.yumina.io${prefix}/legal/privacy-policy`));
      assert.ok(hrefs.includes("mailto:support@yumina.io"));
      assert.match(dom.window.document.body.textContent ?? "", /Yumina \(local\)/);
      assert.equal((links.COMMUNITY_LINKS as { github: string }).github, "https://github.com/lovetimo0421/yumina-oss");
      assert.equal((docs.DOCS_URLS as { openSource: string }).openSource, "https://github.com/lovetimo0421/yumina-oss");
    } finally { dom.window.close(); }
  }
});

test("source destination changes retain original code/docs licensing and trademark attribution", () => {
  const rootFile = (name: string) => readFileSync(new URL(`../../../../../${name}`, import.meta.url), "utf8");
  assert.equal(JSON.parse(rootFile("package.json")).license, "AGPL-3.0-only");
  assert.match(rootFile("LICENSE"), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(rootFile("LICENSE-DOCS.md"), /Based on the Yumina docs, https:\/\/github\.com\/lovetimo0421\/yumina-oss, CC BY 4\.0/);
  assert.match(rootFile("TRADEMARK.md"), /Yumina/);
});
