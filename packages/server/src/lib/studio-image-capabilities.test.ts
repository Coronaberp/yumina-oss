import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStudioCapabilityContent } from './studio-image-capabilities.js';

test('a local image pause is explained in agent guidance and disappears when re-enabled', () => {
  const content='<image-generation>Use available image tools.</image-generation>';
  const paused=renderStudioCapabilityContent(content,{imageGeneration:true,localImageGeneration:false});
  assert.match(paused,/Anima and Krea.*paused/);
  assert.match(paused,/Do not start local image jobs/);
  assert.match(paused,/Administration/);
  assert.equal(renderStudioCapabilityContent(content,{imageGeneration:true,localImageGeneration:true}),'Use available image tools.');
});
