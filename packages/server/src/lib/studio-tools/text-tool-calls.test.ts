import assert from 'node:assert/strict';
import test from 'node:test';
import { STUDIO_TOOLS } from './tools.js';
import { couldStartTextToolCall, looksLikeTextToolRequest, recoverTextToolCalls } from './text-tool-calls.js';

const args = { id: 'lightning-mage', name: 'Lightning Mage', content: 'Lightning crackles around the staff.' };
const call = { tool: 'write_entry', arguments: args };

test('recovers complete standalone tool envelopes and keeps argument content intact', () => {
  const formats = [call, { name: 'write_entry', arguments: args }, { id: 'model-id', type: 'function', function: { name: 'write_entry', arguments: JSON.stringify(args) } }];
  for (const format of formats) {
    for (const text of [JSON.stringify(format), `\`\`\`json\n${JSON.stringify(format)}\n\`\`\``, `<tool_call>${JSON.stringify(format)}</tool_call>`]) {
      const recovered = recoverTextToolCalls(text, STUDIO_TOOLS, 'call_text_run_0');
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]!.function.name, 'write_entry');
      assert.deepEqual(JSON.parse(recovered[0]!.function.arguments), args);
      assert.equal(recovered[0]!.id, 'call_text_run_0_0');
    }
  }
});

test('supports explicit batches and tagged Qwen calls without parsing tags inside JSON strings', () => {
  const second = { name: 'write_entry', arguments: { ...args, id: 'second-mage', content: 'Keep </tool_call> and ``` literally inside the story.' } };
  for (const text of [JSON.stringify([call, second]), JSON.stringify({ tool_calls: [call, second] }), `<tool_call>${JSON.stringify(call)}</tool_call>\n<tool_call>${JSON.stringify(second)}</tool_call>`]) {
    const recovered = recoverTextToolCalls(text, STUDIO_TOOLS, 'call_text_run_2');
    assert.deepEqual(recovered.map(item => item.id), ['call_text_run_2_0', 'call_text_run_2_1']);
    assert.equal(JSON.parse(recovered[1]!.function.arguments).content, second.arguments.content);
    assert.deepEqual(recoverTextToolCalls(text, STUDIO_TOOLS, 'call_text_run_2'), recovered, 'Replays retain the same call IDs');
  }
});

test('does not extract examples, repair incomplete JSON, or recover unknown/unavailable tools', () => {
  const json = JSON.stringify(call);
  const rejected = [
    `Here is an example: ${json}`, `${json}\nHere is what it means.`, `> ${json}`,
    `\`\`\`typescript\n${json}\n\`\`\``, json.slice(0, -1), `<tool_call>${json}`,
    `{"tool":"write_entry","arguments":{id:"x"}}`, JSON.stringify({ ...call, explanation: 'An example' }),
    JSON.stringify({ tool: 'run_shell', arguments: { command: 'anything' } }),
    JSON.stringify({ tool: 'write_entry', arguments: null }), JSON.stringify({ tool: 'write_entry', arguments: [] }),
    JSON.stringify({ tool: 'write_entry', arguments: 'not an object' }), JSON.stringify({ tool: 'write_entry' }),
    JSON.stringify({ name: 'write_entry', type: 'not-function', arguments: args }),
    JSON.stringify({ tool_calls: [] }), JSON.stringify({ example: call }),
  ];
  for (const text of rejected) assert.deepEqual(recoverTextToolCalls(text, STUDIO_TOOLS, 'id'), []);
  assert.deepEqual(recoverTextToolCalls(json, [], 'id'), []);
  assert.deepEqual(recoverTextToolCalls(JSON.stringify({ tool: 'generate_image', arguments: { prompt: 'art' } }), STUDIO_TOOLS.filter(tool => tool.function.name !== 'generate_image'), 'id'), []);
});

test('only buffers text that could start a standalone JSON or tagged request', () => {
  for (const prefix of ['', ' ', '{', '[', '`', '```json\n{', '<', '<tool_', '<tool_call>{']) assert.equal(couldStartTextToolCall(prefix), true);
  for (const text of ['Created the mage.', 'Here is JSON: {', '<p>Story</p>', '`a single inline quote`']) assert.equal(couldStartTextToolCall(text), false);
});

test('recognizes unexecuted request envelopes, including numbered plans and malformed argument strings', () => {
  const malformed = '{"tool":"write_entry","arguments":{"id":"mage","content":"She calls them "my darling"."}}';
  for (const text of [malformed, `${JSON.stringify(call)}\n${malformed}`, `1. Add the mage.\n2. Validate afterward.\n\n${malformed}`, `\`\`\`json\n${malformed}\n\`\`\``, `<tool_call>${malformed}</tool_call>`, `[{"id":"x","type":"function","function":{"name":"write_entry","arguments":`]) {
    assert.equal(looksLikeTextToolRequest(text, STUDIO_TOOLS), true, text);
  }
});

test('does not classify prose explanations or ordinary JSON data as unexecuted requests', () => {
  const json = JSON.stringify(call);
  for (const text of ['Created the mage.', '{This is prose.}', `Here is an example:\n\`\`\`json\n${json}\n\`\`\``, JSON.stringify({ example: call }), JSON.stringify({ name: 'write_entry', description: 'A tool for creating entries.' }), `\`\`\`typescript\n${json}\n\`\`\``, JSON.stringify({ tool: 'not_available', arguments: {} })]) {
    assert.equal(looksLikeTextToolRequest(text, STUDIO_TOOLS), false, text);
  }
  assert.equal(looksLikeTextToolRequest(json, []), false);
});

test('recovers adjacent JSON requests and numbered plans directly without changing argument strings', () => {
  const second = { tool: 'write_entry', arguments: { ...args, id: 'second-mage', content: 'Keep {braces}, [arrays], \\slashes and "quotes" literally.' } };
  const batch = `${JSON.stringify(call)}\n${JSON.stringify(second)}`;
  for (const text of [batch, batch.replace('\n', ''), `1. Add both mages.\n2. Validate afterward.\n\n${batch}`, `\`\`\`json\n${batch}\n\`\`\``, `\`\`\`json\n${JSON.stringify(call)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(second)}\n\`\`\``]) {
    const recovered = recoverTextToolCalls(text, STUDIO_TOOLS, 'direct');
    assert.equal(recovered.length, 2, text);
    assert.deepEqual(JSON.parse(recovered[1]!.function.arguments), second.arguments);
    assert.deepEqual(recoverTextToolCalls(text, STUDIO_TOOLS, 'direct'), recovered);
  }
});

test('valid requests remain executable when another complete request is malformed or unavailable', () => {
  const malformed = '{"tool":"write_entry","arguments":{"id":"bad","content":"She calls them "my darling"."}}';
  for (const text of [`${malformed}\n${JSON.stringify(call)}`, `${JSON.stringify(call)}\n${malformed}`, JSON.stringify([call, { tool: 'not_a_tool', arguments: {} }])]) {
    const recovered = recoverTextToolCalls(text, STUDIO_TOOLS, 'direct');
    assert.equal(recovered.length, 1);
    assert.deepEqual(JSON.parse(recovered[0]!.function.arguments), args);
  }
});

test('identical printed requests in the same response execute only once', () => {
  const reordered = { tool: 'write_entry', arguments: { content: args.content, name: args.name, id: args.id } };
  for (const text of [`${JSON.stringify(call)}\n${JSON.stringify(call)}`, JSON.stringify([call, call]), JSON.stringify([call, reordered])]) {
    assert.equal(recoverTextToolCalls(text, STUDIO_TOOLS, 'direct').length, 1);
  }
});
