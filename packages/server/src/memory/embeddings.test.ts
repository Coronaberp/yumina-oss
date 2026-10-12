import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingClient, normalizeEmbeddingBase, validateEmbeddingVector } from './embeddings.js';
const profile = {baseUrl:'http://local.test',model:' Qwen3-Embedding-0.6B ',dimensions:1024,sendDimensions:false};
const instruction='Given the current roleplay moment, retrieve character facts, relationships, unresolved commitments, and world details needed to stay consistent.';
function response(n:number) { return new Response(JSON.stringify({data:[{embedding:Array(n).fill(0.123456789)}]})); }
test('normalizes source API roots without assuming a configured host', () => {
 for(const [a,b] of [[' http://x/ ','http://x/v1'],['http://x/v1/embeddings///','http://x/v1'],['http://x/api/v1/','http://x/api/v1']]) assert.equal(normalizeEmbeddingBase(a!),b);
 assert.throws(()=>normalizeEmbeddingBase(''), /configuration/i);
});
test('sends exact default raw and query body and allows unauthenticated endpoints', async()=>{
 const calls:{url:string,init:RequestInit}[]=[];
 const client=createEmbeddingClient(profile,'',{fetch:async(url,init)=>{calls.push({url:String(url),init:init!});return response(1024)}});
 assert.equal((await client.embed('raw'))[0],Math.fround(0.123456789)); await client.embedQuery('scene');
 assert.equal(calls[0]!.url,'http://local.test/v1/embeddings');
 assert.equal(calls[0]!.init.body,JSON.stringify({model:'Qwen3-Embedding-0.6B',input:'raw'}));
 assert.equal(new Headers(calls[0]!.init.headers).has('authorization'),false);
 assert.equal(calls[1]!.init.body,JSON.stringify({model:'Qwen3-Embedding-0.6B',input:`Instruct: ${instruction}\nQuery: scene`}));
});
test('captures separate user profile and key snapshots across concurrent requests and rotation',async()=>{
 const seen:{url:string,body:any,key:string|null}[]=[];
 const fetcher:typeof fetch=async(url,init)=>{ const body=JSON.parse(String(init?.body));seen.push({url:String(url),body,key:new Headers(init?.headers).get('authorization')});await Promise.resolve();return response(body.dimensions ?? 1536); };
 const a={...profile,dimensions:1536,sendDimensions:true};
 const one=createEmbeddingClient(a,'first',{fetch:fetcher});a.model='changed';a.baseUrl='http://changed';a.dimensions=1;
 const two=createEmbeddingClient({...profile,baseUrl:'http://second/api/v1',model:'second',dimensions:3072,sendDimensions:true},'rotated',{fetch:fetcher});
 assert.equal((await Promise.all([one.embed('one'),two.embed('two')]))[1]!.length,3072);
 assert.deepEqual(seen.map(x=>[x.url,x.body.model,x.body.dimensions,x.key]),[['http://local.test/v1/embeddings','Qwen3-Embedding-0.6B',1536,'Bearer first'],['http://second/api/v1/embeddings','second',3072,'Bearer rotated']]);
});
test('rejects invalid configuration and cosine vectors including float32 overflow/underflow',()=>{
 for(const dimensions of [0,16001,1.5,NaN]) assert.throws(()=>createEmbeddingClient({...profile,dimensions},''));
 for(const v of [[],[0,0],[NaN,1],[Infinity,1],[Number.MAX_VALUE,1],[1e-100,0],[1]]) assert.throws(()=>validateEmbeddingVector(v,2));
 assert.deepEqual(validateEmbeddingVector([1,0],2),[1,0]);
});
test('sanitizes HTTP, parsing, network and invalid response failures',async()=>{
 for(const fetcher of [async()=>new Response('secret-key http://user:pass@host',{status:401}),async()=>new Response('secret-key'),async()=>new Response('{"data":[]}'),async()=>{throw new Error('secret-key http://user:pass@host')}]) {
  const c=createEmbeddingClient(profile,'secret-key',{fetch:fetcher});
  await assert.rejects(c.embed('x'),e=>e instanceof Error && !/secret-key|user:pass|host/.test(e.message));
 }
});
test('uses the 60-second timeout and cancels without depending on provider cooperation',async()=>{
 let timerMs=0;
 const stalled:typeof fetch=()=>new Promise(()=>{});
 const c=createEmbeddingClient(profile,'',{fetch:stalled,setTimeout:(fn,ms)=>{timerMs=ms;return setTimeout(fn,1)},clearTimeout});
 await assert.rejects(c.embed('x'), /timed out/i);assert.equal(timerMs,60000);
 const controller=new AbortController();const d=createEmbeddingClient(profile,'',{fetch:stalled});
 const pending=d.embed('x',controller.signal);controller.abort(new Error('secret'));
 await assert.rejects(pending,/cancelled/i);
 await assert.rejects(d.embed('x',controller.signal),/cancelled/i);
});
test('uses optional model/dimension defaults and verifies actual HTTP vector shape',async()=>{
 let body:any;
 const client=createEmbeddingClient({baseUrl:'http://default'},'',{fetch:async(_,init)=>{body=JSON.parse(String(init?.body));return response(1024)}});
 await client.embed('x');assert.deepEqual(body,{model:'Qwen3-Embedding-0.6B',input:'x'});
 for(const embedding of [[1],Array(1024).fill(0),Array(1024).fill(1e100),null]) {
  const invalid=createEmbeddingClient(profile,'',{fetch:async()=>new Response(JSON.stringify({data:[{embedding}]}))});
  await assert.rejects(invalid.embed('x'),/invalid_vector/);
 }
 assert.equal(validateEmbeddingVector(Array(16000).fill(1),16000).length,16000);
 assert.deepEqual(validateEmbeddingVector([1],1),[1]);
 for(const baseUrl of ['http://user:secret@x','ftp://x','http://x?key=secret']) assert.throws(()=>createEmbeddingClient({...profile,baseUrl},''), /configuration/);
});
