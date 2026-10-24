import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
const read=(name:string)=>readFileSync(new URL('../../../../../interfaces/vn/'+name,import.meta.url),'utf8');
const root=read('index.tsx');
const hook='      {!characters.length && <TurnDetails key={`details:${message.id}:${message.activeSwipeIndex || 0}`} message={message} lines={sourceLines} />}\n';
const legacy=root.replace('import { TurnDetails } from "./turn-details";\n','').replace(hook,'');
const path=new URL('./vn-turn-details-upgrade.ts',import.meta.url);
const mod=existsSync(path)?await import('./vn-turn-details-upgrade'):null;
const helperPath=new URL('../../../../../interfaces/vn/turn-details.tsx',import.meta.url);
const helper=existsSync(helperPath)?read('turn-details.tsx'):'';
const importLine='import { TurnDetails } from "./turn-details";\n';
function assertStockBody(actual:string){assert.equal(actual.split(importLine).length,2);assert.equal(actual.replace(importLine,''),root.replace(importLine,''));}

test('known saved readers receive only the turn-detail hook/helper and preserve custom content',()=>{
 assert.ok(mod?.upgradeVnTurnDetailsFiles,'Guarded Turn details upgrade must exist');assert.ok(helper);
 const files={'index.tsx':legacy,'status-layout.tsx':'custom status','sprites.ts':'custom art','scenes.ts':'custom backgrounds','story.ts':'custom story'};
 const next=mod.upgradeVnTurnDetailsFiles(files,helper);assert.notEqual(next,files);assertStockBody(next['index.tsx']);assert.equal(next['turn-details.tsx'],helper);
 for(const key of ['status-layout.tsx','sprites.ts','scenes.ts','story.ts']as const)assert.equal(next[key],files[key]);assert.equal(files['index.tsx'],legacy);assert.equal(mod.upgradeVnTurnDetailsFiles(next,helper),next);
});
test('nested stock roots receive their adjacent helper without touching custom roots',()=>{
 assert.ok(mod);const files={'ui/reader.tsx':legacy,'ui/styles.ts':'custom styles','my.tsx':'custom layout'};const next=mod.upgradeVnTurnDetailsFiles(files,helper);assertStockBody(next['ui/reader.tsx']);assert.equal(next['ui/turn-details.tsx'],helper);assert.equal(next['ui/styles.ts'],'custom styles');assert.equal(next['my.tsx'],'custom layout');
});
test('custom log hooks, conflicting helpers and partial upgrades are preserved',()=>{
 assert.ok(mod);const cases:Record<string,string>[]=[
 {'index.tsx':legacy,'turn-details.tsx':'creator helper'},
 {'index.tsx':legacy.replace('data-turn-id={message.id}','data-custom-turn={message.id}')},
 {'index.tsx':legacy.replace('const renderedRows = React.useMemo(() => visible.map(({ message, lines, sourceLines }) => {','const renderedRows = buildCreatorRows(() => {')},
 {'index.tsx':legacy.replace('key={`${message.id}:${message.activeSwipeIndex || 0}`} text={swipe?.reasoningContent}','key={message.id} text={creatorThoughts}')},
 {'index.tsx':root},
 {'index.tsx':'custom UI'},
 ];for(const files of cases)assert.equal(mod.upgradeVnTurnDetailsFiles(files,helper),files);
});
