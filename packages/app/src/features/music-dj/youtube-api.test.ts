import test from "node:test";
import assert from "node:assert/strict";
import { loadYouTubeApi } from "./youtube-api";
test("official API loader uses one fixed script, shares readiness, and retries only after explicit failure",async()=>{
 const scripts:Array<{src:string;referrerPolicy:string;onerror?:()=>void;remove:()=>void}>=[];
 const win:{YT?:{Player:typeof Dummy};onYouTubeIframeAPIReady?:()=>void}={};
 class Dummy {}
 Object.defineProperty(globalThis,"window",{configurable:true,value:win});
 Object.defineProperty(globalThis,"document",{configurable:true,value:{createElement:()=>({src:"",referrerPolicy:"",remove(){}}),head:{appendChild:(script:typeof scripts[number])=>scripts.push(script)}}});
 const first=loadYouTubeApi();assert.equal(loadYouTubeApi(),first);assert.equal(scripts.length,1);assert.equal(scripts[0].src,"https://www.youtube.com/iframe_api");assert.equal(scripts[0].referrerPolicy,"strict-origin-when-cross-origin");
 scripts[0].onerror?.();await assert.rejects(first,/could not load/);
 const second=loadYouTubeApi();assert.equal(scripts.length,2);win.YT={Player:Dummy};win.onYouTubeIframeAPIReady?.();assert.equal(await second,win.YT);assert.equal(await loadYouTubeApi(),win.YT);assert.equal(scripts.length,2);
});
