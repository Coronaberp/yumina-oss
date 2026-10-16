import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageGenerationControls } from './admin-controls.js';
import { defaultGenerationConfig, mergeGenerationSettings, GenerationError, type GenerationRepository } from './config.js';
import { createImageGenerationService } from './service.js';

test('admin pause blocks Anima and Krea before any provider or reference request, and preserves profiles for resume', async () => {
  const dir=mkdtempSync(join(tmpdir(),'yumina-local-image-pause-'));
  const file=join(dir,'image-generation.json');
  const controls=createImageGenerationControls(file);
  const state=mergeGenerationSettings(mergeGenerationSettings(defaultGenerationConfig(),{
    provider:'comfyui',enabled:true,baseUrl:'http://127.0.0.1:8188',workflowMode:'anima',apiKey:'synthetic-local-key',
  },true),{provider:'forgeneo',enabled:true,baseUrl:'http://127.0.0.1:7860'},true);
  const before=structuredClone(state);
  const repo:GenerationRepository={get:async()=>structuredClone(state),update:async()=>{throw new Error('Must not alter profiles');},clear:async()=>{throw new Error('Must not delete profiles');}};
  let providerCalls=0,preflights=0,referenceCalls=0;
  const svc=createImageGenerationService({repository:repo,localGenerationEnabled:()=>controls.read().enabled,
    storage:{preflight:async()=>{preflights++;},validate:async()=>{},save:async()=>{throw new Error('Must not store an image');}},
    fetch:async()=>{providerCalls++;return new Response(JSON.stringify({sd_model_checkpoint:'existing'}),{headers:{'Content-Type':'application/json'}});},
    buildGreenScreenPrompt:prompt=>prompt,removeGreenBackground:async bytes=>bytes,
    prepareNsfwPrompt:async()=>{referenceCalls++;return 'synthetic prompt';},
  });
  try {
    assert.equal(controls.read().enabled,true);
    controls.save({enabled:false});
    assert.equal(createImageGenerationControls(file).read().enabled,false);
    assert.equal((await svc.getStatus('u')).configs.comfyui.configured,false);
    assert.equal((await svc.getConfig('u')).configs.comfyui.adminDisabled,true);
    assert.equal((await svc.getConfig('u')).configs.comfyui.enabled,true);
    assert.equal((await svc.getStatus('u')).configs.forgeneo.configured,true);
    for(const imageWorkflow of ['anima','krea'] as const) {
      await assert.rejects(svc.generate('u',{provider:'comfyui',imageWorkflow,prompt:'synthetic landscape',imageKind:'background',contentRating:'nsfw',
        referenceImages:[{key:'synthetic',url:'/unused-synthetic-reference',name:'Synthetic reference',role:'identity'}]}),
        (error:unknown)=>error instanceof GenerationError&&error.code==='LOCAL_IMAGE_GENERATION_DISABLED');
    }
    assert.equal(providerCalls,0);assert.equal(preflights,0);assert.equal(referenceCalls,0);
    await svc.test('u','forgeneo');
    assert.equal(providerCalls,1);
    controls.save({enabled:true});
    assert.equal((await svc.getStatus('u')).configs.comfyui.configured,true);
    assert.equal((await svc.getConfig('u')).configs.comfyui.adminDisabled,false);
    assert.deepEqual(await repo.get('u'),before);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
