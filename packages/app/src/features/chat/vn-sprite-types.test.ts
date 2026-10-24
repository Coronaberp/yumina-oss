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
const catalog = { types: { normal: "Normal", battle: "Battle Wear" }, emotions: { normal: "Normal", happy: "Happy", angry: "Angry", shy: "Shy", curious: "Curious", embarrassed: "Embarrassed" } };
function probe(expression: string, extra = {}, spriteSource = files["sprites.ts"]
  .replace("export const sprites = {};", 'export const sprites = { Maeve: { normal: "@asset:base", happy: "@asset:happy", shy: "@asset:shy", curious: "@asset:curious" } };')
  .replace(/export const spriteConfig = [\s\S]*?;\n/, `export const spriteConfig = ${JSON.stringify(catalog)};\n`)
  .replace(/export const spriteTypes = [\s\S]*?;\n/, 'export const spriteTypes = { battle: { Maeve: {normal:"@asset:battle", embarrassed:"@asset:battle-embarrassed"} } };\n')) {
  const api = { entries: [{name:"Maeve", role:"character"}], variables: {}, resolveAssetUrl: (ref: string) => ref, ...extra };
  const result = bundleAndCompile({files:{...files,"sprites.ts":spriteSource,"probe.tsx":`import {passages,segmentPassages} from "./passages"; import {spriteFor,sceneSprites} from "./sprites"; import {expressionSprites} from "./character-viewer"; export default function Probe(){const api=useYumina();return <pre>{JSON.stringify(${expression})}</pre>;}`},entryFile:"probe.tsx"},()=>api);
  assert.equal(result.error,null,result.error ?? undefined);
  const previous = Object.getOwnPropertyDescriptor(globalThis,"React");
  Object.defineProperty(globalThis,"React",{configurable:true,value:React});
  try { const dom = new JSDOM(renderToStaticMarkup(createElement(result.Component!))); const output=JSON.parse(dom.window.document.querySelector("pre")!.textContent!); dom.window.close(); return output; }
  finally {if(previous)Object.defineProperty(globalThis,"React",previous);else Reflect.deleteProperty(globalThis,"React");}
}

test("old markers default to Normal; new markers retain custom emotions and wardrobe separately from NPC identity",()=>{
  const text='[SPEAKER:Maeve:embarrassed:battle] "Hello." [Name:Maeve:curious] "Why?" [SPEAKER:NPC:happy:female:merchant] "Welcome."';
  const lines=probe("passages(api.entries,api.text)",{text});
  assert.deepEqual(lines.map((line: any)=>[line.emotion,line.spriteType,line.npcGender,line.npcId]),[["embarrassed","battle",undefined,undefined],["curious","normal",undefined,undefined],["happy","normal","female","merchant"]]);
});

test("structured passages retain custom emotion and sprite type",()=>{
  assert.deepEqual(probe("segmentPassages(api)",{variables:{segments:[{speaker:"Maeve",emotion:"Embarrassed",spriteType:"Battle",text:"Hello."}]}}).map((line:any)=>[line.emotion,line.spriteType]),[["embarrassed","battle"]]);
});

test("sprite selection resolves exact custom emotions before aliases and follows wardrobe fallback order",()=>{
  const result=probe('[spriteFor(api,{name:"Maeve",emotion:"embarrassed",spriteType:"battle"}),spriteFor(api,{name:"Maeve",emotion:"happy",spriteType:"battle"}),spriteFor(api,{name:"Maeve",emotion:"curious",spriteType:"missing"}),spriteFor(api,{name:"Maeve",emotion:"unknown",spriteType:"missing"}),spriteFor(api,{name:"Maeve",emotion:"curious"}),spriteFor(api,{name:"Maeve",emotion:"blushing"})]');
  assert.deepEqual(result,["@asset:battle-embarrassed","@asset:battle","@asset:curious","@asset:base","@asset:curious","@asset:shy"]);
});

test("stage retains the requested type and exact custom emotion through narration and replay",()=>{
  const text='[SPEAKER:Maeve:embarrassed:battle] "Hello." [SPEAKER:Narrator:normal] *The sun sets.*';
  const result=probe("sceneSprites(api,passages(api.entries,api.text),4)",{text});
  assert.deepEqual(result,[{name:"Maeve",emotion:"embarrassed",spriteType:"battle",src:"@asset:battle-embarrassed"}]);
});

test("character viewer lists configured wardrobes and custom emotion art",()=>{
  const images=probe('expressionSprites(api,{name:"Maeve"})');
  assert.ok(images.some((image:any)=>image.spriteType==="normal"&&image.expression==="curious"&&image.src==="@asset:curious"));
  assert.ok(images.some((image:any)=>image.spriteType==="battle"&&image.expression==="embarrassed"&&image.src==="@asset:battle-embarrassed"&&image.typeLabel==="Battle Wear"));
});

test("legacy emotion and wardrobe keys remain addressable after normalized story markers",()=>{
  const api={variables:{"vn-sprites":{Maeve:{Normal:"@asset:base",Happy:"@asset:happy",Embarrassed:"@asset:embarrassed"}},"vn-sprite-types":{Battle:{Maeve:{Happy:"@asset:battle-happy"}}},"vn-sprite-config":{types:{normal:"Normal",Battle:"Battle"},emotions:{Embarrassed:"Embarrassed"}}}};
  assert.deepEqual(probe('[spriteFor(api,{name:"Maeve",emotion:"happy"}),spriteFor(api,{name:"Maeve",emotion:"embarrassed"}),spriteFor(api,{name:"Maeve",emotion:"happy",spriteType:"battle"}),spriteFor(api,{name:"Maeve",emotion:"sad"})]',api),["@asset:happy","@asset:embarrassed","@asset:battle-happy","@asset:base"]);
});
