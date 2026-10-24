import assert from "node:assert/strict";
import test from "node:test";
import { variableSchema, type WorldDefinition } from "@yumina/engine";
import { executeApplyChanges, executeReadEntities, toolCallsToSchemaChanges } from "./tool-executor.js";
import { STUDIO_TOOLS } from "./tools.js";
import { resolveContext } from "./context-resolver.js";
import { buildSystemPrompt } from "./system-prompt.js";

function world(vn=true):WorldDefinition{
  return {id:"variable-agent-fixture",version:"19.0.0",name:"Variable fixture",description:"",author:"test",entries:[],variables:[],rules:[],reactions:[],components:[],audioTracks:[],customUI:[],
    rootComponent:{id:"root",name:"Fixture",interfaceId:vn?"vn":"classic",entryFile:"index.tsx",files:{"index.tsx":"export default function World(){return <section/>;}"},updatedAt:"before"},
    settings:{maxTokens:4000,temperature:1}} as WorldDefinition;
}
function write(base:WorldDefinition,args:Record<string,unknown>){
  const parsed=toolCallsToSchemaChanges([{id:"variable-call",function:{name:"write_variable",arguments:JSON.stringify(args)}}],base);
  assert.ok(parsed[0]?.change,parsed[0]?.error);
  return executeApplyChanges(base,[parsed[0].change]);
}
test("agent creates VN Lists and Groups with correct defaults and structured nested data",()=>{
  for(const [type,defaultValue] of [["list",[]],["group",{}]] as const){
    const result=write(world(),{id:"data",name:"Data",type});
    assert.equal(result.success,true,JSON.stringify(result.results));
    assert.equal(result.world.variables[0]!.type,"json");assert.deepEqual(result.world.variables[0]!.defaultValue,defaultValue);
  }
  const nested=JSON.parse('{"nested":{"flag":false,"zero":0,"text":"","nil":null,"list":[]},"literal.key":1,"__proto__":{"safe":true}}');
  for(const defaultValue of [nested,JSON.stringify(nested)]){
    const result=write(world(),{id:"profile",type:"group",defaultValue});
    assert.equal(result.success,true);assert.deepEqual(result.world.variables[0]!.defaultValue,nested);
    assert.equal(({} as {safe?:boolean}).safe,undefined);
  }
});
test("agent writes one text choice plus valid options, retained by persistence and read tools",()=>{
  const base=world(),original=JSON.stringify(base);
  for(const type of ["choice","string",undefined]){
    const result=write(base,{id:"state",name:"State",type,defaultValue:"1",enumValues:["1","false",""]});
    assert.equal(result.success,true,JSON.stringify(result.results));
    const variable=variableSchema.parse(result.world.variables[0]);
    assert.equal(variable.type,"string");assert.equal(variable.defaultValue,"1");assert.deepEqual(variable.enumValues,["1","false",""]);
    const read=executeReadEntities(result.world,["state"]).results.state as Record<string,unknown>;
    assert.deepEqual(read.enumValues,variable.enumValues);
  }
  assert.equal(JSON.stringify(base),original);
});
test("agent upserts and metadata-only updates preserve current choices and starting values",()=>{
  const base=world();base.variables=[{id:"state",name:"State",type:"string",defaultValue:"Neutral",enumValues:["Neutral","Friendly"],behaviorRules:"Keep rules",aiAccess:"read",activation:{mode:"manual"},enabled:false}];
  const named=write(base,{id:"state",name:"Renamed"});
  assert.deepEqual(named.world.variables[0],{...base.variables[0],name:"Renamed"});
  const choices=write(base,{id:"state",enumValues:["Friendly","Bonded"]});
  assert.equal(choices.success,true);assert.equal(choices.world.variables[0]!.defaultValue,"Neutral");
  assert.deepEqual(choices.world.variables[0]!.enumValues,["Friendly","Bonded"]);
  const plain=write(base,{id:"state",clearOptions:true});assert.equal(plain.world.variables[0]!.enumValues,undefined);assert.equal(plain.world.variables[0]!.defaultValue,"Neutral");
});
test("invalid agent collection and option writes are rejected before any variable mutation",()=>{
  const base=world();base.variables=[{id:"state",name:"Keep name",type:"string",defaultValue:"Neutral",enumValues:["Neutral","Friendly"]}];
  const invalid=[{type:"list",defaultValue:{}},{type:"group",defaultValue:[]},{type:"list"},{type:"choice",defaultValue:["Neutral","Friendly"]},
    {enumValues:[42]},{enumValues:null},{enumValues:["Same","Same"]},{enumValues:["x".repeat(1001)]},{enumValues:Array.from({length:501},(_,i)=>String(i))},
    {clearOptions:"yes"},{clearOptions:true,enumValues:[]},{clearOptions:true,type:"choice"},
    ...["constructor","__proto__","toString"].map(type=>({type}))];
  for(const data of invalid){
    const result=write(base,{id:"state",name:"Must not land",...data});
    assert.equal(result.success,false,JSON.stringify(data));assert.deepEqual(result.world.variables,base.variables);
  }
});
test("agent matching-shape edits preserve defaults, empty options and authoring drafts",()=>{
  for(const [type,value] of [["list",["Key"]],["group",{met:{blair:false}}]] as const){
    const base=world();base.variables=[{id:"data",name:"Data",type:"json",defaultValue:JSON.parse(JSON.stringify(value)),defaultValueText:"unfinished draft"}];
    const result=write(base,{id:"data",type,name:"Renamed"});
    assert.equal(result.success,true);assert.deepEqual(result.world.variables[0]!.defaultValue,value);
    assert.equal(result.world.variables[0]!.defaultValueText,"unfinished draft");
  }
  const base=world();base.variables=[{id:"state",name:"State",type:"string",defaultValue:"Keep",defaultValueText:"kept",enumValues:["Keep"]}];
  for(const data of [{enumValues:[]},{clearOptions:false}]){
    const result=write(base,{id:"state",...data});
    assert.equal(result.success,true);assert.equal(result.world.variables[0]!.defaultValue,"Keep");
    assert.equal(result.world.variables[0]!.defaultValueText,"kept");
    assert.deepEqual(result.world.variables[0]!.enumValues,"enumValues" in data ? [] : ["Keep"]);
  }
  const created=write(world(),{id:"state",type:"choice",enumValues:["constructor","__proto__","toString"]});
  assert.equal(created.success,true);assert.equal(created.world.variables[0]!.defaultValue,"");
  assert.deepEqual(created.world.variables[0]!.enumValues,["constructor","__proto__","toString"]);
});
test("one invalid variable write rolls back the complete batch without altering source or input",()=>{
  const base=world(),original=JSON.stringify(base);
  const result=executeApplyChanges(base,[
    {action:"create",entityType:"variable",id:"inventory",data:{type:"list",defaultValue:["Key"]}},
    {action:"create",entityType:"variable",id:"state",data:{type:"choice",enumValues:[42]}},
  ]);
  assert.equal(result.success,false);assert.equal(result.world,base);assert.equal(JSON.stringify(base),original);
});
test("agent replacements clear incompatible choices and stale JSON authoring text",()=>{
  const base=world();base.variables=[{id:"data",name:"Data",type:"json",defaultValue:[],defaultValueText:"[unfinished"}];
  const list=write(base,{id:"data",type:"list",defaultValue:["Neutral","Friendly"]});
  assert.equal(list.success,true);assert.equal(list.world.variables[0]!.defaultValueText,undefined);
  const choice=write(list.world,{id:"data",type:"choice",defaultValue:"Friendly",enumValues:["Neutral","Friendly"]});
  assert.equal(choice.success,true);assert.equal(choice.world.variables[0]!.defaultValue,"Friendly");
  const number=write(choice.world,{id:"data",type:"number",defaultValue:3});
  assert.equal(number.world.variables[0]!.enumValues,undefined);assert.equal(number.world.variables[0]!.defaultValue,3);
});
test("agent receives VN data instructions and option inventory without changing Chat coercion",async()=>{
  const base=world();base.variables=[{id:"state",name:"State",type:"string",defaultValue:"Neutral",enumValues:["Neutral","Friendly"]}];
  const context=await resolveContext(base,"Set valid relationship options",{userId:"test-user",contextWindow:120000});
  assert.match(context.inventory,/enumValues.*Neutral.*Friendly/);
  const prompt=buildSystemPrompt(context).static;
  assert.match(prompt,/VN variable data types/);assert.match(prompt,/write_variable/);assert.match(prompt,/enumValues/);
  const tool=STUDIO_TOOLS.find(tool=>tool.function.name==="write_variable")!.function.parameters as {properties:{type:{enum:string[]};enumValues:unknown}};
  for(const type of ["list","group","choice"])assert.ok(tool.properties.type.enum.includes(type));
  assert.ok(tool.properties.enumValues);
  const chat=write(world(false),{id:"hp",type:"number",defaultValue:"37"});
  assert.equal(chat.success,true);assert.equal(chat.world.variables[0]!.defaultValue,37);
  const chatList=write(world(false),{id:"inventory",type:"list",defaultValue:'["Key"]'});
  assert.equal(chatList.success,true);assert.deepEqual(chatList.world.variables[0]!.defaultValue,["Key"]);
  const blocked=write(world(false),{id:"state",type:"choice",defaultValue:"Neutral",enumValues:["Neutral"]});
  assert.equal(blocked.success,false);assert.deepEqual(blocked.world.variables,[]);
});
