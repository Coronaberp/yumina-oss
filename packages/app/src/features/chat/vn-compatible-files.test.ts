import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {transform} from 'sucrase';
import {bundleAndCompile} from '../studio/lib/tsx-bundler';
import {priorVnCompatibility} from './test-fixtures/vn-compatibility-before';
import {upgradeVnAutoFiles} from './vn-auto-upgrade';
import type {VnCompatibilitySources} from './vn-compatible-files';
const folder=new URL('../../../../../interfaces/vn/',import.meta.url);
const read=(name:string)=>readFileSync(new URL(name,folder),'utf8');

/** Vite raw-import boundary for this data-only registry; no app/browser/build. */
function loadSourceRegistry():VnCompatibilitySources{
 const url=new URL('./vn-compatibility-sources.ts',import.meta.url);
 assert.ok(existsSync(url),'The canonical source registry must exist');
 const source=readFileSync(url,'utf8').replace(/^import (\w+) from ["']([^"']+\?raw)["'];$/gm,(_line,name:string,specifier:string)=>
  `const ${name}=${JSON.stringify(readFileSync(new URL(specifier.slice(0,-4),url),'utf8'))};`);
 const code=transform(source,{transforms:['typescript','imports']}).code;
 assert.doesNotMatch(code,/require\(/,'The source registry contains only local raw data and erased types');
 const module={exports:{} as {vnCompatibilitySources?:VnCompatibilitySources}};
 new Function('module','exports',code)(module,module.exports);
 assert.ok(module.exports.vnCompatibilitySources);return module.exports.vnCompatibilitySources;
}
function legacyRoot(current:string):string{
 const begin=current.indexOf('  useAutoReading({'),end=current.indexOf('\n\n  React.useEffect(() => {\n    function keydown',begin);
 assert.ok(begin>0&&end>begin,'Known stock Auto source fixture');
 const oldAuto=`  React.useEffect(() => {
    if (!auto || panel || viewerOpen || hidden || end || waiting || api.isStreaming) return;
    const timer = setTimeout(() => setCursor({ turn, index: index + 1 }), Math.max(autoDelay, (line?.text.length || 0) * 35));
    return () => clearTimeout(timer);
  }, [auto, panel, viewerOpen, hidden, end, waiting, api.isStreaming, turn, index, autoDelay, line?.text]);`;
 return (current.slice(0,begin)+oldAuto+current.slice(end))
  .replace('import { useAutoReading } from "./auto-reading";\n','')
  .replace('function movePage(direction, manual = true)','function movePage(direction)')
  .replace('if (manual) setAuto(false);','setAuto(false);')
  .replace('      setAuto(false);\n      const text = event.target.closest(".vn-text");','      const text = event.target.closest(".vn-text");')
  .replace('onClick={() => setAuto(current => !current)}','onClick={() => setAuto(!auto)}')
  .replace('import { ModelRoutingDetails } from "./model-routing-details";\n','')
  .replace('function Menu({ api, currentMessage, onClose','function Menu({ api, onClose')
  .replace('            <ModelRoutingDetails selectedModel={api.selectedModel} message={currentMessage} />\n','')
  .replace('<Menu api={api} currentMessage={currentMessage} onClose=','<Menu api={api} onClose=')
  .replace('import { TurnDetails } from "./turn-details";\n','')
  .replace('      {!characters.length && <TurnDetails key={`details:${message.id}:${message.activeSwipeIndex || 0}`} message={message} lines={sourceLines} />}\n','');
}

test('stock compatibility extraction preserves the complete prior pipeline',async t=>{
 const path=new URL('./vn-compatible-files.ts',import.meta.url);assert.ok(existsSync(path),'The ordered dedicated compatibility helper must exist');
 const {upgradeCompatibleVnFiles}=await import('./vn-compatible-files');
 const sources=loadSourceRegistry();
 const canonical:Record<string,string>=Object.fromEntries(readdirSync(folder).filter(name=>/\.(tsx?|jsx?)$/.test(name)).map(name=>[name,read(name)]));
 const legacy:Record<string,string>={...canonical,'index.tsx':legacyRoot(canonical['index.tsx'])};
 for(const name of ['auto-reading.ts','model-routing-details.tsx','turn-details.tsx'])delete legacy[name];
 await t.test('production registry supplies each exact canonical source',()=>{
  const names={loading:'loading-status.tsx',reading:'reading.ts',characterVisibility:'character-visibility.ts',portrait:'portrait-ref.ts',angle:'angle-markup.ts',characterViewer:'character-viewer.tsx',auto:'auto-reading.ts',npcDisplayName:'npc-display-name.ts',modelRouting:'model-routing-details.tsx',turnDetails:'turn-details.tsx',checkpoint:'checkpoints.tsx'}as const;
  for(const[key,name]of Object.entries(names))assert.equal(sources[key as keyof typeof names],read(name));
  assert.deepEqual(sources.text,Object.fromEntries(['text-settings.tsx','text-defaults.ts','text-style.ts','menu-layout.ts'].map(name=>[name,read(name)])));
 });
 const oldReaderStart=legacy['index.tsx'].indexOf('  const scrollPassage = usePassageReading(');
 const oldReaderEnd=legacy['index.tsx'].indexOf('\n\n  function movePage(',oldReaderStart);
 assert.ok(oldReaderStart>0&&oldReaderEnd>oldReaderStart);
 const oldSize='<label className="vn-setting">Dialogue size<select value={settings.textSize} onChange={e => onSetting("textSize", Number(e.target.value))}><option value={23}>Small</option><option value={27}>Default</option><option value={32}>Large</option></select></label>';
 const oldest:Record<string,string>={...legacy,'index.tsx':(legacy['index.tsx'].slice(0,oldReaderStart)+'  function advance() {\n    if (hidden) { setHidden(false); return; }\n    movePage(1);\n  }'+legacy['index.tsx'].slice(oldReaderEnd))
  .replace('import { usePassageReading } from "./reading";\n','')
  .replace('import { VnTextSettings, VnTextStyle } from "./text-settings";\n','')
  .replace('<VnTextSettings api={api} onResetLegacy={() => onSetting("textSize", 27)} />',oldSize)
  .replace('    <VnTextStyle api={api} />\n','')};
 for(const name of ['reading.ts','text-settings.tsx','text-style.ts','menu-layout.ts'])delete oldest[name];
 const nested=Object.fromEntries(Object.entries(legacy).map(([name,text])=>['ui/'+name,text]));
 const cases:Array<{name:string;files:Record<string,string>;entry:string;compile:boolean;preserve?:string[];expectedHooks?:string[]}>= [
  {name:'current canonical reader',files:canonical,entry:'index.tsx',compile:true},
  {name:'legacy stock reader',files:legacy,entry:'index.tsx',compile:true},
  {name:'older reading/text prerequisites before remaining polish',files:oldest,entry:'index.tsx',compile:true,expectedHooks:['  useAutoReading({','if (scrollPassage()) return;','<VnTextSettings api={api}']},
  {name:'already upgraded Auto with pending remaining polish',files:upgradeVnAutoFiles(legacy,sources.auto),entry:'index.tsx',compile:true},
  {name:'nested reader and authored wrapper',files:{...nested,'index.tsx':'import Reader from "./ui/index";export default Reader;','creator.ts':'export const creatorNote="keep";'},entry:'index.tsx',compile:true,preserve:['index.tsx','creator.ts']},
  {name:'composed root with legacy user reader',files:{...legacy,'index.tsx':'import Reader from "./__user-root";export default Reader;','__user-root.tsx':legacy['index.tsx']},entry:'index.tsx',compile:true,preserve:['index.tsx']},
  {name:'custom Auto pacing with stock log and menu',files:{...legacy,'index.tsx':legacy['index.tsx'].replace('Math.max(autoDelay, (line?.text.length || 0) * 35)','creatorAutoDelay(line)')},entry:'index.tsx',compile:true},
  {name:'conflicting custom helper preserved',files:{...legacy,'auto-reading.ts':'export function useAutoReading() { return "creator"; }'},entry:'index.tsx',compile:true,preserve:['auto-reading.ts']},
  {name:'partially integrated Auto preserves its author responsibility',files:{...legacy,'index.tsx':'import { useAutoReading } from "./auto-reading";\n'+legacy['index.tsx'],'auto-reading.ts':'export function useAutoReading() { return "creator"; }'},entry:'index.tsx',compile:true,preserve:['auto-reading.ts']},
  {name:'unknown custom cut and unrelated content',files:{'index.tsx':'export default function Story(){return <div className="creator-story">Authored story</div>;}','styles.ts':'export const theme="custom colors";','scenes.ts':'export const scenes={custom:"authored-art"};','notes.md':'Do not change custom content'},entry:'index.tsx',compile:true,preserve:['index.tsx','styles.ts','scenes.ts','notes.md']},
 ];
 for(const fixture of cases)await t.test(fixture.name,()=>{
  const before=JSON.stringify(fixture.files),expected=priorVnCompatibility(fixture.files,undefined,sources),actual=upgradeCompatibleVnFiles(fixture.files,undefined,sources);
  assert.deepEqual(Object.keys(actual),Object.keys(expected),'File insertion order remains identical');assert.deepEqual(actual,expected,'Every resulting file is byte-for-byte equal');
  assert.equal(actual===fixture.files,expected===fixture.files,'No-op reference identity matches the prior pipeline');assert.equal(JSON.stringify(fixture.files),before,'Input files are immutable');
  for(const name of fixture.preserve||[])assert.equal(actual[name],fixture.files[name],'Preserve '+name);
  for(const hook of fixture.expectedHooks||[])assert.ok(actual[fixture.entry].includes(hook),'Prerequisite pipeline activated '+hook);
  assert.equal(upgradeCompatibleVnFiles(actual,undefined,sources),actual,'Second application retains identity');
  if(fixture.compile){const result=bundleAndCompile({files:actual,entryFile:fixture.entry},()=>({}as never));assert.equal(result.error,null,result.error??undefined);assert.ok(result.Component);}
 });
 await t.test('classic bypass does not touch even recognized old source',()=>{assert.equal(upgradeCompatibleVnFiles(legacy,'classic',sources),legacy);assert.equal(priorVnCompatibility(legacy,'classic',sources),legacy)});
 await t.test('WorldRenderer retains gallery adaptation, classic boundary and memo dependencies',()=>{
  const host=readFileSync(new URL('./world-renderer.tsx',import.meta.url),'utf8');assert.match(host,/const adapted = adaptOncinGalleryFiles\(worldId, incomingFiles\);\s*if \(!adapted \|\| interfaceId === "classic"\) return adapted;\s*return upgradeCompatibleVnFiles\(adapted, interfaceId, vnCompatibilitySources\);\s*}, \[worldId, incomingFiles, interfaceId\]\)/);
 });
});
