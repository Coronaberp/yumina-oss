import test from 'node:test';
import assert from 'node:assert/strict';
const memory=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>memory.set(k,v),removeItem:(k:string)=>memory.delete(k)}});
Object.defineProperty(globalThis,'window',{configurable:true,value:{localStorage:globalThis.localStorage}});
const {useMusicDjPreferences,listenerModeForSession}=await import('./preferences');
const vn={rootComponent:{interfaceId:'vn',files:{'index.tsx':'<div className="vn-stage" />'}}};
test('listener mode is scoped by account/session and classic/standard/read-only stay creator-owned',()=>{
 const p=useMusicDjPreferences.getState();p.setMode('one','session','personal');p.setMode('one','other','off');
 assert.equal(listenerModeForSession('one','session',vn,false),'personal');
 assert.equal(listenerModeForSession('two','session',vn,false),'creator');
 assert.equal(listenerModeForSession('one','other',vn,false),'off');
 assert.equal(listenerModeForSession('one','session',vn,true),'creator');
 assert.equal(listenerModeForSession('one','session',{},false),'creator');
 assert.equal(listenerModeForSession('one','session',{rootComponent:{interfaceId:'classic',files:vn.rootComponent.files}},false),'creator');
 assert.equal(listenerModeForSession('','session',vn,false),'creator');
 p.update('one',{consent:true,source:'session',preferences:'x'.repeat(600),maxBgmSeconds:Infinity});
 assert.equal(useMusicDjPreferences.getState().accounts.one.preferences.length,500);
 assert.equal(useMusicDjPreferences.getState().accounts.one.maxBgmSeconds,600);
 assert.equal(useMusicDjPreferences.getState().accounts.two,undefined);
});
test('YouTube catalog is account-local and rejects tampered persisted identifiers/ranges',()=>{
 const p=useMusicDjPreferences.getState();const item={id:'yt-personal',name:'My public test',videoId:'M7lc1UVf-VE',type:'bgm' as const,rangeVerified:false};
 p.update('one',{youtubeConsent:true,youtubeCatalog:[item,{...item,id:'bad',videoId:'http://localhost/private'}]});
 assert.deepEqual(useMusicDjPreferences.getState().accounts.one.youtubeCatalog,[item]);
 assert.equal(useMusicDjPreferences.getState().accounts.two,undefined);
 assert.equal(useMusicDjPreferences.getState().accounts.one.youtubeConsent,true);
});
