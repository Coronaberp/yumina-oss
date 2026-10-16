import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const memory=new Map<string,string>();
const storage={getItem:(key:string)=>memory.get(key)??null,setItem:(key:string,value:string)=>void memory.set(key,value),removeItem:(key:string)=>void memory.delete(key)};
Object.defineProperty(globalThis,"localStorage",{configurable:true,value:storage});
Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:storage});
const root=fileURLToPath(new URL("../..",import.meta.url));
const vite=await createServer({root,configFile:false,envFile:false,appType:"custom",logLevel:"silent",server:{middlewareMode:true,watch:null},resolve:{alias:{"@":`${root}/src`,"@yumina/engine":`${root}/../engine/src/index.ts`}}});
const {useStudioStore:store}=await vite.ssrLoadModule("/src/stores/studio.ts") as typeof import("./studio");
after(async()=>{await vite.close();});
test("detaching and opening another chat closes only the local stream; Stop remains explicit",async()=>{
  const original=globalThis.fetch,calls:string[]=[];
  globalThis.fetch=async input=>{calls.push(String(input));return new Response(JSON.stringify({ok:true}),{status:200});};
  try{
    const controller=new AbortController();
    store.setState({chatWorldId:"world",chatConversationId:"A"});
    store.setState({_currentRunId:"run-A",_agentAbortController:controller,isAgentWorking:true,isChatStreaming:true,chatMessages:[]});
    store.getState().detachAgent();
    assert.equal(controller.signal.aborted,true);assert.equal(store.getState().isAgentWorking,false);assert.deepEqual(calls,[]);
    store.setState({chatWorldId:"world",chatConversationId:"B"});
    store.setState({_currentRunId:"run-B",_agentAbortController:new AbortController(),isAgentWorking:true});
    store.getState().clearChat();assert.deepEqual(calls,[]);
    store.setState({chatWorldId:"world",chatConversationId:"A"});
    store.setState({_currentRunId:"run-A",_agentAbortController:new AbortController(),isAgentWorking:true});
    store.getState().stopAgent();
    assert.deepEqual(calls,["/api/studio/world/agent/stop"]);
  }finally{globalThis.fetch=original;}
});
