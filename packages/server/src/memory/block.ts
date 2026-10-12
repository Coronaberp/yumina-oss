import * as config from './config.js';
import type { CoreFact, CoreCluster } from './ranking.js';
export function estimateTokens(text:string):number { return Math.floor(Array.from(text).length/4)+1; }
/** Python truthiness/str preserve original metadata rendering, including empty collections. */
export function pythonTruthy(value:unknown):boolean {
 if(value===null||value===undefined||value===false||value===0||value==='')return false;
 if(Array.isArray(value))return value.length>0;
 if(typeof value==='object')return Object.keys(value).length>0;
 return true;
}
export function pythonRepr(value:unknown):string {
 if(typeof value==='string') {
  const quote=value.includes("'")&&!value.includes('"')?'"':"'";
  return quote+value.replaceAll('\\','\\\\').replaceAll(quote,'\\'+quote).replaceAll('\n','\\n').replaceAll('\r','\\r').replaceAll('\t','\\t')+quote;
 }
 return pythonString(value);
}
export function pythonString(value:unknown):string {
 if(value===null||value===undefined)return 'None';
 if(typeof value==='boolean')return value?'True':'False';
 if(Array.isArray(value))return '['+value.map(pythonRepr).join(', ')+']';
 if(typeof value==='object')return '{'+Object.entries(value).map(([k,v])=>pythonRepr(k)+': '+pythonRepr(v)).join(', ')+'}';
 return String(value);
}
export function renderFact(fact:CoreFact):string {
 if(fact.source==='lore') {
  const suffix=fact.link_label?` (linked: ${fact.link_label})`:'';
  const segments=Object.entries(fact.metadata??{}).filter(([,v])=>pythonTruthy(v)).map(([k,v])=>{
   const label=k.replaceAll('_',' ').trim();
   const capitalized=label?Array.from(label)[0]!.toUpperCase()+Array.from(label).slice(1).join('').toLowerCase():'';
   return `${capitalized}: ${Array.isArray(v)?v.map(pythonString).join(', '):pythonString(v)}`;
  });
  segments.push(...(fact.links??[]).map(l=>{const link=l as {label:string;name:string};return `${link.label}: ${link.name}`;}));
  const detail=segments.join(' | ');
  return `- ${fact.text}${suffix}${detail?'\n  '+detail:''}`;
 }
 if(fact.fact_type==='state'&&fact.valid_until_turn===null)return `- ${fact.text} (ongoing)`;
 if(fact.valid_until_turn!==null)return `- ${fact.text} (this later changed)`;
 return `- ${fact.text}`;
}
export type BlockConfig=Pick<config.MemoryAlgorithmConfig,'clusterBudgetTokens'|'reservedFraction'>;
export function renderCluster(cluster:CoreCluster,options:BlockConfig={}):string {
 const clusterBudget=options.clusterBudgetTokens??config.CLUSTER_BUDGET_TOKENS;
 let summary=cluster.summary_text;
 while(estimateTokens(summary)>clusterBudget) {
  summary=Array.from(summary).slice(0,Math.max(0,(clusterBudget-2)*4)).join('');
  const lastSpace=summary.lastIndexOf(' ');
  summary=(lastSpace<0?summary:summary.slice(0,lastSpace))+'...';
 }
 return `${cluster.title?'## '+cluster.title:'## Story so far'}\n${summary}`;
}
export function buildBlock(pinned:CoreFact[],active:CoreFact[],ranked:CoreFact[],budget:number,clusters:CoreCluster[]=[],options:BlockConfig={}):{block:string;usedIds:string[];droppedIds:string[]} {
 const clusterSection=clusters.map(cluster=>renderCluster(cluster,options)).join('\n\n');
 const effective=budget-(options.clusterBudgetTokens??config.CLUSTER_BUDGET_TOKENS)*clusters.length;
 const reservedBudget=Math.trunc(effective*(options.reservedFraction??config.RESERVED_FRACTION));
 const ordered=[...pinned].sort((a,b)=>b.importance-a.importance).concat([...active].sort((a,b)=>b.importance-a.importance||b.last_turn-a.last_turn));
 const reserved:CoreFact[]=[],scored:CoreFact[]=[],usedIds:string[]=[],droppedIds:string[]=[];
 let spent=0;
 for(const fact of ordered) {
  const cost=estimateTokens(renderFact(fact));
  if(spent+cost>reservedBudget){droppedIds.push(fact.id);continue;}
  reserved.push(fact);usedIds.push(fact.id);spent+=cost;
 }
 for(const fact of ranked) {
  if(usedIds.includes(fact.id))continue;
  const cost=estimateTokens(renderFact(fact));
  if(spent+cost>effective)break;
  scored.push(fact);usedIds.push(fact.id);spent+=cost;
 }
 const lore=[...reserved,...scored].filter(f=>f.source==='lore').map(renderFact);
 const pinnedLines=reserved.filter(f=>f.source!=='lore').map(renderFact);
 const recalled=scored.filter(f=>f.source!=='lore').map(renderFact);
 const parts:string[]=[];
 if(clusterSection)parts.push(clusterSection);
 if(lore.length)parts.push('## Established world facts\n'+lore.join('\n'));
 if(pinnedLines.length)parts.push('## Ongoing & pinned\n'+pinnedLines.join('\n'));
 if(recalled.length)parts.push('## Recalled from earlier\n'+recalled.join('\n'));
 return {block:parts.join('\n\n'),usedIds:parts.length?usedIds:[],droppedIds};
}

/** Request composition uses the target model's counter, including all headings.
 * The source-compatible builder above remains unchanged for standalone recall. */
export function buildPromptBlock(pinned:CoreFact[],active:CoreFact[],ranked:CoreFact[],budget:number,count:(text:string)=>number,clusters:CoreCluster[]=[],options:BlockConfig={}) {
 const all=[...pinned,...active,...ranked];
 if(budget<=0)return {block:'',usedIds:[],droppedIds:all.map(f=>f.id)};
 const reserved:CoreFact[]=[],scored:CoreFact[]=[],summaries:string[]=[];
 function render() {
  const lore=[...reserved,...scored].filter(f=>f.source==='lore').map(renderFact);
  const ongoing=reserved.filter(f=>f.source!=='lore').map(renderFact);
  const recall=scored.filter(f=>f.source!=='lore').map(renderFact);
  return [...summaries,
   ...(lore.length?['## Established world facts\n'+lore.join('\n')]:[]),
   ...(ongoing.length?['## Ongoing & pinned\n'+ongoing.join('\n')]:[]),
   ...(recall.length?['## Recalled from earlier\n'+recall.join('\n')]:[]),
  ].join('\n\n');
 }
 const identityIds=new Set(all.filter(f=>f.character_identity).map(f=>f.id.split('#')[0]!));
 const used=new Set<string>();
 // Identity must get its chance against the whole remaining budget before
 // summaries, related lore, or a fractional reservation can consume it.
 for(const fact of all.filter(f=>f.character_identity).sort((a,b)=>Number(b.query_matched)-Number(a.query_matched))) {
  if(used.has(fact.id))continue;
  reserved.push(fact);if(count(render())>budget)reserved.pop();else used.add(fact.id);
 }
 const allowed=(fact:CoreFact)=>!identityIds.has(fact.id.split('#')[0]!)||used.has(`${fact.id.split('#')[0]}#identity`);
 for(const cluster of clusters){summaries.push(renderCluster(cluster,options));if(count(render())>budget)summaries.pop();}
 const ordered=[...pinned].sort((a,b)=>Number(b.query_matched??false)-Number(a.query_matched??false)||b.importance-a.importance).concat([...active].sort((a,b)=>b.importance-a.importance||b.last_turn-a.last_turn));
 const deferred:CoreFact[]=[];
 const reservedCeiling=count(render())+Math.floor((budget-count(render()))*(options.reservedFraction??config.RESERVED_FRACTION));
 for(const fact of ordered){if(fact.character_identity||!allowed(fact))continue;reserved.push(fact);if(count(render())>reservedCeiling){reserved.pop();deferred.push(fact);}}
 for(const fact of reserved)used.add(fact.id);
 // Oversized candidates do not prevent smaller relevant facts from fitting.
 for(const fact of [...deferred,...ranked]){
  if(used.has(fact.id)||fact.character_identity||!allowed(fact))continue;
  scored.push(fact);
  if(count(render())>budget)scored.pop();else used.add(fact.id);
 }
 return {block:render(),usedIds:[...used],droppedIds:all.filter(f=>!used.has(f.id)).map(f=>f.id)};
}
