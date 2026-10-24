import test from "node:test";
import assert from "node:assert/strict";
import { YouTubeMusicPlayback, type YouTubePlayer } from "./youtube-playback";
import type { YouTubeMusicItem } from "./youtube-catalog";
const items: YouTubeMusicItem[]=[
 {id:"calm",name:"Calm",type:"bgm",videoId:"M7lc1UVf-VE",rangeVerified:false},
 {id:"combat",name:"Combat",type:"bgm",videoId:"bHQqvYy5KYo",rangeVerified:false},
 {id:"cue",name:"Cue",type:"sfx",videoId:"aqz-KE-bpKQ",rangeVerified:true,startSeconds:2,endSeconds:5},
 {id:"same",name:"Same video cue",type:"sfx",videoId:"M7lc1UVf-VE",rangeVerified:true,startSeconds:2,endSeconds:5},
];
class Player implements YouTubePlayer {
 loads:Array<{videoId:string;startSeconds?:number;endSeconds?:number}>=[];videoId="";time=0;state=-1;volume=100;pauses=0;stops=0;
 loadVideoById(value:{videoId:string;startSeconds?:number;endSeconds?:number}){this.loads.push(value);this.videoId=value.videoId;this.time=value.startSeconds??0;this.state=-1;}
 playVideo(){this.state=1;}pauseVideo(){this.pauses++;this.state=2;}stopVideo(){this.stops++;this.state=-1;}
 getVideoData(){return {video_id:this.videoId};}getCurrentTime(){return this.time;}getDuration(){return 180;}getPlayerState(){return this.state;}setVolume(value:number){this.volume=value;}
}
function fixture(){let now=0;const interrupts:string[]=[];const p=new Player();const y=new YouTubeMusicPlayback(items,60,()=>{},reason=>interrupts.push(reason),()=>now);return {y,p,interrupts,advance:(ms:number)=>now+=ms,ready:()=>{y.attach(p);y.setVisible(true);},playing:()=>{p.state=1;y.onState(1,p);},ended:()=>{p.state=0;y.onState(0,p);}};}
test("a visible ready player is required; keep/same BGM does not reload or extend its cap",()=>{
 const f=fixture();f.y.playBgm("calm");assert.equal(f.p.loads.length,0);f.ready();assert.equal(f.p.loads.length,1);f.playing();f.y.playBgm("calm");assert.equal(f.p.loads.length,1);
 f.advance(60001);f.y.tick();assert.equal(f.y.view.currentId,null);assert.equal(f.p.stops,1);
});
test("one player interrupts BGM and restores its bookmark; stale ended cannot finish the new cue",()=>{
 const f=fixture();f.ready();f.y.playBgm("calm");f.playing();f.p.time=72;f.y.playSfx("cue",2,5);
 assert.equal(f.p.loads.at(-1)!.videoId,items[2].videoId);f.y.onState(0,f.p);assert.equal(f.p.loads.length,2);
 f.playing();f.p.state=1;f.y.onState(0,f.p);assert.equal(f.p.loads.length,2);
 f.y.playSfx("same",2,5);assert.equal(f.p.loads.length,2,"one cue at a time");
 f.p.time=5;f.ended();assert.deepEqual(f.p.loads.at(-1),{videoId:items[0].videoId,startSeconds:72});
});
test("pause, skip, visibility and disposal supersede cue restoration; visibility does not automatically restart",()=>{
 for(const action of ["pause","stop","hide","dispose"]){const f=fixture();f.ready();f.y.playBgm("calm");f.playing();f.p.time=20;f.y.playSfx("cue",2,5);f.playing();
 if(action==='hide')f.y.setVisible(false);else f.y[action as "pause"|"stop"|"dispose"]();
 const count=f.p.loads.length;f.p.time=5;f.ended();assert.equal(f.p.loads.length,count,action);
 if(action==='hide'){f.y.setVisible(true);assert.equal(f.p.loads.length,count);f.y.resume();assert.equal(f.p.loads.at(-1)!.startSeconds,20);}
 }
});
test("cue failure restores BGM once, autoplay blocked requires manual playback, BGM errors do not retry",()=>{
 const f=fixture();f.ready();f.y.playBgm("calm");f.playing();f.p.time=30;f.y.playSfx("cue",2,5);f.y.onError(101,f.p);
 assert.equal(f.p.loads.at(-1)!.videoId,items[0].videoId);assert.equal(f.p.loads.at(-1)!.startSeconds,30);
 f.y.onAutoplayBlocked(f.p);assert.equal(f.y.view.needsGesture,true);const count=f.p.loads.length;f.y.setVisible(true);f.y.tick();assert.equal(f.p.loads.length,count);
 f.y.resume();f.p.state=-1;f.y.onError(100,f.p);const failed=f.p.loads.length;f.y.tick();assert.equal(f.p.loads.length,failed);assert.match(f.y.view.message,/unavailable/i);
});
test("same-video stale end events are ignored until current load plays; old player callbacks have no authority",()=>{
 const f=fixture();f.ready();f.y.playBgm("calm");f.playing();f.p.time=70;f.y.playSfx("same",2,5);f.p.state=0;f.p.time=5;f.y.onState(0,f.p);assert.equal(f.p.loads.length,2);
 f.playing();f.y.onError(100,new Player());assert.equal(f.p.loads.length,2);f.p.time=5;f.ended();assert.equal(f.p.loads.at(-1)!.startSeconds,70);
 f.y.dispose();f.y.onAutoplayBlocked(f.p);f.y.onState(1,f.p);assert.equal(f.y.view.ready,false);
});
test("serial cue and resumed BGM use latest user volume; loops preserve original maximum dwell deadline",()=>{
 const f=fixture();f.ready();f.y.setVolumes(.5,.8);f.y.playBgm("calm");f.playing();assert.equal(f.p.volume,50);f.p.time=180;f.ended();assert.equal(f.p.loads.length,2);f.playing();
 f.y.playSfx("cue",2,5);assert.equal(f.p.volume,80);f.playing();f.y.setVolumes(.7,.4);assert.equal(f.p.volume,40);f.p.time=5;f.ended();assert.equal(f.p.volume,70);
 f.advance(60001);f.y.tick();assert.equal(f.y.view.currentId,null);
});
test("invalid media ranges fail safely and native seek supersedes automatic cue return without skipping content",()=>{
 const bad={...items[2],id:'bad',startSeconds:200,endSeconds:203};const p=new Player();const y=new YouTubeMusicPlayback([...items,bad],60,()=>{},()=>{});y.attach(p);y.setVisible(true);y.playBgm('calm');p.state=1;y.onState(1,p);p.time=25;y.playSfx('bad',200,203);p.state=0;y.onState(0,p);assert.equal(p.loads.at(-1)!.videoId,items[0].videoId);
 const f=fixture();f.ready();f.y.playBgm('calm');f.playing();f.p.time=20;f.y.playSfx('cue',2,5);f.playing();f.p.time=40;const loads=f.p.loads.length;const pauses=f.p.pauses;f.y.tick();assert.equal(f.p.loads.length,loads);assert.equal(f.p.pauses,pauses);assert.match(f.y.view.message,/cancelled/i);f.ended();assert.equal(f.p.loads.length,loads);
});
test("native YouTube selection supersedes the DJ without stopping user playback or restoring an old bookmark",()=>{
 const f=fixture();f.ready();f.y.playBgm('calm');f.playing();f.p.time=40;f.y.playSfx('cue',2,5);f.playing();f.p.videoId='bHQqvYy5KYo';const pauses=f.p.pauses;const loads=f.p.loads.length;f.y.onState(1,f.p);assert.equal(f.p.pauses,pauses);assert.equal(f.y.view.currentId,null);assert.match(f.y.view.message,/cancelled/);f.ended();assert.equal(f.p.loads.length,loads);
 const fresh=fixture();fresh.ready();fresh.p.videoId=items[0].videoId;fresh.playing();assert.match(fresh.y.view.message,/controls are active/);assert.equal(fresh.interrupts.length,1);
});
test("late playing cannot start hidden audio, and a not-yet-started BGM never bookmarks an old same-video position",()=>{
 const f=fixture();f.ready();f.y.playBgm('calm');f.playing();f.y.playSfx('cue',2,5);f.playing();f.y.setVisible(false);f.p.state=1;f.y.onState(1,f.p);assert.equal(f.p.state,2);assert.equal(f.y.view.visible,false);assert.equal(f.p.loads.length,2);
 const item={...items[0],id:'ranged',rangeVerified:true,startSeconds:100,endSeconds:120};const p=new Player();const y=new YouTubeMusicPlayback([...items,item],60,()=>{},()=>{});y.attach(p);y.setVisible(true);y.playBgm('ranged');p.time=50;y.playSfx('cue',2,5);p.state=1;y.onState(1,p);p.time=5;p.state=0;y.onState(0,p);assert.equal(p.loads.at(-1)!.startSeconds,100);
});
