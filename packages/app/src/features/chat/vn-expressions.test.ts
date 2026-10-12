import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { bundleAndCompile } from "../studio/lib/tsx-bundler";

const source = fileURLToPath(new URL("../../../../../interfaces/vn/", import.meta.url));
const files = Object.fromEntries(readdirSync(source).filter(n => /\.(tsx?|jsx?)$/.test(n)).map(n => [n, readFileSync(source + n, "utf8")]));

test("VN maps dialogue, segments and sprite variables to the same six expressions", () => {
  const expressions = ["normal", "happy", "sad", "angry", "shy", "smug"];
  const sampleEmotions = ["normal", "happy", "sad", "angry", "shy", "smug", " IRRITATED ", "annoyed", "furious", "amused", "worried", "blushing", "haughty", "condescending", "self_satisfied", "self-assured", "stunned", "surprised", "not angry", "unconfigured", "__proto__", "constructor", null, {}, []];
  const raw = '[SPEAKER:Diane:irritated] "You dare walk away?!" [SPEAKER:Narrator:normal] *Diane folds her arms.* [Name:Maeve:blushing] "Hello."';
  const api = {
    entries: [{ name: "Diane Bluerose", role: "character" }, { name: "Maeve", role: "character" }],
    variables: {
      "vn-sprites": {
        "Diane Bluerose": Object.fromEntries(expressions.map(emotion => [emotion, `@asset:diane-${emotion}`])),
        Maeve: { normal: "@asset:maeve-normal", shy: "@asset:maeve-shy" },
      },
      "diane bluerose-emotion": "furious",
      segments: [{ speaker: "Diane", emotion: "condescending", text: "Hmph." }],
    },
    resolveAssetUrl: (ref: string) => ref,
    sampleEmotions,
    raw,
  };
  const result = bundleAndCompile({ files: { ...files, "probe.tsx": `
    import { normalizeSpriteExpression, spriteExpressions } from "./expressions";
    import { passages, segmentPassages } from "./passages";
    import { spriteFor, sceneSprites } from "./sprites";
    export default function Probe() {
      const api = useYumina();
      const lines = passages(api.entries, api.raw);
      const narrator = passages(api.entries, '[SPEAKER:Narrator:irritated] *The hall is quiet.*');
      return <pre>{JSON.stringify({
        expressions: spriteExpressions,
        normalized: api.sampleEmotions.map(normalizeSpriteExpression),
        sprites: api.sampleEmotions.map(emotion => spriteFor(api, { name: "Diane Bluerose", emotion })),
        lines,
        castAfterNarration: sceneSprites(api, lines.slice(0, 2).concat(narrator), 4),
        segments: segmentPassages(api),
        variableSprite: spriteFor(api, { name: "Diane Bluerose" }),
        missingArt: spriteFor(api, { name: "Maeve", emotion: "furious" })
      })}</pre>;
    }` }, entryFile: "probe.tsx" }, () => api);
  assert.equal(result.error, null, result.error ?? undefined);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  try {
    const dom = new JSDOM(renderToStaticMarkup(createElement(result.Component!)));
    const output = JSON.parse(dom.window.document.querySelector("pre")!.textContent!);
    dom.window.close();
    assert.deepEqual(output.expressions, expressions);
    assert.deepEqual(output.normalized, ["normal", "happy", "sad", "angry", "shy", "smug", "angry", "angry", "angry", "happy", "sad", "shy", "smug", "smug", "smug", "smug", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal", "normal"]);
    assert.ok(output.normalized.every((value: string) => expressions.includes(value)), "the mapper can return only the six art types");
    assert.deepEqual(output.sprites.slice(0, 22), output.normalized.slice(0, 22).map((emotion: string) => `@asset:diane-${emotion}`));
    assert.deepEqual(output.lines.filter((line: { name: string }) => line.name).map((line: { name: string; emotion: string }) => [line.name, line.emotion]), [["Diane Bluerose", "angry"], ["Maeve", "shy"]]);
    assert.deepEqual(output.castAfterNarration, [{ name: "Diane Bluerose", emotion: "angry", src: "@asset:diane-angry" }], "narration retains the last character expression");
    assert.equal(output.segments[0].emotion, "smug");
    assert.equal(output.variableSprite, "@asset:diane-angry");
    assert.equal(output.missingArt, "@asset:maeve-normal");
    assert.equal(api.raw, raw, "display normalization never rewrites saved dialogue");
  } finally {
    if (previous) Object.defineProperty(globalThis, "React", previous);
    else Reflect.deleteProperty(globalThis, "React");
  }
});
