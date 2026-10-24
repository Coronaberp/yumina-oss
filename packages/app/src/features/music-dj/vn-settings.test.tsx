import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {upgradeVnMusicSettings} from './vn-settings';
import {bundleAndCompile} from '../studio/lib/tsx-bundler';

test('runtime-only stock VN listener mode selector renders and changes host preference, never saved source',async()=>{
 const folder=fileURLToPath(new URL('../../../../../interfaces/vn/',import.meta.url));
 const original=Object.fromEntries(readdirSync(folder).filter(n=>/\.(tsx?|jsx?)$/.test(n)).map(n=>[n,readFileSync(folder+n,'utf8')]));
 const before=JSON.stringify(original); const files=upgradeVnMusicSettings(original);
 assert.notEqual(files,original);assert.equal(JSON.stringify(original),before);assert.equal(upgradeVnMusicSettings(files),files);
 assert.equal(upgradeVnMusicSettings({'custom.tsx':'<div>custom</div>'})['custom.tsx'],'<div>custom</div>');
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
 const globals={window:dom.window,document:dom.window.document,navigator:dom.window.navigator,React,IS_REACT_ACT_ENVIRONMENT:true};
 const saved=Object.keys(globals).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)] as const);
 for(const [k,v] of Object.entries(globals))Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});
 const {createRoot}=await import('react-dom/client');const root=createRoot(dom.window.document.getElementById('root')!);
 let choice='creator';const commands:string[]=[];
 const api={sessionId:'s',worldId:'w',worldName:'World',entries:[],variables:{},readOnly:false,isStreaming:false,messages:[{id:'1',role:'assistant',content:'Quiet.'}],pendingChoices:[],storage:{get:async()=>null,set:async()=>{}},renderMarkdown:(v:string)=>v,resolveAssetUrl:(v:string)=>v,getAudioVolume:()=>.5,musicAudioMode:'creator',musicDjStatus:'YouTube unavailable',setMusicAudioMode:(v:string)=>{choice=v;},musicDjCommand:(v:string)=>commands.push(v)};
 const compiled=bundleAndCompile({files,entryFile:'index.tsx'},()=>api);assert.equal(compiled.error,null);
 try{
 await act(async()=>root.render(React.createElement(compiled.Component!)));
 for(const name of ['Menu','Settings']){const b=[...dom.window.document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===name||x.textContent?.trim()===name)!;assert.ok(b,name);await act(async()=>b.click());}
 const select=dom.window.document.querySelector<HTMLSelectElement>('select[aria-label="Audio source"]')!;
 assert.ok(select);assert.equal(select.options.length,3);
 await act(async()=>{select.value='personal';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});assert.equal(choice,'personal');
 assert.ok(dom.window.document.body.textContent?.includes('YouTube unavailable'));
 }finally{await act(async()=>root.unmount());dom.window.close();for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else Reflect.deleteProperty(globalThis,k);}}
});
