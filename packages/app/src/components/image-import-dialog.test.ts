import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { act, createElement, type ComponentType, type ReactNode } from "react";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";

test("pasted stills crop before import; GIF/WebP animation bypasses crop; text paste is preserved", async () => {
  const dom = new JSDOM('<div id="root"></div>',{url:'https://yumina.test'});
  const globals = {window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true};
  const previous = new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for (const [key,value] of Object.entries(globals)) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const {createRoot} = await import('react-dom/client');
  const require = createRequire(import.meta.url);
  let skipCrop = false, imported = 0, prepared = 0, closed = 0, owner = 'alice';
  const wrapper = ({children,...props}:{children?:ReactNode;[key:string]:unknown})=>{const rest={...props};for(const key of ['open','onOpenChange','portalContainer','overlayClassName','onEscapeKeyDown'])delete rest[key];return createElement('div',rest,children);};
  const mocks: Record<string,unknown> = {
    '@/lib/auth-client':{useSession:()=>({data:{user:{id:owner}},isPending:false})},
    'react-i18next':{useTranslation:()=>({t:(key:string)=>key})},
    '@/components/ui/dialog':{Dialog:wrapper,DialogContent:wrapper,DialogHeader:wrapper,DialogTitle:wrapper,DialogDescription:wrapper},
    '@/lib/clipboard-image':{getImageFilesFromTransfer:(data:{files?:File[]})=>data?.files??[]},
    '@/lib/image-import':{MAX_IMAGE_IMPORT_BYTES:20*1024*1024,prepareImportedImage:async(file:File)=>{prepared++;return {file,skipCrop};}},
    '@/features/editor/components/sprite-crop-dialog':{SpriteCropDialog:({file,onConfirm}:{file:File;onConfirm:(file:File)=>void})=>createElement('button',{id:'crop-confirm',onClick:()=>onConfirm(file)},'confirm freeform crop')},
  };
  const module={exports:{} as {ImageImportDialog:ComponentType<{onImport:(files:File[])=>void;onClose:()=>void;crop:"freeform";preserveOriginal:boolean}>}};
  const source=readFileSync(new URL('./image-import-dialog.tsx',import.meta.url),'utf8').replace('import.meta.env.VITE_API_URL','""');
  new Function('require','module','exports',transform(source,{transforms:['typescript','jsx','imports'],jsxRuntime:'automatic'}).code)((id:string)=>mocks[id]??require(id),module,module.exports);
  const root=createRoot(dom.window.document.getElementById('root')!);
  const file=new File(['raster'],'happy.webp',{type:'image/webp'});
  let objectUrls=0;
  const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
  URL.createObjectURL=()=>`blob:test-${++objectUrls}`;URL.revokeObjectURL=()=>{};
  const paste=async(files:File[])=>{
    const event=new dom.window.Event('paste',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'clipboardData',{value:{files}});
    await act(async()=>{dom.window.document.querySelector('[aria-label="imageImport.paste"]')!.dispatchEvent(event);});
    return event;
  };
  try {
    const render=async()=>{await act(async()=>root.render(createElement(module.exports.ImageImportDialog,{key:String(imported),crop:"freeform",preserveOriginal:false,onImport:()=>{imported++;},onClose:()=>{closed++;}})));};
    await render();
    assert.equal((await paste([])).defaultPrevented,false);assert.equal(prepared,0);
    assert.equal((await paste([file])).defaultPrevented,true);assert.equal(imported,0);
    assert.ok(dom.window.document.getElementById('crop-confirm'));
    await act(async()=>{dom.window.document.getElementById('crop-confirm')!.click();});assert.equal(imported,1);
    skipCrop=true;await render();await paste([file]);assert.equal(imported,2);
    assert.equal(dom.window.document.getElementById('crop-confirm'),null);
    skipCrop=false;await render();await paste([file]);assert.ok(dom.window.document.getElementById('crop-confirm'));
    owner='bob';await render();assert.ok(closed>0);assert.equal(imported,2,'account change cancels the pending crop without importing');
  } finally {
    await act(async()=>root.unmount());URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;dom.window.close();
    for(const[key,value]of previous){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
  }
});
