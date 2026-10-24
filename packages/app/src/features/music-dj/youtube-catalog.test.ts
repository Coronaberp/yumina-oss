import test from "node:test";
import assert from "node:assert/strict";
import { parseYouTubeLink, parseYouTubeTime, makeYouTubeItem, youtubeCatalog, sanitizeYouTubeItems } from "./youtube-catalog";
const video = "M7lc1UVf-VE";
test("only known YouTube video links or exact video IDs become canonical IDs, never fetch URLs", () => {
  for (const link of [video, `https://www.youtube.com/watch?v=${video}&t=90&list=discard`, `https://youtu.be/${video}?si=discard`, `https://m.youtube.com/shorts/${video}`, `https://www.youtube.com/embed/${video}`, `https://youtube.com/live/${video}`]) assert.equal(parseYouTubeLink(link), video);
  for (const link of ["https://evil.test/watch?v="+video,"https://youtube.com.evil.test/watch?v="+video,"https://youtube.com@127.0.0.1/"+video,"https://user:pass@youtube.com/watch?v="+video,"http://youtube.com/watch?v="+video,"https://youtube.com:443/watch?v="+video,"javascript:alert(1)","https://youtube.com/playlist?list=123","https://youtu.be/short","https://youtube.com/watch?v="+video+"evil"]) assert.throws(()=>parseYouTubeLink(link),link);
});
test("timestamps accept seconds or clock notation and require verified bounded cue ranges", () => {
  assert.equal(parseYouTubeTime("1:02.5"),62.5);assert.equal(parseYouTubeTime("1:02:03"),3723);assert.equal(parseYouTubeTime(""),undefined);
  for(const value of ["-1","1:99","NaN","Infinity","1e9","25:00:00"]) assert.throws(()=>parseYouTubeTime(value));
  const bgm=makeYouTubeItem({id:"calm",name:"Calm",link:video,type:"bgm",start:"",end:"",verified:false});
  const cue=makeYouTubeItem({id:"impact",name:"Impact",link:video,type:"sfx",start:"1:00",end:"1:03",verified:true});
  assert.deepEqual(youtubeCatalog([bgm,cue]),[{id:"calm",name:"Calm",type:"bgm"},{id:"impact",name:"Impact",type:"sfx",startSeconds:60,endSeconds:63}]);
  for (const patch of [{verified:false},{end:"59"},{end:"1:31"},{start:""},{end:""}]) assert.throws(()=>makeYouTubeItem({id:"cue",name:"Cue",link:video,type:"sfx",start:"1:00",end:"1:03",verified:true,...patch}));
  assert.throws(()=>makeYouTubeItem({id:"b",name:"B",link:video,type:"bgm",start:"2",end:"10",verified:false}));
  assert.equal(sanitizeYouTubeItems([{...cue,videoId:"../../evil"},cue]).length,1);
  assert.equal(sanitizeYouTubeItems({url:"http://localhost"}).length,0);
});
test("BGM ranges reject rapid-repeat segments while short one-shot cues remain allowed",()=>{
 assert.throws(()=>makeYouTubeItem({id:'short',name:'Short',link:video,type:'bgm',start:0,end:1,verified:true}),/five seconds/);
 assert.ok(makeYouTubeItem({id:'ok',name:'OK',link:video,type:'bgm',start:0,end:5,verified:true}));
 assert.ok(makeYouTubeItem({id:'cue-short',name:'Short cue',link:video,type:'sfx',start:0,end:1,verified:true}));
});
