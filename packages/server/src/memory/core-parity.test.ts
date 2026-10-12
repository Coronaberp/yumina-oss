import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { estimateTokens, buildBlock } from './block.js';
import { isActive, retention, score, passesFilters, rank, rankClusters, scoreCluster } from './ranking.js';
import { chunkLoreContent } from './retrieval.js';
import * as prompts from './prompts.js';
import * as extraction from './extraction.js';
import { DEFAULT_MEMORY_CONFIG } from './config.js';
const golden = JSON.parse(readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8'));
function close(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }
test('generated fixture source hashes agree with pinned source manifest', () => {
 const manifest = JSON.parse(readFileSync(new URL('./source-manifest.json', import.meta.url), 'utf8'));
 assert.equal(golden.commit, manifest.commit);
 for (const [path, hash] of Object.entries(golden.sourceHashes)) assert.equal(hash, manifest.files[path]);
 assert.equal(DEFAULT_MEMORY_CONFIG.RESERVED_FRACTION, 0.6);
});
for (const c of golden.tokens) test(`Python codepoint token length ${JSON.stringify(c.text)}`, () => assert.equal(estimateTokens(c.text), c.expected));
for (const c of golden.ranking) test(`ranking ${c.fact.id}`, () => {
 const present = new Set<string>(c.present);
 assert.equal(isActive(c.fact,c.location), c.expected.active);
 close(retention(c.fact,c.turn,c.location),c.expected.retention);
 close(score(c.fact,c.turn,c.location,present),c.expected.score);
 assert.equal(passesFilters(c.fact,present,c.turn,c.location),c.expected.passes);
});
for (const [i,c] of golden.rank.entries()) test(`stable ranking/filter ${i}`, () => assert.deepEqual(rank(c.candidates,c.present,c.turn,c.location).map(f => f.id),c.expected));
for (const [i,c] of golden.blocks.entries()) test(`Python block packing ${i}`, () => {
 const out = buildBlock(c.pinned,c.active,c.ranked,c.budget,c.clusters);
 assert.deepEqual([out.block,out.usedIds,out.droppedIds],c.expected);
});
for (const [i,c] of golden.chunks.entries()) test(`Python lore chunking ${i}`, () => assert.deepEqual(chunkLoreContent(c.content),c.expected));
const builders: Record<string, (...args: any[]) => string> = {extract:prompts.buildExtractPrompt,reconcile:prompts.buildReconcilePrompt,lore_update:prompts.buildLoreUpdatePrompt,secret_reveal:prompts.buildSecretRevealPrompt,cluster:prompts.buildClusterPrompt,cluster_assign:prompts.buildClusterAssignPrompt};
for (const [i,c] of golden.prompts.entries()) test(`exact prompt bytes ${c.kind} ${i}`, () => assert.equal(builders[c.kind]!(...c.args),c.expected));
for (const [i,c] of golden.parsers.entries()) test(`Pydantic parser ${c.kind} ${i}`, () => {
 const fn = c.kind === 'extract' ? () => extraction.parseExtractResponse(c.raw) : () => ({reconcile:extraction.parseReconcile,lore_updates:extraction.parseLoreUpdates,secret_reveals:extraction.parseSecretReveals} as Record<string,Function>)[c.kind]!(c.raw,c.factCount,new Set(c.validIds));
 if (c.error) assert.throws(fn, (error: any) => error.message === c.error);
 else assert.deepEqual(fn(),c.expected);
});
for (const [i,c] of golden.clusters.entries()) test(`cluster scoring ${i}`, () => {
 assert.deepEqual(rankClusters(c.clusters as Array<{id:string;created_turn:number;distance?:number}>,c.turn).map(c=>c.id),c.expected);
 c.clusters.forEach((v:any,j:number)=>close(scoreCluster(v,c.turn),c.scores[j]));
});
const draft = {text:'Mira returned.',fact_type:'event' as const,participants:[],importance:3,valence:0};
test('invalid extraction gets exactly one corrected retry preserving source array wording', async () => {
 const actualPrompts:string[]=[];
 const model={async complete(prompt:string){actualPrompts.push(prompt);return actualPrompts.length===1?'[]':'{}';}};
 assert.deepEqual(await extraction.runExtract('t','Mira','Alice','en',model),[[],{doing:'',location:'',npcs:[]}]);
 assert.equal(actualPrompts.length,2);
 assert.equal(actualPrompts[1],actualPrompts[0]+'\n\nYour previous reply was invalid: expected a JSON object with facts and char_state\nReply again with only the corrected JSON array.');
});
test('failed reconciliation falls back to add-all after two parse attempts',async()=>{
 const calls:string[]=[];const model={async complete(p:string){calls.push(p);return '[]';}};
 assert.deepEqual(await extraction.runReconcile([draft],[[{id:'a',text:'previous'}]],model),[{index:0,action:'add',target_id:null}]);assert.equal(calls.length,2);
});
test('transport failure does not cause a retry and extraction returns empty state',async()=>{
 let calls=0;const model={async complete(){calls++;throw new Error('transport');}};
 assert.deepEqual(await extraction.runExtract('t','M','U','en',model),[[],{doing:'',location:'',npcs:[]}]);assert.equal(calls,1);
});
test('empty drafts/neighbors skip lore and secret calls and invalid replies fall back empty',async()=>{
 let calls=0;const model={async complete(){calls++;return '{}';}};
 assert.deepEqual(await extraction.runReconcile([],[],model),[]);
 assert.deepEqual(await extraction.runLoreUpdateDetection([draft],[[]],model),[]);
 assert.deepEqual(await extraction.runSecretRevealDetection([],[[{id:'s',text:'secret'}]],model),[]);assert.equal(calls,0);
 assert.deepEqual(await extraction.runLoreUpdateDetection([draft],[[{id:'l',text:'lore'}]],model),[]);
 assert.deepEqual(await extraction.runSecretRevealDetection([draft],[[{id:'s',text:'secret'}]],model),[]);assert.equal(calls,4);
});
import * as retrieval from './retrieval.js';
for (const [i,c] of golden.transcripts.entries()) test(`source OOC transcript helpers ${i}`,()=>{
 assert.deepEqual(c.messages.map((m:any)=>retrieval.isOocTranscriptMessage(m)),c.ooc);
 assert.equal(retrieval.currentTurn(c.messages),c.turn);
 assert.deepEqual(retrieval.userTurnOrdinals(c.messages),c.ordinals);
 assert.equal(retrieval.recentText(c.messages),c.recent);
 const pairs=retrieval.exchanges(c.messages,c.group);
 assert.deepEqual(pairs.map(([u,a])=>[c.messages.indexOf(u),c.messages.indexOf(a)]),c.pairIndexes);
 assert.equal(retrieval.transcript(pairs,'Default','Player',{m:'Mira',r:'Ryōshū'},{u:'Alice'}),c.transcript);
});
for(const [i,c] of golden.keywordMatches.entries())test(`Python Unicode keyword boundaries ${i}`,()=>assert.equal(retrieval.keyInText(c.key,c.text.toLowerCase()),c.expected));
test('noniterable facts cause source TypeError fallback without a validated retry',async()=>{
 let calls=0;const model={async complete(){calls++;return '{"facts":1}';}};
 assert.deepEqual(await extraction.runExtract('t','M','U','en',model),[[],{doing:'',location:'',npcs:[]}]);assert.equal(calls,1);
});
test('memory and lore keep separately ranked input order at packing overflow',()=>{
 const memory={id:'memory',text:'Earlier promise.',fact_type:'event' as const,participants:[],importance:3,valence:0,reinforcements:0,last_turn:0,valid_until_turn:null,distance:0.9};
 const lore={...memory,id:'lore',source:'lore',text:'World fact.',distance:0};
 assert.deepEqual(buildBlock([],[],[...rank([memory],[],0),...rank([lore],[],0)],8).usedIds,['memory']);
});
for(const [i,c] of golden.runs.entries())test(`source-generated validated retry/fallback ${c.kind} ${i}`,async()=>{
 const calls:string[]=[];const model={async complete(prompt:string){calls.push(prompt);const response=c.responses[calls.length-1];if(response==='TRANSPORT_ERROR')throw new Error('transport');return response;}};
 const drafts=golden.prompts.find((p:any)=>p.kind==='reconcile').args[0];
 const neighbors=golden.prompts.find((p:any)=>p.kind==='reconcile').args[1];
 const out=c.kind==='extract'?await extraction.runExtract('Transcript 😀','Mira','Alice','English',model):await ({reconcile:extraction.runReconcile,lore_update_detection:extraction.runLoreUpdateDetection,secret_reveal_detection:extraction.runSecretRevealDetection} as Record<string,Function>)[c.kind]!(drafts,neighbors,model);
 assert.deepEqual(out,c.expected);assert.deepEqual(calls,c.prompts);
});
