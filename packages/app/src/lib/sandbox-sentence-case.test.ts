import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<div></div>");
Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: dom.window.document });
const { renderMessage, renderMarkdown } = await import("../../sandbox/chat/markdown");
const { capitalizeSentenceStarts } = await import("../../sandbox/chat/sentence-case");

function rendered(raw: string): Element {
  const root = dom.window.document.createElement("div");
  root.innerHTML = renderMessage(raw);
  return root;
}

test("interrupted dialogue and narration start with capitals without changing the source", () => {
  const source = 'you,\n\n*ryu said flatly, her voice dropping.*\n\nare the single most expensive mistake. which is an achievement, of a sort.';
  const root = rendered(source);
  assert.equal(root.textContent, 'You,Ryu said flatly, her voice dropping.Are the single most expensive mistake. Which is an achievement, of a sort.');
  assert.equal(root.querySelector("em")!.textContent, "Ryu said flatly, her voice dropping.");
  assert.ok(source.startsWith("you,"));
  assert.equal(renderMarkdown("are the single most expensive mistake."), "Are the single most expensive mistake.");
});

test("sentence boundaries cross emphasis and quotes without capitalizing other words", () => {
  const root = rendered('“hello **my friend.**” *how are you?* **fine!** let us go. the iPhone is yours.');
  assert.equal(root.textContent, '“Hello my friend.” How are you? Fine! Let us go. The iPhone is yours.');
  assert.equal(root.querySelector("strong")!.textContent, "my friend.");
});

test("soft line breaks preserve continuations and blank lines start paragraphs", () => {
  assert.equal(rendered("hello\nmy friend.\nwelcome back.\n\na new paragraph.").textContent,
    "Hellomy friend.Welcome back.A new paragraph.");
  assert.equal(rendered("https://example.com。 next. user@example.com！ again.").textContent,
    "https://example.com。 Next. user@example.com！ Again.");
});

test("Unicode sentence starts and existing mixed case are preserved", () => {
  assert.equal(rendered('élise waits. über quiet! qué pasó? “hello.”\n你好。\nпривет. ещё раз.').textContent,
    'Élise waits. Über quiet! Qué pasó? “Hello.”你好。Привет. Ещё раз.');
  assert.equal(rendered("eBay is open. iPhone users arrive. 3.14 slimes remain.").textContent,
    "EBay is open. IPhone users arrive. 3.14 slimes remain.");
});

test("code, addresses, image attributes and embedded HTML keep their exact case", () => {
  const inline = rendered('`lowerCase. keepThis()` stays literal. next sentence.');
  assert.equal(inline.querySelector("code")!.textContent, "lowerCase. keepThis()");
  assert.equal(inline.textContent, "lowerCase. keepThis() stays literal. Next sentence.");
  const block = rendered('```js\nconst lowerCase = "hello. world";\n```');
  assert.equal(block.querySelector("code")!.textContent, 'const lowerCase = "hello. world";');
  assert.equal(rendered('https://example.com/lowerCase stays valid. visit user@example.com now.').textContent,
    'https://example.com/lowerCase stays valid. Visit user@example.com now.');
  const image = rendered('![lower case](https://example.com/lowerCase.png) hello.');
  assert.equal(image.querySelector("img")!.getAttribute("alt"), "lower case");
  assert.equal(image.querySelector("img")!.getAttribute("src"), "https://example.com/lowerCase.png");
  assert.equal(image.textContent, " Hello.");
  const embed = dom.window.document.createElement("div");
  const iframe = dom.window.document.createElement("iframe");
  iframe.setAttribute("srcdoc", '<div id="lowerCase">hello. world</div>');
  embed.append(iframe);
  capitalizeSentenceStarts(embed);
  assert.equal(iframe.getAttribute("srcdoc"), '<div id="lowerCase">hello. world</div>');
});

test("streamed sentence prefixes and cached completed messages agree", () => {
  for (const source of ["a", "are", "are the", "are the mistake. n", "are the mistake. next"]) {
    assert.equal(rendered(source).textContent, source[0]!.toUpperCase() + source.slice(1).replace(/\. n/, ". N"));
    assert.equal(renderMessage(source), renderMarkdown(source));
  }
  assert.equal(rendered('**h').textContent, '**H');
});
