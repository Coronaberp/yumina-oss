import * as config from './config.js';
import type { FactType } from './types.js';
/** Structural source shape also accepts StoryHaven lore pseudo-facts. */
export interface CoreFact {
 id: string; text: string; fact_type: FactType | 'lore'; participants: string[];
 importance: number; valence: number; reinforcements: number; last_turn: number;
 valid_until_turn: number | null; pinned?: boolean; location?: string | null;
 distance?: number; source?: string; demoted?: boolean; metadata?: Record<string,unknown>;
 links?: unknown[]; link_label?: string | null; query_matched?: boolean;
 character_identity?: boolean;
}
export interface CoreCluster { id: string; summary_text: string; created_turn: number; title?: string | null; distance?: number }
export function locationMatches(fact:CoreFact,currentLocation?:string|null):boolean {
 if (!fact.location || !currentLocation) return true;
 return fact.location.trim().toLowerCase()===currentLocation.trim().toLowerCase();
}
export function isActive(fact:CoreFact,currentLocation?:string|null):boolean {
 if(fact.fact_type==='profile')return fact.valid_until_turn===null;
 let locationOk:boolean;
 if(config.LOCATION_SCOPED_STATEFUL_TYPES.has(fact.fact_type))locationOk=locationMatches(fact,currentLocation);
 else if(config.UNSCOPED_STATEFUL_TYPES.has(fact.fact_type))locationOk=true;
 else return false;
 return fact.valid_until_turn===null&&fact.importance>=config.ACTIVE_STATE_IMPORTANCE_FLOOR&&locationOk;
}
export function retention(fact:CoreFact,turn:number,location?:string|null):number {
 if(fact.source==='lore'||fact.pinned)return 1;
 if(!fact.demoted&&isActive(fact,location))return 1;
 const age=Math.max(0,turn-fact.last_turn);
 if(fact.fact_type==='injury'&&age>config.INJURY_HEAL_TURNS)return 0;
 const base=fact.fact_type==='mood'?config.MOOD_STRENGTH_BASE:config.STRENGTH_BASE;
 const strength=base+config.STRENGTH_PER_REINFORCEMENT*fact.reinforcements+config.STRENGTH_PER_IMPORTANCE*fact.importance+config.STRENGTH_PER_VALENCE*Math.abs(fact.valence);
 return Math.exp(-age/strength);
}
export function participantsPresent(fact:CoreFact,presentLower:Set<string>):boolean {
 if(fact.fact_type==='world'||fact.source==='lore'||!fact.participants.length)return true;
 return fact.participants.some(p=>presentLower.has(p.toLowerCase()));
}
export function passesFilters(fact:CoreFact,_presentLower:Set<string>,turn:number,location?:string|null):boolean {
 return retention(fact,turn,location)>=config.RETENTION_FLOOR;
}
export function score(fact:CoreFact,turn:number,location?:string|null,presentLower?:Set<string>):number {
 const relevance=Math.max(0,1-(fact.distance as number));
 const scale=fact.fact_type==='mood'?config.MOOD_RECENCY_SCALE_TURNS:config.RECENCY_SCALE_TURNS;
 const recency=Math.exp(-Math.max(0,turn-fact.last_turn)/scale);
 const bonus=location&&fact.location&&locationMatches(fact,location)?config.LOCATION_MATCH_WEIGHT:0;
 const equipment=fact.fact_type==='equipment'?config.EQUIPMENT_BOOST:0;
 const weight=config.RELEVANCE_WEIGHT*relevance+config.RECENCY_WEIGHT*recency+config.IMPORTANCE_WEIGHT*fact.importance/5+bonus+equipment;
 const base=weight*retention(fact,turn,location);
 return presentLower&&!participantsPresent(fact,presentLower)?base*config.PARTICIPANT_ABSENCE_PENALTY:base;
}
export function scoreCluster(cluster:Pick<CoreCluster,'created_turn'|'distance'>,turn:number):number {
 const relevance=Math.max(0,1-(cluster.distance??1));
 const recency=Math.exp(-Math.max(0,turn-cluster.created_turn)/config.RECENCY_SCALE_TURNS);
 return config.RELEVANCE_WEIGHT*relevance+config.RECENCY_WEIGHT*recency;
}
export function rankClusters<T extends Pick<CoreCluster,'created_turn'|'distance'>>(clusters:T[],turn:number):T[] {
 return [...clusters].sort((a,b)=>scoreCluster(b,turn)-scoreCluster(a,turn));
}
export function rank<T extends CoreFact>(candidates:T[],present:string[],turn:number,location?:string|null):T[] {
 const lower=new Set(present.map(p=>p.toLowerCase()));
 return candidates.filter(c=>passesFilters(c,lower,turn,location)).sort((a,b)=>score(b,turn,location,lower)-score(a,turn,location,lower));
}
