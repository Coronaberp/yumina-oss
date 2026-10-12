import assert from 'node:assert/strict';
import test from 'node:test';
import {buildBlock,renderCluster} from './block.js';
import {parseExtractResponse,runExtract} from './extraction.js';
import {createLoreService} from './lore.js';
test('per-call extraction limit applies after validating every source draft and survives retry',async()=>{
 const facts=Array.from({length:12},(_,i)=>({text:`Fact ${i}`,fact_type:'event',participants:[],importance:3,valence:0}));
 const raw=JSON.stringify({facts,char_state:{}});
 assert.equal(parseExtractResponse(raw)[0].length,10);
 assert.equal(parseExtractResponse(raw,{maxFactsPerBatch:2})[0].length,2);
 let calls=0;const result=await runExtract('transcript','Mira','Player','English',{complete:async()=>++calls===1?'invalid':raw},null,undefined,{maxFactsPerBatch:3});
 assert.equal(calls,2);assert.equal(result[0].length,3);
 assert.throws(()=>parseExtractResponse(JSON.stringify({facts:[...facts,{text:'invalid',fact_type:'bad'}],char_state:{}}),{maxFactsPerBatch:1}));
});
test('per-call cluster allocation and reserved fraction preserve source overflow rules',()=>{
 const cluster={id:'c',summary_text:'word '.repeat(80),created_turn:1};
 assert.ok(renderCluster(cluster,{clusterBudgetTokens:10}).length<renderCluster(cluster).length);
 const fact={id:'p',text:'Pinned',fact_type:'event' as const,participants:[],importance:3,valence:0,reinforcements:0,last_turn:1,valid_until_turn:null};
 assert.equal(buildBlock([fact],[],[],20,[],{reservedFraction:0}).usedIds.length,0);
 assert.deepEqual(buildBlock([fact],[],[],20,[],{reservedFraction:1}).usedIds,['p']);
 assert.deepEqual(buildBlock([],[],[fact],20,[cluster],{clusterBudgetTokens:10}).usedIds,['p']);
});
test('per-call lore candidate and neighbor limits reach searches independently',async()=>{
 const seen:number[]=[];
 const repositories:any={lore:{getAllOverridesForSession:async()=>({}),linksFor:async()=>[],byIds:async()=>[],revealedIds:async()=>new Set(),secretsByIds:async()=>[]},vectors:{searchLoreChunks:async(_v:number[],k:number)=>{seen.push(k);return [];},searchLoreIds:async(_v:number[],k:number)=>{seen.push(k);return [];},searchSecretIds:async(_v:number[],k:number)=>{seen.push(k);return [];}}};
 const service=createLoreService({repositories,embedding:{embed:async()=>[1],embedQuery:async()=>[1]},model:{complete:async()=>'[]'},charId:'char',loreCandidateK:9,loreNeighborK:7});
 await service.fetchCandidates([],[1],{},1,false);
 const drafts=[{text:'event',fact_type:'event' as const,participants:[],importance:3,valence:0}];
 await service.prepareLoreUpdates(drafts);await service.prepareSecretReveals(drafts);
 assert.deepEqual(seen,[9,7,7]);
});
