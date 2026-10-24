import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMusicDj, finishMusicDj } from './music-dj';
const input={optIn:true,reply:'A calm courtyard. The full ending.',catalog:[{id:'calm',name:'Calm',type:'bgm'}],preferences:'Instrumental',currentTrackId:null};
test('one constrained tool sees the full reply and no source URL or external key',()=>{
 const setup=prepareMusicDj(input);assert.equal(setup.messages[1]!.content,input.reply);
 assert.equal(setup.tool.function.name,'music_decision');
 assert.throws(()=>prepareMusicDj({...input,optIn:false}));
 assert.throws(()=>prepareMusicDj({...input,catalog:[{...input.catalog[0],url:'http://localhost'}]}));
 const call={id:'x',type:'function' as const,function:{name:'music_decision',arguments:JSON.stringify({bgm:{action:'play',trackId:'calm'}})}};
 assert.equal(finishMusicDj([call],setup.catalog).bgm.action,'play');
 for(const calls of [[],[call,call],[{...call,function:{...call.function,name:'fetch'}}]]) assert.throws(()=>finishMusicDj(calls,setup.catalog));
 assert.throws(()=>finishMusicDj([{...call,function:{...call.function,arguments:'{"bgm":{"action":"play","trackId":"unknown"}}'}}],setup.catalog));
});
