import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import React,{act,createElement} from 'react';
import test from 'node:test';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {bundleAndCompile} from '../studio/lib/tsx-bundler';
test('VN log renders a bounded window and loads older turns without reparsing unchanged dialogue', async()=>{
const source=new URL('../../../../../interfaces/vn/',import.meta.url).pathname;
const files=Object.fromEntries(readdirSync(source).filter(n=>/\.(tsx?|jsx?)$/.test(n)).map(n=>[n,readFileSync(source+n,'utf8')]));
files['index.tsx']=files['index.tsx'].replace('export default function VN()', 'function VN()');
files['index.tsx']+='\nexport default function Probe(){ const api=useYumina(); return <DialogueLog api={api} currentTurnId={api.currentTurnId||api.messages.at(-1)?.id} onClose={()=>{}} onCharacter={api.onCharacter}/> }';
files['passages.ts']=files['passages.ts'].replace('export function messagePassages(api, message) {','export function messagePassages(api, message) { globalThis.__vnParsed=(globalThis.__vnParsed||0)+1;');
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,React,IS_REACT_ACT_ENVIRONMENT:true,__vnParsed:0}))Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
const globals = globalThis as typeof globalThis & { __vnParsed: number };
const makeTurn=(i: number)=>[{id:`u${i}`,role:'user',content:`Choice ${i}`},{id:`m${i}`,role:'assistant',content:`*Narration ${i}.*\n[SPEAKER:Sera:normal] "Sera speaks in turn ${i}."\n*Future passage ${i}.*`,activeSwipeIndex:0,swipes:[{rawContent:'',reasoningContent:`Thinking ${i}`}]}];
let markdown=0,remoteCalls=0;
let finishRemote: (value: boolean) => void = () => { throw new Error("No remote request pending"); };
type ViewerContext = { messageId: string; lines: Array<{ text: string }> };
const clicked: Array<[unknown, ViewerContext]>=[];
let portraitsReady = false;
let api={messages:Array.from({length:100},(_,i)=>makeTurn(i)).flat(),entries:[{id:'sera',name:'Sera',role:'character',portrait:'@asset:11111111-2222-4333-8444-555555555555'}],user:{name:'QA'},renderMarkdown:(s: string)=>{markdown++;return s},resolveAssetUrl:(_s: string)=>portraitsReady ? '/ready.webp' : '/pending.gif',hasEarlierMessages:true,isLoadingEarlier:false,onCharacter:(...args: [unknown, ViewerContext])=>clicked.push(args),loadEarlierMessages:()=>{remoteCalls++;return new Promise<boolean>(resolve=>{finishRemote=resolve})}};
const compiled=bundleAndCompile({files,entryFile:'index.tsx'},()=>api);assert.equal(compiled.error,null,compiled.error??undefined);
const container = document.getElementById('root'); assert.ok(container);
const Component = compiled.Component; assert.ok(Component);
const root=createRoot(container);
const query = <T extends HTMLElement = HTMLElement>(selector: string): T => { const node = document.querySelector<T>(selector); assert.ok(node, selector); return node; };
const render=async()=>{await act(async()=>root.render(createElement(Component)))};
const click=async (selector: string)=>{const node=query(selector);await act(async()=>node.click())};
const mounted=()=>[...document.querySelectorAll<HTMLElement>('[data-turn-id]')].map(n=>n.dataset.turnId);
const selectTurn=async (id: string)=>{await click('[aria-label="Filter by turn"]');await click(`[role="option"][data-value="${id}"]`)};
try{
 await render();assert.deepEqual(mounted(),['m95','m96','m97','m98','m99']);assert.equal(globals.__vnParsed,5);assert.equal(remoteCalls,0);
 let parsed=globals.__vnParsed,md=markdown;await render();assert.equal(globals.__vnParsed,parsed);assert.equal(markdown,md);
 portraitsReady=true;api={...api};await render();assert.equal(query<HTMLImageElement>('.vn-log-row img.vn-avatar').getAttribute('src'),'/ready.webp','loaded portraits replace transparent placeholders without reopening the log');
 await click('.vn-load-earlier');assert.deepEqual(mounted(),Array.from({length:10},(_,i)=>`m${i+90}`));assert.equal(remoteCalls,0);assert.equal(globals.__vnParsed,10);
 await click('.vn-load-earlier');assert.deepEqual(mounted(),Array.from({length:10},(_,i)=>`m${i+85}`));assert.equal(remoteCalls,0);assert.equal(globals.__vnParsed,15);
 await click('.vn-load-newer');assert.deepEqual(mounted(),Array.from({length:10},(_,i)=>`m${i+90}`));assert.equal(globals.__vnParsed,15,'returning turns use cached passages');
 parsed=globals.__vnParsed;await selectTurn('m5');assert.deepEqual(mounted(),['m5']);assert.equal(globals.__vnParsed,parsed+1,'distant turn parses only itself');assert.match(query('.vn-log-scroll').textContent || '',/Choice 5/);assert.doesNotMatch(query('.vn-log-scroll').textContent || '',/Choice 4|Choice 6/);
 const sera=[...document.querySelectorAll<HTMLElement>('.vn-log-chip')].find(n=>n.textContent?.trim()==='Sera');assert.ok(sera);await act(async()=>sera.click());assert.match(query('.vn-log-scroll').textContent || '',/speaks in turn 5/);assert.doesNotMatch(query('.vn-log-scroll').textContent || '',/Choice 5|Narration 5|Thinking 5/);
 await click('.vn-log .vn-character-link');assert.equal(clicked.length,1);assert.equal(clicked[0][1].messageId,'m5');assert.equal(clicked[0][1].lines.length,2);assert.ok(!clicked[0][1].lines.some(l=>l.text.includes('Future passage')));
 await click('.vn-log-reset');assert.deepEqual(mounted(),['m95','m96','m97','m98','m99']);
 // Programmatic scroll cannot eagerly fetch pages.
 const scroller=query('.vn-log-scroll');await act(async()=>scroller.dispatchEvent(new dom.window.Event('scroll',{bubbles:true})));assert.equal(remoteCalls,0);
 // Exhaust local history with bounded batches.
 for(let i=0;i<20&&mounted()[0]!=='m0';i++)await click('.vn-load-earlier');assert.equal(mounted()[0],'m0');assert.ok(mounted().length<=10);assert.equal(remoteCalls,0);
 await click('.vn-load-earlier');assert.equal(remoteCalls,1);await click('.vn-load-earlier');assert.equal(remoteCalls,1,'one remote request in flight');
 await act(async()=>{api.messages=[...Array.from({length:10},(_,i)=>makeTurn(i-10)).flat(),...api.messages];finishRemote(true);root.render(createElement(Component))});assert.equal(mounted()[0],'m-5');assert.ok(mounted().length<=10);assert.equal(query<HTMLButtonElement>('.vn-load-earlier').disabled,false);
 // Failed remote load is a visible manual retry and does not loop.
 while(mounted()[0]!=='m-10')await click('.vn-load-earlier');await click('.vn-load-earlier');await act(async()=>finishRemote(false));assert.match(query('[role="alert"]').textContent || '',/Could not load/);assert.equal(query<HTMLButtonElement>('.vn-load-earlier').disabled,false);
 console.log(JSON.stringify({passed:true,initialFiveTurns:true,unchangedRenderNoParsingOrMarkdown:true,boundedMountedTurns:10,cachedReturn:true,directTurnOnly:true,playerChoiceAssociation:true,speakerFilters:true,originalViewerContext:true,programmaticScrollNoFetch:true,remoteAfterLocalOnly:true,oneRemoteInFlight:true,remotePrepend:true,remoteFailureRetry:true}));
}finally{await act(async()=>root.unmount());dom.window.close()}

});
