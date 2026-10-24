import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatorAudioGate } from '../../../sandbox/creator-audio-gate';
test('creator raw media and new play attempts stay suppressed until ownership returns',async()=>{
 let plays=0,pauses=0;const media={pause:()=>{pauses++;}};
 const gate=createCreatorAudioGate({play:async()=>{plays++;}});
 gate.setAllowed(false,[media]);await assert.doesNotReject(()=>gate.play(media));assert.equal(plays,0);assert.equal(pauses,1);
 gate.setAllowed(true,[media]);assert.equal(plays,0,'does not silently resume');await gate.play(media);assert.equal(plays,1);
});
test('UI ownership updates cannot resume a hidden renderer or personal audio context',async()=>{
 let plays=0;const media={pause(){}};const gate=createCreatorAudioGate({play:async()=>{plays++;}});
 gate.setOwnership('creator',true,[media]);await gate.play(media);assert.equal(plays,0);
 gate.setOwnership('personal',false,[media]);await gate.play(media);assert.equal(plays,0);
 gate.setOwnership('off',false,[media]);await gate.play(media);assert.equal(plays,0);
 gate.setOwnership('creator',false,[media]);await gate.play(media);assert.equal(plays,1);
});
