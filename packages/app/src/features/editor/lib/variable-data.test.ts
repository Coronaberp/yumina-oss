import assert from "node:assert/strict";
import test from "node:test";
import { variableSchema } from "../../../../../engine/src/world/schema";
import { variableDataType, variableTypeUpdate, listToChoices, authoredVariableChoices } from "./variable-data";

test("List and Group types store collections; text choices store one string", () => {
  assert.equal(variableDataType({type:"json",defaultValue:[]}), "list");
  assert.equal(variableDataType({type:"json",defaultValue:{}}), "group");
  assert.deepEqual(variableTypeUpdate("list"), {type:"json",defaultValue:[],defaultValueText:undefined,enumValues:undefined});
  assert.deepEqual(variableTypeUpdate("choice"), {type:"string",defaultValue:"",defaultValueText:undefined,enumValues:[]});
  const current={id:"state",name:"State",type:"string" as const,defaultValue:"Neutral"};
  assert.equal(variableTypeUpdate("choice",current).defaultValue,"Neutral");
  assert.deepEqual(variableTypeUpdate("choice",current).enumValues,["Neutral"]);
  assert.equal(variableTypeUpdate("string",{...current,enumValues:["Neutral","Friendly"]}).defaultValue,"Neutral");
  const long={...current,defaultValue:"x".repeat(1001)};
  assert.equal(variableTypeUpdate("choice",long).defaultValue,long.defaultValue);
  assert.deepEqual(variableTypeUpdate("choice",long).enumValues,[]);
});
test("choice suggestions read exact authored ladders and reject conflicting definitions",()=>{
  const reaction=(labels:string[])=>({then:[{event:{type:"progression:resolve",ladders:{relationship:labels.map(label=>({label}))},tracks:[{stateVariableId:"state",ladder:"relationship"}]}}]});
  assert.deepEqual({...authoredVariableChoices([reaction(["Neutral","Friendly"])])},{state:["Neutral","Friendly"]});
  assert.deepEqual({...authoredVariableChoices([reaction(["Neutral","Friendly"]),reaction(["Wary","Neutral"])])},{});
  assert.deepEqual({...authoredVariableChoices([{description:"Allowed: A, B",then:[]}])},{});
});
test("explicit list conversion preserves ordered distinct choices and chosen start", () => {
  assert.deepEqual(listToChoices(["Wary","Neutral","Friendly","Neutral"], "Neutral"), {type:"string",defaultValue:"Neutral",enumValues:["Wary","Neutral","Friendly"],defaultValueText:undefined});
  assert.equal(listToChoices(["Neutral",2],"Neutral"),null);
  assert.equal(listToChoices(["Neutral"],"missing"),null);
  const stored=variableSchema.parse({id:"state",name:"State",...listToChoices(["Neutral","Friendly"],"Neutral")});
  assert.deepEqual(stored.enumValues,["Neutral","Friendly"]);
  assert.equal(variableDataType(stored),"choice");
});
