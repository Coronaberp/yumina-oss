import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider, stopCodexConversation, leaseCodexConversation, generateCodexImage } from "./codex.js";
import type { GenerateParams, StreamChunk } from "./types.js";

async function fixture(t: test.TestContext, mode: string) {
  const directory = await mkdtemp(join(tmpdir(), "yumina-codex-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, "codex");
  await writeFile(command, `#!/usr/bin/env node
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const mode = ${JSON.stringify(mode)};
if (mode === 'blank-lines') process.stdout.write(' \\t\\r\\n\\n');
const results=[];
let steered='', imageEnabled=false;
readline.createInterface({input:process.stdin}).on('line', line => {
 const msg=JSON.parse(line), p=msg.params;
 if(!msg.method&&msg.result&&[101,102].includes(msg.id)) {
  if(mode==='unknown-recover') { send({method:'item/agentMessage/delta',params:{threadId:'thread-test',delta:msg.result.success===false?'Recovered unavailable tool':'Incorrect tool success'}}); send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}}});return; }
  if(mode==='unknown') { send({id:101,method:'item/tool/call',params:{threadId:'thread-test',turnId:'turn-test',callId:'call-1',tool:'unknown_write',arguments:{}}});return; }
  results.push(msg.result.contentItems[0].text);
  if(results.length===2) {
   send({method:'item/agentMessage/delta',params:{threadId:'thread-test',delta:mode==='steering'?(steered.includes('Prioritize the new instruction')&&steered.includes('Updated world instruction')?'Used latest steering':'Missed steering'):'Handled both results'}});
   send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}}});
  }
 }
 if(msg.method==='turn/steer') {steered=JSON.stringify(p.input);send({id:msg.id,result:{turnId:'turn-test'}});}
 if(msg.method==='initialize') {
  if(mode==='bom') process.stdout.write('\\uFEFF');
  if(mode==='invalid-json') {process.stdout.write('{broken protocol secret=do-not-expose\\n');return;}
  if(mode==='invalid-shape') {send(null);return;}
  send({id:msg.id,result:{}});
 }
 if(msg.method==='account/read') send({id:msg.id,result:{account:{type:mode==='auth'?'apiKey':'chatgpt'}}});
 if(msg.method==='config/read') send({id:msg.id,result:{config:{mcp_servers:{inherited:{enabled:true}},plugins:{'test@local':{enabled:true}}}}});
 if(msg.method==='model/list') send({id:msg.id,result:{data:[{id:'gpt-6-luna',model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'max'},{reasoningEffort:'low'}]},{id:'gpt-6.1-sol',model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]}]}});
 if(msg.method==='modelProvider/capabilities/read') send({id:msg.id,result:{imageGeneration:mode!=='image-unsupported'}});
 if(msg.method==='thread/start') {
  if(mode.startsWith('image')) {
   if(p.model!=='gpt-6.1-sol'||p.allowProviderModelFallback!==false||!p.ephemeral||p.sandbox!=='read-only'||p.config.features.shell_tool!==false||p.config.mcp_servers.inherited.enabled!==false||p.dynamicTools.length) {send({id:msg.id,error:{message:'Incorrect image thread configuration'}});return;}
   imageEnabled=p.config.features.image_generation===true;
   if(imageEnabled&&(mode==='image-nsfw'||mode==='image-reference-nsfw')){send({id:msg.id,error:{message:'Image provider called for NSFW'}});return;}
   send({id:msg.id,result:{thread:{id:'thread-test'},model:'gpt-6.1-sol'}});return;
  }
  if(p.model!=='gpt-6-luna'||p.allowProviderModelFallback!==false||!p.ephemeral||p.sandbox!=='read-only'||p.config.features.shell_tool!==false||p.config.features.image_generation!==false||p.config.mcp_servers.inherited.enabled!==false||p.config.plugins['test@local'].enabled!==false) {
   send({id:msg.id,error:{message:'Unsafe or incorrect thread configuration'}});return;
  }
  send({id:msg.id,result:{thread:{id:'thread-test'},model:'gpt-6-luna'}});
 }
 if(msg.method==='turn/start') {
  if(mode.startsWith('image')) {
   if(mode.startsWith('image-reference')&&(p.input.filter(v=>v.type==='image').length!==1||p.input.find(v=>v.type==='image').url!=='data:image/png;base64,cmVm')) {send({id:msg.id,error:{message:'Reference image did not reach checker and generator'}});return;}
   if(p.model!=='gpt-6.1-sol'||p.effort!=='xhigh') {send({id:msg.id,error:{message:'Incorrect image model or effort'}});return;}
   if(imageEnabled&&mode==='image-transparent-follow') {
    const request=JSON.parse(p.input.find(v=>v.type==='text').text);
    if(request.imageKind!=='image'||request.background==='opaque'||!request.instructions.includes('transparent_background=true')) {send({id:msg.id,error:{message:'Requested transparency was overridden'}});return;}
   }
   send({id:msg.id,result:{turn:{id:'turn-test'}}});
   if(mode==='image-timeout')return;
   if(!imageEnabled){send({method:'item/agentMessage/delta',params:{threadId:'thread-test',delta:JSON.stringify({allowed:mode!=='image-nsfw'&&mode!=='image-reference-nsfw',reason:'Reference and prompt checked'})}});send({method:'turn/completed',params:{threadId:'thread-test',turn:{status:'completed'}}});return;}
   if(mode==='image-explanation')send({method:'item/completed',params:{threadId:'thread-test',item:{type:'agentMessage',text:'The referenced image was not attached. Please provide it.'}}});
   if(!['image-empty','image-explanation'].includes(mode))send({method:'item/completed',params:{threadId:'thread-test',item:{id:'image-1',type:'imageGeneration',status:mode==='image-failed'?'failed':'completed',failure:mode==='image-failed'?{message:'Image quota exhausted'}:null,result:mode==='image-bad'?'../../private.png':'aW1hZ2UtYnl0ZXM=',transparentBackground:true}}});
   send({method:'turn/completed',params:{threadId:'thread-test',turn:{status:'completed'}}});return;
  }
  if(p.effort!==(mode==='check'?'low':'max')) {send({id:msg.id,error:{message:'Wrong effort'}});return;}
  send({id:msg.id,result:{turn:{id:'turn-test'}}});
  if(mode==='timeout') return;
  if(mode==='exit') {process.exit(0);return;}
  send({method:'item/agentMessage/delta',params:{threadId:'thread-test',delta:'Hello'}});
  if(mode==='tools'||mode==='steering') {
   send({id:101,method:'item/tool/call',params:{threadId:'thread-test',turnId:'turn-test',callId:'call-1',tool:'read_entities',arguments:{entityType:'rule'}}});
   send({id:102,method:'item/tool/call',params:{threadId:'thread-test',turnId:'turn-test',callId:'call-2',tool:'validate_world',arguments:{}}});
  } else if(mode==='unknown'||mode==='unknown-recover') {
   send({id:101,method:'item/tool/call',params:{threadId:'thread-test',turnId:'turn-test',callId:'call-1',tool:'unknown_write',arguments:{}}});
  } else {
   send({method:'thread/tokenUsage/updated',params:{threadId:'thread-test',tokenUsage:{last:{inputTokens:12,outputTokens:4,totalTokens:16,reasoningOutputTokens:2}}}});
   send({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:mode==='failed'?'failed':'completed',error:mode==='failed'?{message:'Upstream quota exhausted'}:null}}});
  }
 }
});

`, { mode: 0o700 });
  return command;
}
const tools = ["read_entities", "validate_world"].map(name => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object" } } }));
const params: GenerateParams = { model: "codex/gpt-6-luna", reasoningEffort: "low", messages: [{ role: "system", content: "Studio instructions" }, { role: "user", content: "Inspect the rules" }], tools };
async function collect(provider: CodexProvider, override: Partial<GenerateParams> = {}) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.generateStream({ ...params, ...override })) chunks.push(chunk);
  return chunks;
}
test("Codex emits real parallel tool calls for Yumina to execute with Max reasoning", async t => {
  const controller = new AbortController(); t.after(() => controller.abort());
  const chunks = await collect(new CodexProvider(await fixture(t, "tools")), { signal: controller.signal });
  assert.deepEqual(chunks.filter(c => c.type === "tool_call_end").map(c => c.toolCall), [
    { id: "call-1", type: "function", function: { name: "read_entities", arguments: '{"entityType":"rule"}' } },
    { id: "call-2", type: "function", function: { name: "validate_world", arguments: '{}' } },
  ]);
  assert.equal(chunks.at(-1)?.type, "done");
  assert.ok(!chunks.some(c => c.type === "error"));
});
test("Codex validation checks explicitly use low while Studio retains Max", async t => {
  const chunks = await collect(new CodexProvider(await fixture(t, "check")), { tools: [], reasoningEffortOverride: "low" });
  assert.equal(chunks.at(-1)?.type, "done");
  assert.ok(!chunks.some(c => c.type === "error"));
});
test("Codex returns host tool results to the same native turn instead of repeating actions", async t => {
  const controller = new AbortController(); t.after(() => controller.abort());
  const command = await fixture(t, "tools");
  const provider = new CodexProvider(command);
  const first = await collect(provider, { signal: controller.signal, conversationId: "codex-test-native-turn" });
  assert.equal(first.filter(c => c.type === "tool_call_end").length, 2);
  // A fresh provider instance is how Studio resumes after a proposal approval.
  const chunks = await collect(new CodexProvider(command), { signal: controller.signal, conversationId: "codex-test-native-turn", messages: [
    ...params.messages,
    { role: "tool", tool_call_id: "call-1", content: "Read result" },
    { role: "tool", tool_call_id: "call-2", content: "Validation result" },
  ] });
  assert.equal(chunks.filter(c => c.type === "text").map(c => c.content).join(""), "Handled both results");
  assert.equal(chunks.filter(c => c.type === "tool_call_end").length, 0);
  assert.equal(chunks.at(-1)?.type, "done");
});
test("Codex streams text and reports completion only on a completed turn", async t => {
  const chunks = await collect(new CodexProvider(await fixture(t, "text")));
  assert.equal(chunks.filter(c => c.type === "text").map(c => c.content).join(""), "Hello");
  assert.deepEqual(chunks.at(-1)?.usage, { promptTokens: 12, completionTokens: 4, totalTokens: 16, reasoningTokens: 2 });
});
for (const mode of ["blank-lines", "bom"]) {
  test(`Codex accepts ${mode} framing without interrupting valid protocol messages`, async t => {
    const chunks = await collect(new CodexProvider(await fixture(t, mode)));
    assert.equal(chunks.filter(chunk => chunk.type === "text").map(chunk => chunk.content).join(""), "Hello");
    assert.equal(chunks.at(-1)?.type, "done");
    assert.ok(!chunks.some(chunk => chunk.type === "error"));
  });
}
for (const [mode, match] of [["invalid-json", /malformed JSON.*stdout/i], ["invalid-shape", /invalid JSON-RPC message.*stdout/i]] as const) {
  test(`Codex ${mode} fails precisely without exposing raw protocol contents`, async t => {
    const chunks = await collect(new CodexProvider(await fixture(t, mode)));
    assert.equal(chunks.at(-1)?.type, "error");
    assert.match(chunks.at(-1)!.content, match);
    assert.doesNotMatch(chunks.at(-1)!.content, /do-not-expose/);
    assert.ok(!chunks.some(chunk => chunk.type === "done"));
  });
}
test("Codex continuation applies new user steering and rebuilt world instructions", async t => {
  const controller = new AbortController(); t.after(() => controller.abort());
  const provider = new CodexProvider(await fixture(t, "steering"));
  await collect(provider, { signal: controller.signal });
  const chunks = await collect(provider, { signal: controller.signal, messages: [
    { role: "system", content: "Updated world instruction" }, params.messages[1]!,
    { role: "tool", tool_call_id: "call-1", content: "Read result" },
    { role: "tool", tool_call_id: "call-2", content: "Validation result" },
    { role: "user", content: "Prioritize the new instruction" },
  ] });
  assert.equal(chunks.filter(c => c.type === "text").map(c => c.content).join(""), "Used latest steering");
});
for (const [mode, match] of [["auth", /ChatGPT/], ["failed", /quota/], ["exit", /completed/], ["unknown", /unavailable tool/]] as const) {
  test(`Codex fails explicitly for ${mode} instead of completing`, async t => {
    const chunks = await collect(new CodexProvider(await fixture(t, mode)));
    assert.equal(chunks.at(-1)?.type, "error");
    assert.match(chunks.at(-1)!.content, match);
    assert.ok(!chunks.some(c => c.type === "done"));
  });
}
test("Codex times out and supports immediate cancellation", async t => {
  const command = await fixture(t, "timeout");
  const chunks = await collect(new CodexProvider(command, 100));
  assert.equal(chunks.at(-1)?.type, "error");
  assert.match(chunks.at(-1)!.content, /timed out/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => collect(new CodexProvider(command), { signal: controller.signal }), { name: "AbortError" });
});
test("stopping a pending Codex conversation prevents replaying its completed actions", async t => {
  const command = await fixture(t, "tools");
  const provider = new CodexProvider(command);
  const conversationId = "codex-test-stop-pending";
  await collect(provider, { conversationId });
  await stopCodexConversation(conversationId);
  const chunks = await collect(provider, { conversationId, messages: [...params.messages,
    { role: "tool", tool_call_id: "call-1", content: "Read result" },
    { role: "tool", tool_call_id: "call-2", content: "Validation result" },
  ] });
  assert.equal(chunks.at(-1)?.type, "error");
  assert.match(chunks.at(-1)!.content, /expired|stopped/);
  assert.ok(!chunks.some(c => c.type === "tool_call_end"));
});
test("cancellation terminates an active Codex turn", async t => {
  const provider = new CodexProvider(await fixture(t, "timeout"), 5000);
  const controller = new AbortController();
  const cancellation = setTimeout(() => controller.abort(), 80);
  try { await assert.rejects(() => collect(provider, { signal: controller.signal }), { name: "AbortError" }); }
  finally { clearTimeout(cancellation); }
});
test("a stale stop cannot cancel a newer Codex run in the same conversation", async t => {
  const command = await fixture(t, "tools");
  const oldController = new AbortController(), newController = new AbortController();
  t.after(() => { oldController.abort(); newController.abort(); });
  const conversationId = "codex-test-run-ownership";
  await collect(new CodexProvider(command), { conversationId, generationId: "old", signal: oldController.signal });
  const newer = new CodexProvider(command);
  const started = await collect(newer, { conversationId, generationId: "new", signal: newController.signal });
  assert.equal(started.filter(c => c.type === "tool_call_end").length, 2);
  await stopCodexConversation(conversationId, "old");
  const finished = await collect(newer, { conversationId, generationId: "new", signal: newController.signal, messages: [
    ...params.messages,
    { role: "tool", tool_call_id: "call-1", content: "Read result" },
    { role: "tool", tool_call_id: "call-2", content: "Validation result" },
  ] });
  assert.equal(finished.filter(c => c.type === "text").map(c => c.content).join(""), "Handled both results");
});
test("approval execution renews the pending Codex lease", async t => {
  const command = await fixture(t, "tools");
  const controller = new AbortController(); t.after(() => controller.abort());
  const conversationId = "codex-test-approval-lease";
  const provider = new CodexProvider(command, 150);
  await collect(provider, { conversationId, signal: controller.signal });
  assert.equal(leaseCodexConversation(conversationId), true);
  await new Promise(resolve => setTimeout(resolve, 200));
  const finished = await collect(provider, { conversationId, signal: controller.signal, messages: [...params.messages,
    { role: "tool", tool_call_id: "call-1", content: "Read result" },
    { role: "tool", tool_call_id: "call-2", content: "Validation result" },
  ] });
  assert.equal(finished.filter(c => c.type === "text").map(c => c.content).join(""), "Handled both results");
});


test("Codex images use an isolated native Sol 6.1 xhigh turn and return bytes", async t => {
  const result = await generateCodexImage({ command: await fixture(t, "image"), prompt: "A small gold star", imageKind: "sprite" });
  assert.equal(result.bytes.toString(), "image-bytes");
  assert.equal(result.model, "gpt-6.1-sol");
  assert.equal(result.reasoningEffort, "xhigh");
});
test("transparent general images are not forced onto an opaque background", async t => {
  const result = await generateCodexImage({ command: await fixture(t, "image-transparent-follow"), prompt: "A small circle with a transparent background", imageKind: "image", transparent: true });
  assert.equal(result.bytes.toString(), "image-bytes");
});
for (const [mode, message] of [["image-unsupported", /not available/], ["image-empty", /did not generate/], ["image-bad", /invalid image/], ["image-failed", /quota/]] as const) {
  test(`Codex image ${mode} fails without substituting another provider`, async t => {
    await assert.rejects(generateCodexImage({ command: await fixture(t, mode), prompt: "Gold star", imageKind: "image" }), message);
  });
}
test("NSFW image requests are rejected before the native image tool is enabled", async t => {
  await assert.rejects(generateCodexImage({ command: await fixture(t, "image-nsfw"), prompt: "NSFW image", imageKind: "image" }), /NSFW.*disabled/);
});

test("a text-only image helper answer retains its explanation in the job error", async t => {
  await assert.rejects(generateCodexImage({ command: await fixture(t, "image-explanation"), prompt: "Make her happy", imageKind: "sprite" }),
    /No image was saved.*referenced image was not attached/);
});
test("Codex image generation times out and honours active cancellation", async t => {
  const command = await fixture(t, "image-timeout");
  await assert.rejects(generateCodexImage({ command, timeoutMs: 100, prompt: "Gold star", imageKind: "image" }), /timed out/);
  const controller = new AbortController();
  const pending = generateCodexImage({ command, signal: controller.signal, prompt: "Gold star", imageKind: "image" });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /cancelled/);
});

test("Codex sends reference images to both the disabled checker and native image generator", async t => {
  const result = await generateCodexImage({ command: await fixture(t, "image-reference"), prompt: "Make this star blue", imageKind: "sprite", referenceImages: ["data:image/png;base64,cmVm"] });
  assert.equal(result.bytes.toString(), "image-bytes");
});
test("a safe prompt with an NSFW reference is refused before enabling image generation", async t => {
  await assert.rejects(generateCodexImage({ command: await fixture(t, "image-reference-nsfw"), prompt: "Copy the reference", imageKind: "image", referenceImages: ["data:image/png;base64,cmVm"] }), /Image generation is disabled for NSFW requests/);
});

test("Codex rejects an unavailable tool without executing it and lets the model recover", async t => {
  const chunks = await collect(new CodexProvider(await fixture(t, "unknown-recover")));
  assert.equal(chunks.filter(c => c.type === "text").map(c => c.content).join(""), "HelloRecovered unavailable tool");
  assert.equal(chunks.at(-1)?.type, "done");
  assert.ok(!chunks.some(c => c.type === "tool_call_end" || c.type === "error"));
});


test("independent Studio chats retain separate native Codex workers when one is stopped", async t => {
  const command=await fixture(t,"tools");
  const a="studio:qa:world:conversation-A",b="studio:qa:world:conversation-B";
  t.after(async()=>{await stopCodexConversation(a,"run-A");await stopCodexConversation(b,"run-B");});
  const [first,second]=await Promise.all([
    collect(new CodexProvider(command),{conversationId:a,generationId:"run-A"}),
    collect(new CodexProvider(command),{conversationId:b,generationId:"run-B"}),
  ]);
  assert.equal(first.filter(c=>c.type==="tool_call_end").length,2);
  assert.equal(second.filter(c=>c.type==="tool_call_end").length,2);
  await stopCodexConversation(a,"run-A");
  const continued=await collect(new CodexProvider(command),{conversationId:b,generationId:"run-B",messages:[
    ...params.messages,{role:"tool",tool_call_id:"call-1",content:"B read result"},{role:"tool",tool_call_id:"call-2",content:"B validation result"},
  ]});
  assert.equal(continued.filter(c=>c.type==="text").map(c=>c.content).join(""),"Handled both results");
  assert.equal(continued.at(-1)?.type,"done");
});
