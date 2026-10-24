import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import React,{act,createElement} from 'react';
import test from 'node:test';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {bundleAndCompile} from '../studio/lib/tsx-bundler';

test('VN log turn details describe only the viewed accepted reply and committed values', async t=>{
 const source=new URL('../../../../../interfaces/vn/',import.meta.url).pathname;
 const files=Object.fromEntries(readdirSync(source).filter(n=>/\.(tsx?|jsx?)$/.test(n)).map(n=>[n,readFileSync(source+n,'utf8')]));
 files['index.tsx']=files['index.tsx'].replace('export default function VN()', 'function VN()')+'\nexport default function Probe(){const api=useYumina();return <DialogueLog api={api} currentTurnId={api.messages.at(-1)?.id} onClose={()=>{}} onCharacter={()=>{}}/>}';
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
 for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,React,IS_REACT_ACT_ENVIRONMENT:true}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 const reactWarnings: string[]=[];t.mock.method(console,'error',(...args: unknown[])=>reactWarnings.push(args.map(String).join(' ')));
 const audit=(changes: unknown[]=[])=>({version:1,attemptId:'audit',outcome:'valid-updates',committed:true,changes,variableNames:{'reina-trust':'Reina trust','story-day':'Story day'}});
 type FixtureMessage={id:string;role:string;status:string;content:string;swipes?:Record<string,unknown>[];activeSwipeIndex?:number;stateValidation?:unknown};
 const assistant=(extra: Record<string,unknown>={}):FixtureMessage=>({id:'reply',role:'assistant',status:'complete',content:'[SCENE:courtyard] *A quiet morning.*\n[SCENE:classroom][SPEAKER:Mei:normal] "The lesson starts."',...extra});
 let api={messages:[assistant()],entries:[],variables:{'story-day':99,'reina-trust':1000},user:{name:'Player'},renderMarkdown:(s:string)=>s,resolveAssetUrl:()=>'',hasEarlierMessages:false,isLoadingEarlier:false};
 const compiled=bundleAndCompile({files,entryFile:'index.tsx'},()=>api);assert.equal(compiled.error,null,compiled.error??undefined);assert.ok(compiled.Component);
 const root=createRoot(document.getElementById('root')!);
 const render=async(message: Record<string,unknown>)=>{api={...api,messages:[message as ReturnType<typeof assistant>]};await act(async()=>root.render(createElement(compiled.Component!)))};
 const details=()=>{const el=document.querySelector<HTMLDetailsElement>('.vn-turn-details');assert.ok(el,'Turn details must be available in the dialogue log');return el};
 const text=()=>details().textContent||'';
 try{
  await t.test('native disclosure starts collapsed and uses explicit parsed scene markers',async()=>{
   await render(assistant({stateValidation:audit()}));assert.equal(details().open,false);assert.equal(details().firstElementChild?.tagName,'SUMMARY');assert.match(details().querySelector('summary')?.textContent||'',/Turn details/);assert.match(text(),/courtyard → classroom/);
   await act(async()=>details().querySelector('summary')!.click());assert.equal(details().open,true);
  });
  await t.test('legacy records and prose location mentions do not invent state or scene changes',async()=>{
   await render(assistant({id:'legacy',content:'*Mei enters the classroom after yesterday.*'}));assert.match(text(),/Not recorded/);assert.doesNotMatch(text(),/Scene: classroom|99|1000|Reina trust/);
  });
  await t.test('uncommitted and failed attempts never present proposed values as applied',async()=>{
   await render(assistant({id:'failed',stateValidation:{...audit([{variableId:'reina-trust',oldValue:50,newValue:53,source:'ai'}]),committed:false}}));assert.match(text(),/Not applied/);assert.doesNotMatch(text(),/Reina trust|53/);
  });
  await t.test('captured labels and zero or false before/after values survive display',async()=>{
   await render(assistant({id:'committed',stateValidation:audit([{variableId:'reina-trust',oldValue:0,newValue:false,source:'ai'},{variableId:'story-day',oldValue:1,newValue:2,source:'rule'}])}));assert.match(text(),/Reina trust/);assert.match(text(),/Story day/);assert.deepEqual([...details().querySelectorAll('pre')].map(el=>el.textContent),['0','false','1','2']);assert.doesNotMatch(text(),/1000|99/);
  });
  await t.test('an explicit empty change list differs from missing legacy changes',async()=>{
   await render(assistant({id:'none',stateValidation:{...audit(),outcome:'explicit-none'}}));assert.match(text(),/No tracked value changes/);
   const missing={...audit()};delete (missing as {changes?:unknown[]}).changes;await render(assistant({id:'missing',stateValidation:missing}));assert.match(text(),/Not recorded/);assert.doesNotMatch(text(),/No tracked value changes/);
  });
  await t.test('shortened saved or local previews remain clearly identified and escaped',async()=>{
   await render(assistant({id:'preview',stateValidation:{...audit([{variableId:'note',oldValue:'<img onerror=bad>',newValue:'x'.repeat(1500),source:'ai',truncated:true}]),changesTruncated:true}}));assert.match(text(),/preview shortened/i);assert.match(text(),/Some changes are omitted/);assert.equal(details().querySelector('img'),null);assert.ok(details().querySelectorAll('pre')[1].textContent!.length<1500);
  });
  await t.test('active alternatives own their metadata and the native disclosure resets on switch',async()=>{
   const first=assistant({id:'alternatives',activeSwipeIndex:0,stateValidation:audit([{variableId:'reina-trust',oldValue:0,newValue:1,source:'ai'}]),swipes:[{stateValidation:audit([{variableId:'reina-trust',oldValue:0,newValue:1,source:'ai'}])},{stateValidation:audit([{variableId:'story-day',oldValue:1,newValue:2,source:'rule'}])}]});
   await render(first);await act(async()=>details().querySelector('summary')!.click());assert.equal(details().open,true);
   await render({...first,activeSwipeIndex:1});assert.equal(details().open,false);assert.match(text(),/Story day/);assert.doesNotMatch(text(),/Reina trust/);
   await render({...first,activeSwipeIndex:1,swipes:[first.swipes![0],{}]});assert.match(text(),/Not recorded/);assert.doesNotMatch(text(),/Reina trust/);
  });
  await t.test('saved JSON reload preserves the committed values and remains a collapsed disclosure',async()=>{
   const saved=JSON.parse(JSON.stringify(assistant({id:'persisted',stateValidation:audit([{variableId:'story-day',oldValue:1,newValue:2,source:'rule'}])})));await render(saved);assert.equal(details().open,false);assert.deepEqual([...details().querySelectorAll('pre')].map(el=>el.textContent),['1','2']);
  });
  await t.test('turn details and thinking keep distinct sibling identities',()=>{assert.deepEqual(reactWarnings.filter(message=>/same key|unique.*key/i.test(message)),[])});
 }finally{await act(async()=>root.unmount());dom.window.close()}
});
