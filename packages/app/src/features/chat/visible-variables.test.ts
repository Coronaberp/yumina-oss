import assert from "node:assert/strict";
import test from "node:test";
import { visibleSessionVariables } from "./visible-variables";
import type { GameState } from "@yumina/engine";

test("current public variables respect internal, enabled, condition, greeting and runtime toggle gates", () => {
  const base = { type:"number", defaultValue:0, name:"Stat" };
  const schema = { id:"w",version:"2",name:"World",variables:[
    { ...base,id:"public" }, { ...base,id:"private",internal:true },
    { ...base,id:"disabled",enabled:false }, { ...base,id:"toggledOff" },
    { ...base,id:"toggledOn",enabled:false },
    { ...base,id:"wrongOpening",activation:{mode:"greeting",greetingIds:["other"]} },
    { ...base,id:"rightOpening",activation:{mode:"greeting",greetingIds:["g1"]} },
    { ...base,id:"conditional",activation:{mode:"conditions",conditions:[{variableId:"public",operator:">",value:20}]} },
  ],entries:[],rules:[],components:[] };
  const state = { worldId:"w",variables:{public:15,private:99,disabled:10,toggledOff:10,toggledOn:30,wrongOpening:50,rightOpening:20,conditional:88,unknown:"HIDDEN_UNKNOWN"},turnCount:0,metadata:{},activeGreetingId:"g1",ruleState:{toggledVariables:{toggledOff:false,toggledOn:true}} } as unknown as GameState;
  assert.deepEqual(visibleSessionVariables({world:{schema},state}),{public:15,toggledOn:30,rightOpening:20});
  assert.deepEqual(visibleSessionVariables({state}),{});
});
