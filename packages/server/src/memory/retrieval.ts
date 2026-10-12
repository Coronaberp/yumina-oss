import { estimateTokens } from './block.js';
export const LORE_CHUNK_THRESHOLD_TOKENS=450;
export const LORE_RECURSION_MAX_DEPTH=2;
export const LORE_RECURSION_MAX_ADDED=20;
export function splitIntoSentences(text:string):string[] { return text.trim().split(/(?<=[.!?])\s+/u).filter(Boolean); }
export function splitOversizedSentence(sentence:string,limit:number):string[] {
 const words=sentence.split(' ');
 if(words.length<=1){const chars=Array.from(sentence),chunks:string[]=[];for(let i=0;i<chars.length;i+=limit*4)chunks.push(chars.slice(i,i+limit*4).join(''));return chunks.length?chunks:[sentence];}
 const pieces:string[]=[];let current:string[]=[],tokens=0;
 for(const word of words){const cost=estimateTokens(word);if(current.length&&tokens+cost>limit){pieces.push(current.join(' '));current=[];tokens=0;}current.push(word);tokens+=cost;}
 if(current.length)pieces.push(current.join(' '));return pieces;
}
export function packSentences(sentences:string[],limit:number):string[] {
 const packed:string[]=[];let current:string[]=[],tokens=0;
 for(const sentence of sentences){const cost=estimateTokens(sentence);if(cost>limit){if(current.length){packed.push(current.join(' '));current=[];tokens=0;}packed.push(...splitOversizedSentence(sentence,limit));continue;}if(current.length&&tokens+cost>limit){packed.push(current.join(' '));current=[];tokens=0;}current.push(sentence);tokens+=cost;}
 if(current.length)packed.push(current.join(' '));return packed;
}
export function chunkLoreContent(content:string):string[] {
 if(estimateTokens(content)<=LORE_CHUNK_THRESHOLD_TOKENS)return [content];
 const paragraphs=content.split('\n\n').filter(p=>p.trim()),chunks:string[]=[];let current:string[]=[],tokens=0;
 for(const paragraph of paragraphs){const cost=estimateTokens(paragraph);if(cost>LORE_CHUNK_THRESHOLD_TOKENS){if(current.length){chunks.push(current.join('\n\n'));current=[];tokens=0;}chunks.push(...packSentences(splitIntoSentences(paragraph),LORE_CHUNK_THRESHOLD_TOKENS));continue;}if(current.length&&tokens+cost>LORE_CHUNK_THRESHOLD_TOKENS){chunks.push(current.join('\n\n'));current=[];tokens=0;}current.push(paragraph);tokens+=cost;}
 if(current.length)chunks.push(current.join('\n\n'));return chunks;
}
/** Python Unicode \b uses alphanumeric codepoints and underscore, unlike JavaScript \b. */
export function keyInText(key:string,textLower:string):boolean {
 const lower=key.toLowerCase();if(!lower)return /[\p{L}\p{N}_]/u.test(textLower);if(/[一-鿿぀-ヿ가-힯]/u.test(lower))return textLower.includes(lower);
 const escaped=lower.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 // Python \b requires a transition on each side, including punctuation keys.
 for(const match of textLower.matchAll(new RegExp(escaped,'gu'))){const start=match.index,end=start+match[0].length;const before=Array.from(textLower.slice(0,start)).at(-1)??'',first=Array.from(lower)[0]??'',last=Array.from(lower).at(-1)??'',after=Array.from(textLower.slice(end))[0]??'';const word=(s:string)=>/[\p{L}\p{N}_]/u.test(s);if(word(before)!==word(first)&&word(last)!==word(after))return true;}
 return false;
}
export interface KeywordLoreEntry {id:string;content:string;keys:string[];require_keys:string[];exclude_keys:string[];always:boolean;[key:string]:unknown}
export function entryMatches(entry:KeywordLoreEntry,textLower:string):boolean {
 return entry.keys.some(k=>keyInText(k,textLower))&&(!entry.require_keys.length||entry.require_keys.every(k=>keyInText(k,textLower)))&&(!entry.exclude_keys.length||!entry.exclude_keys.some(k=>keyInText(k,textLower)));
}
/** Pure keyword stage of retrieval.py; DB authorization remains an injected caller concern. */
export function retrieveKeywordLore<T extends KeywordLoreEntry>(entries:T[],query:string,recent:string):Array<T&{query_matched:boolean}> {
 const rt=(recent||'').toLowerCase(),qt=(query||'').toLowerCase(),matched=new Map<string,T>(),queryIds=new Set<string>();
 for(const e of entries){if(e.always)matched.set(e.id,e);else if(entryMatches(e,qt)){matched.set(e.id,e);queryIds.add(e.id);}}
 for(const e of entries)if(!matched.has(e.id)&&entryMatches(e,rt))matched.set(e.id,e);
 let scan=rt,addedCount=0;
 for(let depth=0;depth<LORE_RECURSION_MAX_DEPTH;depth++){const combined=scan+' '+Array.from(matched.values()).filter(m=>!m.always).map(m=>m.content.toLowerCase()).join(' ');let added=false;for(const e of entries){if(addedCount>=LORE_RECURSION_MAX_ADDED)break;if(matched.has(e.id))continue;if(entryMatches(e,combined)){matched.set(e.id,e);addedCount++;added=true;}}if(!added||addedCount>=LORE_RECURSION_MAX_ADDED)break;scan=combined;}
 return [...Array.from(queryIds).map(id=>({...matched.get(id)!,query_matched:true})),...Array.from(matched).filter(([id])=>!queryIds.has(id)).map(([,e])=>({...e,query_matched:false}))];
}
import type { TranscriptMessage } from './types.js';
export const DIRECTOR_SIGIL='╾━╤デ╦︻';
export function stripThink(text:string|null|undefined):string {return (text||'').replace(/<think>.*?<\/think>\s*/gs,'').trim();}
export function recentText(messages:TranscriptMessage[],n=4):string {const convo=messages.filter(m=>m.role==='user'||m.role==='assistant');return convo.slice(n===0?0:-n).map(m=>m.content).join('\n');}
export function isOocTranscriptMessage(message:TranscriptMessage):boolean {
 if(message.role==='user')return /^\s*\(\s*╾━╤デ╦︻\s*:\s*\[ooc\]\s*/i.test(message.content||'');
 if(message.role==='assistant')return stripThink(message.content).trimStart().toUpperCase().startsWith('(OOC:');return false;
}
export function exchanges(messages:TranscriptMessage[],group=false):Array<[TranscriptMessage,TranscriptMessage]> {
 const pairs:Array<[TranscriptMessage,TranscriptMessage]>=[];let pending:TranscriptMessage|null=null;
 for(const message of messages){if(isOocTranscriptMessage(message))continue;if(message.role==='user')pending=message;else if(message.role==='assistant'&&pending){pairs.push([pending,message]);if(!group)pending=null;}}
 return pairs;
}
export function currentTurn(messages:TranscriptMessage[]):number {return messages.filter(m=>m.role==='user').length;}
export function userTurnOrdinals(messages:TranscriptMessage[]):Record<string,number> {
 const out:Record<string,number>={};let count=0;for(const m of messages)if(m.role==='user'){count++;out[m.id as string]=count;}return out;
}
export function presentParticipants(charName:string,userNames:string[],knownNames:string[],recent:string):string[] {
 const lower=(recent||'').toLowerCase(),present=[...userNames,charName];for(const n of knownNames)if(n&&lower.includes(n.toLowerCase())&&!present.includes(n))present.push(n);return present;
}
export function transcript(batch:Array<[TranscriptMessage,TranscriptMessage]>,charName:string,userName:string,namesById:Record<string,string>={},userNamesBySenderId:Record<string,string>={}):string {
 const lines:string[]=[];let previousUser:TranscriptMessage|null=null;
 for(const [user,assistant] of batch){if(user!==previousUser){const sender=userNamesBySenderId[user.sender_user_id as string]||userName;lines.push(`${sender}: ${user.content}`);previousUser=user;}const speaker=namesById[assistant.char_id as string]||charName;lines.push(`${speaker}: ${stripThink(assistant.content)}`);}return lines.join('\n');
}
