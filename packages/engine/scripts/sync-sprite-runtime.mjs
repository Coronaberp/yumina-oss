import { readFileSync, writeFileSync } from 'node:fs';
const source = new URL('../../../interfaces/vn/', import.meta.url);
const baseText = readFileSync(new URL('../src/world/sprite-runtime-upgrade-bases.generated.ts',import.meta.url),'utf8');
const bases = JSON.parse(baseText.slice(baseText.indexOf('= ') + 2).replace(/;\s*$/, ''));
const templates = Object.fromEntries(Object.keys(bases).map(file => [file,readFileSync(new URL(file,source),'utf8')]));
const target = new URL('../src/world/sprite-runtime-templates.generated.ts',import.meta.url);
const content = '// Generated from interfaces/vn by sync-sprite-runtime.mjs; do not edit.\nexport const spriteRuntimeTemplates: Record<string,string> = ' + JSON.stringify(templates,null,2) + ';\n';
let previous;try{previous=readFileSync(target,'utf8');}catch{}
if(previous!==content)writeFileSync(target,content);
