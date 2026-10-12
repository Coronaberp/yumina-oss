import assert from 'node:assert/strict';
import test from 'node:test';
import { describeStudioTrace, recoverStudioTrace } from '../dist/index.js';
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('trace records actual read/search/image/write outcomes and only bounded public details',()=>{
 const secret='do-not-copy-secret';
 const read=describeStudioTrace(call('read','read_entities',{ids:['scenes.ts','variable-updates'],apiKey:secret}),{status:'success',result:{hugeText:secret}});
 assert.equal(read.status,'done');assert.equal(read.kind,'read');assert.match(read.detail,/scenes.ts/);assert.ok(!JSON.stringify(read).includes(secret));
 const search=describeStudioTrace(call('search','grep_world',{query:'[SCENE:',scope:'entries'}),{status:'success'});
 assert.equal(search.kind,'search');assert.ok(search.detail.includes('[SCENE:'));assert.ok(search.detail.includes('entries'));
 const image=describeStudioTrace(call('image','view_image',{assetRef:'@asset:owned'}),{status:'success',result:{ref:'@asset:owned',name:'lecture-hall-day.webp',imageUrl:'data:image/png;base64,secret'}});
 assert.equal(image.title,'Opened image');assert.equal(image.detail,'lecture-hall-day.webp');assert.equal(image.assetRef,'@asset:owned');assert.ok(!JSON.stringify(image).includes('base64'));
 const requested=describeStudioTrace(call('write','write',{name:'Missing background',content:secret}));
 assert.equal(requested.status,'working');assert.ok(!JSON.stringify(requested).includes(secret));
 const failed=describeStudioTrace(call('write','write',{name:'Missing background'}),{status:'error',error:secret});
 assert.equal(failed.status,'failed');assert.ok(!JSON.stringify(failed).includes(secret));
 const queued=describeStudioTrace(call('gen','generate_image',{purpose:'Evening hall',prompt:secret}),{status:'success',result:{status:'queued',jobId:'job'}});
 assert.equal(queued.title,'Queued image');assert.ok(!JSON.stringify(queued).includes(secret));
 const long=describeStudioTrace(call('long','grep_world',{query:'x'.repeat(5000)}));assert.ok(long.detail.length<=240);
 const partial=describeStudioTrace(call('multi','delete_entities',{ids:['one','two','three']}),{status:'success',result:{status:'partial',completed:1,total:3}});
 assert.equal(partial.status,'working');assert.equal(partial.detail,'1 of 3 changes saved');
 const mixed=describeStudioTrace(call('multi','delete_entities',{ids:['one','two','three']}),{status:'error',result:{status:'partial_failure',completed:1,failed:2}});
 assert.equal(mixed.status,'failed');assert.equal(mixed.detail,'1 changes saved, 2 failed');
});

test('recovery pairs real tool outputs and does not infer execution from a request',()=>{
 const read=call('read','read_entities',{ids:['scenes.ts']}),image=call('image','view_image',{assetRef:'@asset:owned'}),write=call('write','write',{name:'Background rule'});
 const messages=[{role:'assistant',tool_calls:[read,image,write]},
  {role:'tool',tool_call_id:'read',content:JSON.stringify({file:'scenes.ts'})},
  {role:'tool',tool_call_id:'image',content:JSON.stringify({ref:'@asset:owned',name:'lecture.webp'})},
  {role:'tool',tool_call_id:'write',content:JSON.stringify({status:'error',error:'Failed to save'})}];
 const trace=recoverStudioTrace(messages);assert.equal(trace.length,3);assert.equal(trace[0].status,'done');assert.equal(trace[1].detail,'lecture.webp');assert.equal(trace[2].status,'failed');
 const pending=recoverStudioTrace([{role:'assistant',tool_calls:[write]}]);assert.equal(pending.length,0);
 assert.equal(recoverStudioTrace([...messages,...messages]).length,3);
 const request={role:'user',content:'Current background task'};
 assert.deepEqual(recoverStudioTrace([...messages,request],request),[], 'A new task does not claim earlier tool activity');
 assert.equal(recoverStudioTrace([...messages,request,...messages],request).length,3);
 assert.deepEqual(recoverStudioTrace(messages,request),[], 'Missing request anchor cannot import unrelated history');
 const skipped=recoverStudioTrace([{role:'assistant',tool_calls:[write]},{role:'tool',tool_call_id:'write',content:JSON.stringify('Skipped because this step asked the creator a question.')}]);
 assert.equal(skipped[0].title,'Not executed');assert.notEqual(skipped[0].status,'done');
});
