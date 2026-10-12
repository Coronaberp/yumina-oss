import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftPersonaChoice } from '../../../../interfaces/vn/persona-choice-assistance';

test('assistance drafts an editable choice using the saved persona without sending a story turn', async () => {
  let sends = 0;
  const api = {
    getPersonaProfile: async () => ({ name: 'Robin', personality: 'Reserved', backstory: 'Academy student' }),
    messages: [{ role: 'assistant', content: 'The guide offers a tour.' }],
    sendMessage: () => { sends++; },
    ai: { complete: async (params: any) => {
      assert.equal(params.messages.at(-1).role, 'user');
      const data = JSON.parse(params.messages.at(-1).content);
      assert.equal(data.instruction, 'politely refuse');
      assert.equal(data.persona.personality, 'Reserved');
      assert.match(data.scene, /guide offers a tour/);
      return '"Thank you, but I would rather stay here."';
    } },
  };
  assert.equal(await draftPersonaChoice(api, 'politely refuse'), '"Thank you, but I would rather stay here."');
  assert.equal(sends, 0);
});

test('an empty assistant draft rejects without replacing the player instruction', async () => {
  const api = { getPersonaProfile: async () => null, messages: [], ai: { complete: async () => '  ' } };
  await assert.rejects(draftPersonaChoice(api, 'politely refuse'), /empty/i);
});
