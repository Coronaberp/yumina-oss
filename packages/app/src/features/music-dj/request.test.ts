import test from 'node:test';
import assert from 'node:assert/strict';
import {requestMusicDecision} from './request';
const preferences={consent:true,source:'session' as const,model:'chosen-provider-model',preferences:'Quiet',maxBgmSeconds:600};
const catalog=[{id:'calm',name:'Calm',type:'bgm' as const}];
test('one authenticated request sends complete reply only to existing model endpoint and validates tool result',async()=>{
 const old=globalThis.fetch;let count=0;const reply='Full '.repeat(300)+'ending';
 globalThis.fetch=async(input,init)=>{count++;assert.equal(input,'/api/sessions/s%2Fa/completions');assert.equal(init?.credentials,'include');const body=JSON.parse(init!.body as string);assert.equal(body.musicDj.reply,reply);assert.equal(body.model,'chosen-provider-model');assert.equal(body.musicDj.optIn,true);return new Response('event: done\ndata: {"musicDecision":{"bgm":{"action":"keep"}}}\n\n');};
 try{assert.deepEqual(await requestMusicDecision('s/a',reply,catalog,preferences,'story-model',null,new AbortController().signal),{bgm:{action:'keep'}});assert.equal(count,1);}finally{globalThis.fetch=old;}
});
test('absent opt-in/source makes no request; missing key/quota/error/malformed decision fail without retry',async()=>{
 const old=globalThis.fetch;let count=0;
 try{
 globalThis.fetch=async()=>{count++;return new Response('{"error":"No API key"}',{status:400});};
 await assert.rejects(()=>requestMusicDecision('s','reply',catalog,{...preferences,consent:false},'m',null,new AbortController().signal));
 await assert.rejects(()=>requestMusicDecision('s','reply',catalog,{...preferences,source:'youtube'},'m',null,new AbortController().signal));assert.equal(count,0);
 for(const status of [400,429]){globalThis.fetch=async()=>{count++;return new Response('{}',{status});};await assert.rejects(()=>requestMusicDecision('s','reply',catalog,preferences,'m',null,new AbortController().signal));}
 globalThis.fetch=async()=>{count++;return new Response('event: error\ndata: {"error":"quota"}\n\n');};await assert.rejects(()=>requestMusicDecision('s','reply',catalog,preferences,'m',null,new AbortController().signal));
 globalThis.fetch=async()=>{count++;return new Response('event: done\ndata: {"musicDecision":{"bgm":{"action":"play","trackId":"unknown"}}}\n\n');};await assert.rejects(()=>requestMusicDecision('s','reply',catalog,preferences,'m',null,new AbortController().signal));
 assert.equal(count,4);
 }finally{globalThis.fetch=old;}
});
test('saved-link mode requires player consent and sends catalog decisions only to the existing model endpoint',async()=>{
 const old=globalThis.fetch;let count=0;
 globalThis.fetch=async(url,init)=>{count++;assert.equal(url,'/api/sessions/s/completions');const body=JSON.parse(init!.body as string);assert.equal(body.musicDj.catalog[0].id,'calm');assert.equal(body.musicDj.catalog[0].videoId,undefined);return new Response('event: done\ndata: {"musicDecision":{"bgm":{"action":"keep"}}}\n\n');};
 try{
 await assert.rejects(()=>requestMusicDecision('s','Full reply',catalog,{...preferences,source:'youtube',youtubeConsent:false},'m',null,new AbortController().signal));assert.equal(count,0);
 await requestMusicDecision('s','Full reply',catalog,{...preferences,source:'youtube',youtubeConsent:true},'m',null,new AbortController().signal);assert.equal(count,1);
 }finally{globalThis.fetch=old;}
});
