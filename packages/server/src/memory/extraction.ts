import { FACT_TYPES, type FactDraft, type CharStateDraft, type ReconcileDecision, type LoreUpdateDecision, type SecretRevealDecision, type MemoryModel } from './types.js';
import { parsePythonJson, pythonJsonRepr, PythonFloat } from './python-json.js';
import { MAX_FACTS_PER_BATCH, type MemoryAlgorithmConfig } from './config.js';
import { pythonRepr, pythonString, pythonTruthy } from './block.js';
import { buildExtractPrompt, buildReconcilePrompt, buildLoreUpdatePrompt, buildSecretRevealPrompt, type PromptNeighbor } from './prompts.js';
export const EXTRACTION_PARAMS={chat_template_kwargs:{thinking:false,enable_thinking:false}} as const;
export function stripJsonFence(raw:string):string { return raw.trim().replace(/^```(?:json)?\s*|\s*```$/gi,'').trim(); }
interface ValidationIssue {location:string;message:string;type:string;input:unknown}
const missing=Symbol('missing');
function inputType(v:unknown):string {if(v instanceof PythonFloat)return 'float';if(v===null)return 'NoneType';if(typeof v==='string')return 'str';if(typeof v==='boolean')return 'bool';if(typeof v==='number')return Number.isInteger(v)?'int':'float';if(Array.isArray(v))return 'list';return 'dict';}
function formatInput(v:unknown):string {const repr=pythonJsonRepr(v);return Array.from(repr).length>50?Array.from(repr).slice(0,25).join('')+'...'+Array.from(repr).slice(-24).join(''):repr;}
/** Pydantic v2 rendering matters because validation errors become part of the retry prompt. */
export class ModelValidation {
 readonly issues:ValidationIssue[]=[];
 constructor(readonly model:string,readonly data:unknown){}
 issue(location:string,message:string,type:string,input:unknown):void {this.issues.push({location,message,type,input});}
 object():Record<string,unknown> {if(this.data===null||typeof this.data!=='object'||Array.isArray(this.data)||this.data instanceof PythonFloat){this.issue('','Input should be a valid dictionary or instance of '+this.model,'model_type',this.data);this.finish();return {};}return this.data as Record<string,unknown>;}
 field(data:Record<string,unknown>,key:string,defaultValue:unknown=missing):unknown {if(Object.hasOwn(data,key))return data[key];if(defaultValue!==missing)return defaultValue;this.issue(key,'Field required','missing',this.data);return missing;}
 string(v:unknown,loc:string,min=0):string {if(v===missing)return '';if(typeof v!=='string'){this.issue(loc,'Input should be a valid string','string_type',v);return '';}if(Array.from(v).length<min)this.issue(loc,`String should have at least ${min} character${min===1?'':'s'}`,'string_too_short',v);return v;}
 integer(v:unknown,loc:string,min?:number,max?:number):number {if(v===missing)return 0;let value:number;
  if(typeof v==='boolean')value=Number(v);
  else if(typeof v==='number'||v instanceof PythonFloat){value=v instanceof PythonFloat?v.value:v;if(!Number.isFinite(value)){this.issue(loc,'Input should be a finite number','finite_number',v);return 0;}if(!Number.isInteger(value)){this.issue(loc,'Input should be a valid integer, got a number with a fractional part','int_from_float',v);return 0;}}
  else if(typeof v==='string'){if(!/^[+-]?[0-9](?:_?[0-9])*(?:\.0+)?$/.test(v.trim())){this.issue(loc,'Input should be a valid integer, unable to parse string as an integer','int_parsing',v);return 0;}value=Number(v.trim().replaceAll('_',''));}
  else {this.issue(loc,'Input should be a valid integer','int_type',v);return 0;}
  if(max!==undefined&&value>max)this.issue(loc,`Input should be less than or equal to ${max}`,'less_than_equal',v);
  else if(min!==undefined&&value<min)this.issue(loc,`Input should be greater than or equal to ${min}`,'greater_than_equal',v);
  return value;
 }
 list(v:unknown,loc:string,item:(v:unknown,loc:string)=>unknown,min=0):unknown[] {if(v===missing)return [];if(!Array.isArray(v)){this.issue(loc,'Input should be a valid list','list_type',v);return [];}const out=v.map((value,i)=>item(value,loc+'.'+i));if(out.length<min)this.issue(loc,`List should have at least ${min} item${min===1?'':'s'} after validation, not ${out.length}`,'too_short',v);return out;}
 literal(v:unknown,loc:string,choices:readonly string[]):string {if(v===missing)return '';if(!choices.includes(v as string)){const expected=choices.length===2?choices.map(pythonRepr).join(' or '):choices.slice(0,-1).map(pythonRepr).join(', ')+' or '+pythonRepr(choices.at(-1));this.issue(loc,'Input should be '+expected,'literal_error',v);}return String(v);}
 finish():void {if(!this.issues.length)return;const count=this.issues.length;throw new Error(`${count} validation error${count===1?'':'s'} for ${this.model}\n`+this.issues.map(e=>(e.location?e.location+'\n':'')+`  ${e.message} [type=${e.type}, input_value=${formatInput(e.input)}, input_type=${inputType(e.input)}]\n    For further information visit https://errors.pydantic.dev/2.12/v/${e.type}`).join('\n'));}
}
export function validateFactDraft(data:unknown):FactDraft {
 const v=new ModelValidation('FactDraft',data),d=v.object();
 const out={text:v.string(v.field(d,'text'),'text',1),fact_type:v.literal(v.field(d,'fact_type'),'fact_type',FACT_TYPES) as FactDraft['fact_type'],participants:v.list(v.field(d,'participants'),'participants',(x,l)=>v.string(x,l)) as string[],importance:v.integer(v.field(d,'importance'),'importance',1,5),valence:v.integer(v.field(d,'valence'),'valence',-2,2)};
 v.finish();return out;
}
export function validateCharStateDraft(data:unknown):CharStateDraft {
 const v=new ModelValidation('CharStateDraft',data),d=v.object();
 const out={doing:v.string(v.field(d,'doing',''),'doing'),location:v.string(v.field(d,'location',''),'location'),npcs:v.list(v.field(d,'npcs',[]),'npcs',(x,l)=>v.string(x,l)) as string[]};v.finish();return out;
}
export function validateReconcileDecision(data:unknown):ReconcileDecision {
 const v=new ModelValidation('ReconcileDecision',data),d=v.object();
 const target=v.field(d,'target_id',null);
 const out={index:v.integer(v.field(d,'index'),'index',0),action:v.literal(v.field(d,'action'),'action',['add','reinforce','supersede']) as ReconcileDecision['action'],target_id:target===null?null:v.string(target,'target_id')};
 if(!v.issues.length&&out.action!=='add'&&!out.target_id)v.issue('',`Value error, action ${out.action} requires target_id`,'value_error',data);
 v.finish();return out;
}
export function validateLoreUpdateDecision(data:unknown):LoreUpdateDecision {
 const v=new ModelValidation('LoreUpdateDecision',data),d=v.object();
 const out={index:v.integer(v.field(d,'index'),'index',0),lore_id:v.string(v.field(d,'lore_id'),'lore_id'),new_content:v.string(v.field(d,'new_content'),'new_content',1)};v.finish();return out;
}
export function validateSecretRevealDecision(data:unknown):SecretRevealDecision {
 const v=new ModelValidation('SecretRevealDecision',data),d=v.object();
 const out={index:v.integer(v.field(d,'index'),'index',0),secret_id:v.string(v.field(d,'secret_id'),'secret_id')};v.finish();return out;
}
export function loadJson(raw:string):unknown {return parsePythonJson(stripJsonFence(raw));}
function truthy(value:unknown):boolean {return value instanceof PythonFloat?value.value!==0:pythonTruthy(value);}
function loadArray(raw:string):unknown[] {let data:unknown;try{data=loadJson(raw);}catch(e){throw new Error(`not valid JSON: ${(e as Error).message}`);}if(!Array.isArray(data))throw new Error('expected a JSON array');return data;}
export type ExtractionConfig=Pick<MemoryAlgorithmConfig,'maxFactsPerBatch'>;
export function parseExtractResponse(raw:string,options:ExtractionConfig={}):[FactDraft[],CharStateDraft] {
 const data=loadJson(raw);
 if(data===null||typeof data!=='object'||Array.isArray(data)||data instanceof PythonFloat)throw new Error('expected a JSON object with facts and char_state');
 const d=data as Record<string,unknown>;
 const rawFacts=truthy(d.facts)?d.facts:[];
 let items:unknown[];
 if(Array.isArray(rawFacts))items=rawFacts;
 else if(typeof rawFacts==='string')items=Array.from(rawFacts);
 else if(rawFacts&&typeof rawFacts==='object'&&!(rawFacts instanceof PythonFloat))items=Object.keys(rawFacts);
 else throw new TypeError(`'${inputType(rawFacts)}' object is not iterable`);
 const facts=items.map(validateFactDraft);
 const state=validateCharStateDraft(truthy(d.char_state)?d.char_state:{});
 return [facts.slice(0,options.maxFactsPerBatch??MAX_FACTS_PER_BATCH),state];
}
export function parseReconcile(raw:string,factCount:number,validIds:Set<string>):ReconcileDecision[] {
 const decisions=loadArray(raw).map(validateReconcileDecision),seen=new Set(decisions.map(d=>d.index));
 if(seen.size!==factCount||Array.from({length:factCount},(_,i)=>i).some(i=>!seen.has(i)))throw new Error(`expected one decision per fact 0..${factCount-1}, got indexes ${pythonString([...seen].sort((a,b)=>a-b))}`);
 if(decisions.length!==factCount)throw new Error(`expected exactly ${factCount} decisions, got ${decisions.length} with duplicate indexes`);
 for(const d of decisions)if(d.action!=='add'&&!validIds.has(d.target_id as string))throw new Error(`unknown target_id ${d.target_id}`);
 return decisions.sort((a,b)=>a.index-b.index);
}
export function parseLoreUpdates(raw:string,factCount:number,validIds:Set<string>):LoreUpdateDecision[] {
 const decisions=loadArray(raw).map(validateLoreUpdateDecision);
 for(const d of decisions){if(d.index>=factCount)throw new Error(`index ${d.index} out of range for ${factCount} facts`);if(!validIds.has(d.lore_id))throw new Error(`unknown lore_id ${d.lore_id}`);}return decisions;
}
export function parseSecretReveals(raw:string,factCount:number,validIds:Set<string>):SecretRevealDecision[] {
 const decisions=loadArray(raw).map(validateSecretRevealDecision);
 for(const d of decisions){if(d.index>=factCount)throw new Error(`index ${d.index} out of range for ${factCount} facts`);if(!validIds.has(d.secret_id))throw new Error(`unknown secret_id ${d.secret_id}`);}return decisions;
}
async function callValidated<T>(prompt:string,parse:(raw:string)=>T,model:MemoryModel,signal?:AbortSignal):Promise<T> {
 const raw=await model.complete(prompt,{signal});
 try{return parse(raw);}catch(firstError){if(firstError instanceof TypeError)throw firstError;const retry=`${prompt}\n\nYour previous reply was invalid: ${(firstError as Error).message}\nReply again with only the corrected JSON array.`;return parse(await model.complete(retry,{signal}));}
}
export async function runExtract(transcript:string,charName:string,userName:string,language:string,model:MemoryModel,castNames?:string[]|null,signal?:AbortSignal,options:ExtractionConfig={}):Promise<[FactDraft[],CharStateDraft]> {
 try{return await callValidated(buildExtractPrompt(transcript,charName,userName,language,castNames),raw=>parseExtractResponse(raw,options),model,signal);}catch{return [[],{doing:'',location:'',npcs:[]}];}
}
export async function runReconcile(drafts:FactDraft[],neighbors:PromptNeighbor[][],model:MemoryModel,signal?:AbortSignal):Promise<ReconcileDecision[]> {
 if(!drafts.length)return [];const valid=new Set(neighbors.flat().map(n=>n.id));
 try{return await callValidated(buildReconcilePrompt(drafts,neighbors),raw=>parseReconcile(raw,drafts.length,valid),model,signal);}catch{return drafts.map((_,index)=>({index,action:'add',target_id:null}));}
}
export async function runLoreUpdateDetection(drafts:FactDraft[],neighbors:PromptNeighbor[][],model:MemoryModel,signal?:AbortSignal):Promise<LoreUpdateDecision[]> {
 if(!drafts.length||!neighbors.some(n=>n.length))return [];const valid=new Set(neighbors.flat().map(n=>n.id));
 try{return await callValidated(buildLoreUpdatePrompt(drafts,neighbors),raw=>parseLoreUpdates(raw,drafts.length,valid),model,signal);}catch{return [];}
}
export async function runSecretRevealDetection(drafts:FactDraft[],neighbors:PromptNeighbor[][],model:MemoryModel,signal?:AbortSignal):Promise<SecretRevealDecision[]> {
 if(!drafts.length||!neighbors.some(n=>n.length))return [];const valid=new Set(neighbors.flat().map(n=>n.id));
 try{return await callValidated(buildSecretRevealPrompt(drafts,neighbors),raw=>parseSecretReveals(raw,drafts.length,valid),model,signal);}catch{return [];}
}
