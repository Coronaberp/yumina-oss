import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { splitSpeakerSections } from "../../sandbox/chat/speaker";

const dom = new JSDOM("<div></div>");
Object.defineProperty(globalThis, "window", { configurable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, value: dom.window.document });
const sandbox = await import("../../sandbox/chat/markdown");
const host = await import("./markdown");

for (const [name, renderer] of [["shared Chat", sandbox], ["Studio playtest preview", host]] as const) {
  const render = (source: string) => {
    const root = dom.window.document.createElement("div");
    root.innerHTML = renderer.renderMessage(source);
    return root;
  };
  test(`${name}: real Markdown headings, paragraphs, nested lists, quotes and tasks`, () => {
    const source = '# Academy\n\n## Arrival\n\n### Three\n#### Four\n##### Five\n###### Six\n\nSetext heading\n==============\n\nFirst paragraph.\n\nSecond paragraph with **bold _and emphasis_**, __bold__, *italic*, _italic_ and ~~deleted~~.\n\n3. First\n   - Nested **item**\n     - Deeper item\n4. Second\n\n> Quoted **text**\n>\n> - A quoted list\n\n- [x] Finished\n- [ ] Pending';
    const root = render(source);
    for (const level of [1, 2, 3, 4, 5, 6]) assert.ok(root.querySelector(`h${level}`));
    assert.equal(root.querySelector("ol")?.getAttribute("start"), "3");
    assert.ok(root.querySelector("ol ul ul li"));
    assert.ok(root.querySelector("blockquote ul li"));
    assert.ok(root.querySelector("strong em"));
    assert.equal(root.querySelector("del")?.textContent, "deleted");
    assert.equal(root.querySelectorAll('input[type="checkbox"][disabled]').length, 2);
    assert.equal(root.querySelectorAll('input[checked]').length, 1);
  });
  test(`${name}: GFM tables retain alignment, escaped pipes and formatted cells`, () => {
    const root = render('Name | Status | Value\n:--- | :---: | ---:\n**Mei** | *Ready* | `42`\nBlair | A \\| B | [Guide](https://example.com/path_(one) "Academy guide")');
    assert.equal(root.querySelectorAll("th").length, 3);
    assert.equal(root.querySelectorAll("tbody tr").length, 2);
    assert.equal(root.querySelector("td strong")?.textContent, "Mei");
    assert.equal(root.querySelector("td code")?.textContent, "42");
    assert.ok(root.textContent!.includes("A | B"));
    assert.equal(root.querySelector("a")?.getAttribute("href"), "https://example.com/path_(one)");
    assert.equal(root.querySelector("a")?.getAttribute("title"), "Academy guide");
    assert.ok(root.querySelector(".chat-markdown-table > table"));
  });
  test(`${name}: reference links, autolinks, escapes and code use Markdown tokenization`, () => {
    const root = render('[**Read** the guide][guide]\n\n[guide]: https://example.com/guide "Title"\n\nhttps://example.com/test and <reader@example.com>\n\n\\*literal stars\\* and snake_case_name\n\n``code with `a tick` and **stars**``\n\n~~~~ts\nconst value = "**literal**";\n[image:https://example.com/not-an-image.png]\n~~~~\n\n```js\nconst unfinished = 1;');
    assert.equal(root.querySelector("a strong")?.textContent, "Read");
    assert.ok(root.querySelector('a[href="mailto:reader@example.com"]'));
    assert.ok(root.textContent!.toLowerCase().includes("*literal stars*"));
    assert.ok(root.textContent!.includes("snake_case_name"));
    assert.equal(root.querySelectorAll("pre").length, 2);
    assert.equal(root.querySelector("pre br"), null);
    assert.ok(root.querySelector("pre code")!.textContent!.includes('[image:https://example.com/not-an-image.png]'));
    assert.equal(root.querySelectorAll("img").length, 0);
  });
  test(`${name}: assets and HTML embeds work while unsafe links and raw HTML stay inert`, () => {
    const root = render('![Portrait](@asset:c4100969-1efb-4fb0-9850-595dcc625da7 "Portrait title")\n\n[image:https://example.com/scene.png|caption=The courtyard]\n\n```html\n{"html":"<h2>Embedded</h2>","height":240}\n```\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert(1))\n\n![Bad](javascript:alert)');
    assert.equal(root.querySelectorAll("img").length, 3);
    assert.ok(root.querySelector('img[alt="Portrait"]')!.getAttribute("src")!.includes("/cdn"));
    assert.equal(root.querySelector("iframe")?.getAttribute("style"), "height:240px;");
    assert.ok(root.querySelector("iframe")?.getAttribute("srcdoc")?.includes("<h2>Embedded</h2>"));
    assert.ok(root.querySelector("iframe")?.getAttribute("sandbox")?.includes("allow-scripts"));
    assert.ok(!root.querySelector("iframe")?.getAttribute("sandbox")?.includes("allow-same-origin"));
    assert.equal(root.querySelector("script"), null);
    for (const element of root.querySelectorAll("*")) for (const attribute of element.attributes) {
      assert.ok(!attribute.name.startsWith("on"));
      assert.ok(!/^javascript:/i.test(attribute.value));
    }
  });
}

test("speaker separation preserves complete Markdown containers instead of splitting quoted table cells", () => {
  const source = '# Notes\n\n[Read the guide][guide]\n\n> "A quoted passage" with **bold**.\n\n- Say "Hello"\n- Then **wait**\n\nName | Quote\n--- | ---\nMei | "Welcome"\n\n[guide]: https://example.com/guide "Guide title"';
  const sections = splitSpeakerSections([{ name: "Mei", role: "character" }], source);
  assert.equal(sections.length, 1);
  const root = dom.window.document.createElement("div");
  root.innerHTML = sandbox.renderMessage(sections[0]!.content);
  assert.ok(root.querySelector("table tbody td"));
  assert.equal(root.querySelectorAll("ul > li").length, 2);
  assert.ok(root.querySelector("blockquote strong"));
  assert.equal(root.querySelector("a")?.getAttribute("title"), "Guide title");
  assert.equal(sections[0]!.text, source);
});

test("Markdown emphasis inside marked speech reaches the renderer while italic actions stay separate", () => {
  const source = '[SPEAKER:Mei:happy] "You **must** read the _guide_." *Mei points at the **door**.*';
  const sections = splitSpeakerSections([{ name: "Mei", role: "character" }], source);
  assert.equal(sections[0]!.speaker?.name, "Mei");
  assert.equal(sections[0]!.content.trim(), '"You **must** read the _guide_."');
  assert.equal(sections[1]!.speaker, null);
});
