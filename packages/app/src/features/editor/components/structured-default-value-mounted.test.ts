import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ComponentType } from "react";

const sourceUrl=new URL("./structured-default-value.tsx",import.meta.url);
const require=createRequire(sourceUrl);
const React=require("react"),{JSDOM}=require("jsdom"),{transform}=require("sucrase");

test("invalid numbers in structured defaults remain blocked after a sibling edit",async()=>{
  const dom=new JSDOM('<div id="root"></div>',{url:"https://yumina.test"});
  const globals={window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true};
  const previous=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const [key,value] of Object.entries(globals))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const {createRoot}=require("react-dom/client");
  const module={exports:{} as {StructuredDefaultValue:ComponentType}};
  const mocks:Record<string,unknown>={"./json-default-value-editor":{JsonDefaultValueEditor:()=>null}};
  new Function("require","module","exports",transform(readFileSync(sourceUrl,"utf8"),{transforms:["typescript","jsx","imports"],jsxRuntime:"automatic"}).code)((id:string)=>mocks[id]??require(id),module,module.exports);
  const root=createRoot(document.getElementById("root"));
  const original={id:"profile",name:"Profile",type:"json",defaultValue:{score:1,met:false}};
  const changes:unknown[]=[];
  const apply=()=>[...document.querySelectorAll("button")].find(node=>node.textContent==="Use starting value")!;
  const type=async(text:string)=>React.act(async()=>{
    const input=document.querySelector('input[aria-label="Score"]');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,"value")!.set!.call(input,text);
    input!.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
  });
  try{
    await React.act(async()=>root.render(React.createElement(module.exports.StructuredDefaultValue,{variable:original,onChange:(value:unknown)=>changes.push(value),expanded:false,onExpandedChange:()=>{}})));
    await type("invalid");
    await React.act(async()=>(document.querySelector('[role="switch"]') as HTMLButtonElement).click());
    assert.equal(apply().disabled,true,"a valid sibling edit cannot clear an invalid numeric draft");
    assert.equal(changes.length,0);
    await type("3");assert.equal(apply().disabled,false);
    await React.act(async()=>apply().click());
    assert.deepEqual((changes[0] as {defaultValue:unknown}).defaultValue,{score:3,met:true});
    assert.deepEqual(original.defaultValue,{score:1,met:false});
    assert.equal((document.querySelector("details") as HTMLDetailsElement).open,false,"raw remains in collapsed Advanced");
    await React.act(async()=>(document.querySelector('[aria-label="Options for Profile"]') as HTMLElement).click());
    const select=document.querySelector('[aria-label="Value type for Profile"]') as HTMLSelectElement;
    assert.deepEqual([...select.options].map(option=>option.value),["group","list"]);
  }finally{
    await React.act(async()=>root.unmount());dom.window.close();
    for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}
  }
});
