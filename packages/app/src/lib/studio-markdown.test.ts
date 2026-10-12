import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<div></div>");
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
const { renderStudioMarkdown } = await import("./studio-markdown");
function documentFor(markdown: string) { return new JSDOM(renderStudioMarkdown(markdown)).window.document; }

test("assistant tables render as tables, including tables without outer pipes and inline cell formatting", () => {
  const document = documentFor("Category | What's in it | Fields\n--- | :---: | ---:\n**Overview** | Identity | `Rank`\nVitals | Body | Health");
  assert.equal(document.querySelectorAll("th").length, 3);
  assert.equal(document.querySelectorAll("tbody tr").length, 2);
  assert.equal(document.querySelector("td strong")?.textContent, "Overview");
  assert.equal(document.querySelector("td code")?.textContent, "Rank");
  assert.equal(document.querySelector("table")?.parentElement?.className, "studio-markdown-table");
});
test("nested lists, links, headings, quotes and emphasis render consistently", () => {
  const document = documentFor("## Done\n\n1. **Fields**\n   - [Link](https://example.com)\n2. *Colors*\n\n> A ~~rough~~ **finished** design");
  assert.equal(document.querySelector("h2")?.textContent, "Done");
  assert.equal(document.querySelectorAll("ol > li").length, 2);
  assert.equal(document.querySelector("ol ul li a")?.textContent, "Link");
  assert.ok(document.querySelector("blockquote del"));
  assert.equal(document.querySelector("a")?.getAttribute("rel"), "noopener noreferrer");
});
test("code stays literal, with line breaks preserved, including a partial streaming fence", () => {
  const document = documentFor('```tsx\nconst value = "**text**";\n<div />\n```');
  assert.equal(document.querySelector("pre code")?.textContent, 'const value = "**text**";\n<div />\n');
  assert.equal(document.querySelector("pre br"), null);
  assert.equal(documentFor("```js\nconst x = 1;").querySelector("pre code")?.textContent, "const x = 1;\n");
});
test("assistant Markdown never executes HTML, script, javascript links or image event handlers", () => {
  const document = documentFor('<script>alert(1)</script>\n\n[Bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n![bad](javascript:alert)');
  assert.equal(document.querySelector("script,iframe"), null);
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      assert.ok(!attribute.name.startsWith("on"));
      assert.ok(!/^javascript:/i.test(attribute.value));
    }
  }
});
