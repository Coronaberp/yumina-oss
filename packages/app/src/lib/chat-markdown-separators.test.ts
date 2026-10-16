import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<div></div>");
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
const sandbox = await import("../../sandbox/chat/markdown");
const host = await import("./markdown");

for (const [name, renderer] of [["shared Chat", sandbox], ["host", host]] as const) {
  function render(text: string) {
    const root = dom.window.document.createElement("div");
    root.innerHTML = renderer.renderMessage(text);
    return root;
  }
  test(`${name}: opening scene separators render as horizontal rules alongside emphasis`, () => {
    const source = '*And today… Aelorian Myrren steps into it.*\n\n---\n\n*The transport hums softly as it glides over Solaris City.*';
    const root = render(source);
    assert.equal(root.querySelectorAll("hr").length, 1);
    assert.equal(root.querySelectorAll("em").length, 2);
    assert.ok(!root.textContent!.includes("---"));
    assert.equal(renderer.renderMarkdown(source), renderer.renderMessage(source));
  });
  test(`${name}: thematic break variants work with spaces and Windows line endings`, () => {
    for (const rule of ["---", "-----", "***", "___", "- - -", "* * *", "_ _ _", "   ---  "]) {
      assert.equal(render(`First scene.\r\n\r\n${rule}\r\n\r\nNext scene.`).querySelectorAll("hr").length, 1, rule);
    }
  });
  test(`${name}: inline punctuation, code, HTML embeds and non-separators stay literal`, () => {
    const source = 'The engine---still humming.\n--\n-*_\n    ---\n`---`\n\n```text\n---\n***\n___\n```';
    const root = render(source);
    assert.equal(root.querySelector("hr"), null);
    assert.equal(root.querySelector("code")!.textContent, "---");
    for (const literal of ["---", "***", "___"]) assert.ok(root.querySelector("pre code")!.textContent!.includes(literal));
    const embed = render('```html\n<p>---</p>\n```');
    assert.equal(embed.querySelector("hr"), null);
    assert.equal(embed.querySelectorAll("iframe").length, 1);
  });
  test(`${name}: partial streaming separators become rules only when complete`, () => {
    assert.equal(render("First scene.\n\n-").querySelector("hr"), null);
    assert.equal(render("First scene.\n\n--").querySelector("hr"), null);
    assert.equal(render("First scene.\n\n---").querySelectorAll("hr").length, 1);
    assert.equal(render("First scene.\n\n--- interrupted").querySelector("hr"), null);
  });
}
