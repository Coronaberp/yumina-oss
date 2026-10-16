import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { createElement, act } from 'react';
import React from 'react';
import { JSDOM } from 'jsdom';
import { bundleAndCompile } from '../studio/lib/tsx-bundler';

const source = new URL('../../../../../interfaces/vn/', import.meta.url);
const files = Object.fromEntries(readdirSync(source).filter(file => /\.(tsx?|jsx?)$/.test(file)).map(file => [file, readFileSync(new URL(file, source), 'utf8')]));

async function fixture(overrides: Record<string, unknown> = {}) {
  const dom = new JSDOM('<div id="root"></div>', {url:'http://localhost'});
  const globals = {window:dom.window, document:dom.window.document, navigator:dom.window.navigator, React, IS_REACT_ACT_ENVIRONMENT:true};
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, {configurable:true, writable:true, value});
  let personaCalls=0, storyCalls=0, exportCalls=0;
  const api = {sessionId:'opening',worldId:'world',worldName:'Academy',personaSelectable:true,variables:{},entries:[],messages:[{id:'g',role:'assistant',content:'*Opening.*',model:null}],hasEarlierMessages:false,readOnly:false,isStreaming:false,
    storage:{get:async()=>null,set:async()=>{}},renderMarkdown:(text:string)=>text,resolveAssetUrl:(ref:string)=>ref,
    openPersonaManager:()=>{personaCalls++;},openSessionExport:()=>{exportCalls++;},sendMessage:()=>{storyCalls++;}, ...overrides};
  const compiled = bundleAndCompile({files,entryFile:'index.tsx'},()=>api);assert.equal(compiled.error,null);
  const {createRoot}=await import('react-dom/client');const container=dom.window.document.getElementById('root')!,root=createRoot(container);
  await act(async()=>root.render(createElement(compiled.Component!)));
  const menu=container.querySelector<HTMLButtonElement>('[aria-label="Menu"]')!;await act(async()=>menu.click());
  return {container,api,getPersonaCalls:()=>personaCalls,getExportCalls:()=>exportCalls,getStoryCalls:()=>storyCalls,openMenu:async()=>{await act(async()=>menu.click());},dispose:async()=>{await act(async()=>root.unmount());dom.window.close();for(const[key,value]of descriptors){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}}};
}

test('greeting menu puts Persona and working Export below Memory and Settings', async()=>{
  const f=await fixture();
  try {
    const memory=f.container.querySelector('.vn-menu-memory')!,persona=f.container.querySelector('.vn-menu-persona')!;
    assert.deepEqual([...memory.parentElement!.querySelectorAll('button')].map(b=>b.textContent),['Memory','Settings']);
    assert.deepEqual([...persona.parentElement!.querySelectorAll('button')].map(b=>b.textContent),['Persona','Export']);
    assert.equal(memory.parentElement!.nextElementSibling,persona.parentElement);
    const exportButton=f.container.querySelector<HTMLElement>('.vn-menu-export')!;
    assert.equal(exportButton.style.gridColumn,'2');
    assert.equal(exportButton.style.justifySelf,'');
    await act(async()=>f.container.querySelector<HTMLButtonElement>('.vn-menu-export')!.click());
    assert.equal(f.getStoryCalls(),0);assert.equal(f.getPersonaCalls(),0);assert.equal(f.getExportCalls(),1);assert.equal(f.container.querySelector('[aria-label="Story menu"]'),null);
    await f.openMenu();
    await act(async()=>f.container.querySelector<HTMLButtonElement>('.vn-menu-persona')!.click());assert.equal(f.getPersonaCalls(),1);
  }finally{await f.dispose();}
});

test('Persona is absent after departure, continuation, or an authoritative lock',async()=>{
  const cases=[
    {personaSelectable:false},
    {messages:[{id:'g',role:'assistant',content:'Greeting'},{id:'u',role:'user',content:'Act'}]},
    {messages:[{id:'g',role:'assistant',content:'Continued greeting',model:'model'}]},
    {messages:[{id:'g',role:'assistant',content:'Continued greeting',swipes:[{model:'model'}]}]},
    {hasEarlierMessages:true}, {isStreaming:true}, {readOnly:true},
  ];
  for(const overrides of cases){const f=await fixture(overrides);try{
    assert.equal(f.container.querySelector('.vn-menu-persona'),null,JSON.stringify(overrides));
    const exportButton=f.container.querySelector<HTMLElement>('.vn-menu-export')!;
    assert.equal(exportButton.style.gridColumn,'1 / -1');
    assert.equal(exportButton.style.justifySelf,'center');
    assert.equal(exportButton.style.width,'fit-content');
  }finally{await f.dispose();}}
});
