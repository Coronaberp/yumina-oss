import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicDjController } from './controller';
import type { MusicDecision } from '../../../../shared/src/music-dj';
const catalog=[{id:'calm',name:'Calm',type:'bgm' as const},{id:'combat',name:'Combat',type:'bgm' as const},{id:'cue',name:'Cue',type:'sfx' as const,startSeconds:0,endSeconds:2}];
function fixture() {
 let now=100000; const calls:string[]=[];
 const pending:Array<{resolve:(v:MusicDecision)=>void,reject:(e:Error)=>void,signal:AbortSignal,reply:string}>=[];
 const port={stop:()=>calls.push('stop'),playBgm:(id:string)=>calls.push('bgm:'+id),playSfx:(id:string)=>calls.push('sfx:'+id),stopSfx:()=>calls.push('stop-sfx'),pause:()=>calls.push('pause'),resume:()=>calls.push('resume')};
 const dj=new MusicDjController(port,(reply,signal)=>new Promise((resolve,reject)=>pending.push({resolve,reject,signal,reply})),()=>now);
 dj.reset('session',catalog);calls.length=0;
 return {dj,pending,calls,advance:(ms:number)=>{now+=ms;}};
}
const reply=(id:string,content=id)=>({id,content});
test('full reply once, keep does not restart or stop, one cue at a time',async()=>{
 const f=fixture();const complete='First. '+ 'story '.repeat(8000)+'The complete ending.';
 const run=f.dj.observe(reply('1',complete));assert.equal(f.pending[0].reply,complete);
 f.pending[0].resolve({bgm:{action:'play',trackId:'calm'},sfx:{trackId:'cue',startSeconds:0,endSeconds:2}});await run;
 await f.dj.observe(reply('1',complete));assert.equal(f.pending.length,1);
 const next=f.dj.observe(reply('2'));f.pending[1].resolve({bgm:{action:'keep'},sfx:{trackId:'cue',startSeconds:0,endSeconds:2}});await next;
 assert.deepEqual(f.calls,['bgm:calm','sfx:cue']);
});
test('stale/cancelled/error results and manual pause/skip/lock cannot change playback',async()=>{
 const f=fixture();const a=f.dj.observe(reply('1'));const b=f.dj.observe(reply('2'));
 assert.equal(f.pending[0].signal.aborted,true);f.pending[0].resolve({bgm:{action:'play',trackId:'calm'}});await a;assert.deepEqual(f.calls,[]);
 f.dj.pause();f.pending[1].resolve({bgm:{action:'play',trackId:'combat'}});await b;assert.deepEqual(f.calls,['stop-sfx','pause']);
 f.dj.resume();f.dj.setLocked(true);await f.dj.observe(reply('3'));assert.equal(f.pending.length,2);
 f.dj.setLocked(false);const c=f.dj.observe(reply('4'));f.pending[2].reject(new Error('quota'));await c;assert.equal(f.dj.status,'Music decision unavailable; story continues.');
 const d=f.dj.observe(reply('5'));f.dj.reset('new-session',catalog);f.pending[3].resolve({bgm:{action:'play',trackId:'combat'}});await d;
 assert.equal((f.calls as string[]).includes('bgm:combat'),false);
});
test('30 second dwell, major-scene override with 5 second floor, skip blocks same track',async()=>{
 const f=fixture();const decide=async(id:string,trackId:string,majorSceneChange=false)=>{const p=f.dj.observe(reply(id));f.pending.at(-1)!.resolve({bgm:{action:'play',trackId,majorSceneChange}});await p;};
 await decide('1','calm');f.advance(4000);await decide('2','combat',true);assert.deepEqual(f.calls,['bgm:calm']);
 f.advance(1000);await decide('3','combat',true);assert.deepEqual(f.calls,['bgm:calm','bgm:combat']);
 f.advance(6000);await decide('4','calm');assert.equal(f.calls.at(-1),'bgm:combat');
 f.advance(24000);await decide('5','calm');assert.equal(f.calls.at(-1),'bgm:calm');
 f.dj.skip();await decide('6','calm',true);assert.equal(f.calls.at(-1),'stop');
 f.advance(6000);await decide('7','combat',true);assert.equal(f.calls.at(-1),'bgm:combat');
});
