import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMusicDecision, musicDecisionSchema } from '../../../../shared/src/music-dj';
import { createSessionAudioCatalog, youtubeSource } from './source';
const catalog = [{ id: 'relaxed', name: 'Relaxed', type: 'bgm' as const }, { id: 'impact', name: 'Impact', type: 'sfx' as const, startSeconds: 0, endSeconds: 3 }];
test('bounded decision accepts no-change and known cues; rejects URLs, unknown ids and invented timestamps', () => {
 assert.deepEqual(validateMusicDecision({ bgm: { action: 'keep' } }, catalog), { bgm: { action: 'keep' } });
 assert.ok(validateMusicDecision({ bgm: { action: 'play', trackId: 'relaxed', majorSceneChange: true }, sfx: { trackId: 'impact', startSeconds: 0, endSeconds: 3 } }, catalog));
 for (const value of [
  { bgm: { action: 'play', trackId: 'https://evil.test/x' } },
  { bgm: { action: 'keep' }, sfx: { trackId: 'impact', startSeconds: 1, endSeconds: 3 } },
  { bgm: { action: 'keep' }, url: 'http://localhost/' },
  { bgm: { action: 'play', trackId: 'impact' } },
 ]) assert.throws(() => validateMusicDecision(value, catalog));
 assert.equal(musicDecisionSchema.safeParse({ bgm: { action: 'keep' }, sfx: { trackId: 'impact', startSeconds: 0, endSeconds: 31 } }).success, false);
});
test('session adapter uses asset refs only and requires declared SFX boundaries; YouTube search stays disabled', () => {
 const input = [{ id:'b',name:'B',type:'bgm' as const,url:'@asset:music',loop:true }, { id:'s',name:'S',type:'sfx' as const,url:'@asset:cue',maxDuration:3 }, { id:'unbounded',name:'U',type:'sfx' as const,url:'@asset:unknown' }, { id:'external',name:'E',type:'bgm' as const,url:'http://127.0.0.1/x' }];
 const snapshot = JSON.stringify(input);
 assert.deepEqual(createSessionAudioCatalog(input).map(x=>x.id), ['b','s']);
 assert.equal(JSON.stringify(input),snapshot);
 assert.equal(youtubeSource.available,true);
 assert.equal(youtubeSource.searchAvailable,false);
 assert.throws(()=>youtubeSource.search(),/disabled/i);
});
