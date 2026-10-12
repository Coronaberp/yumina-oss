import { pythonRepr } from './block.js';
/** Preserve Python json.loads float identity for Pydantic diagnostics. */
export class PythonFloat { constructor(readonly value:number) {} }
export function pythonJsonRepr(value:unknown):string {
 if(value instanceof PythonFloat){if(Number.isNaN(value.value))return 'nan';if(value.value===Infinity)return 'inf';if(value.value===-Infinity)return '-inf';return Number.isInteger(value.value)?value.value.toString()+'.0':String(value.value);}
 if(Array.isArray(value))return '['+value.map(pythonJsonRepr).join(', ')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).map(([k,v])=>pythonRepr(k)+': '+pythonJsonRepr(v)).join(', ')+'}';
 return pythonRepr(value);
}
/** JSON scanner mirrors Python's strict decoder errors (used verbatim in retry prompts). */
export function parsePythonJson(text:string):unknown {
 let pos=0;
 function error(message:string,index=pos):never {const prefix=text.slice(0,index),char=Array.from(prefix).length,line=prefix.split('\n').length,last=prefix.lastIndexOf('\n'),column=Array.from(prefix.slice(last+1)).length+1;throw new Error(`${message}: line ${line} column ${column} (char ${char})`);}
 function whitespace(){while(/[ \t\r\n]/.test(text[pos]??'')&&pos<text.length)pos++;}
 function string():string {
  const start=pos++;
  while(pos<text.length){const c=text[pos++];if(c==='"')return JSON.parse(text.slice(start,pos)) as string;
   if(c==='\\'){const escapePos=pos,escape=text[pos++];if(escape==='u'){if(!/^[\da-fA-F]{4}$/.test(text.slice(pos,pos+4)))error('Invalid \\uXXXX escape',escapePos);pos+=4;}else if(!escape||!('"\\/bfnrt'.includes(escape)))error('Invalid \\escape',escapePos-1);}
   else if(c&&c.charCodeAt(0)<32)error('Invalid control character at',pos-1);
  }
  error('Unterminated string starting at',start);
 }
 function value():unknown {
  whitespace();const c=text[pos];
  if(c==='"')return string();
  if(c==='{'){pos++;whitespace();const result:Record<string,unknown>={};if(text[pos]==='}'){pos++;return result;}while(true){if(text[pos]!=='"')error('Expecting property name enclosed in double quotes');const key=string();whitespace();if(text[pos]!==':')error("Expecting ':' delimiter");pos++;const child=value();Object.defineProperty(result,key,{value:child,enumerable:true,configurable:true,writable:true});whitespace();if(text[pos]==='}'){pos++;return result;}if(text[pos]!==',')error("Expecting ',' delimiter");const comma=pos++;whitespace();if(text[pos]==='}')error('Illegal trailing comma before end of object',comma);}}
  if(c==='['){pos++;whitespace();const result:unknown[]=[];if(text[pos]===']'){pos++;return result;}while(true){result.push(value());whitespace();if(text[pos]===']'){pos++;return result;}if(text[pos]!==',')error("Expecting ',' delimiter");const comma=pos++;whitespace();if(text[pos]===']')error('Illegal trailing comma before end of array',comma);}}
  for(const [token,result] of [['true',true],['false',false],['null',null],['NaN',new PythonFloat(NaN)],['Infinity',new PythonFloat(Infinity)],['-Infinity',new PythonFloat(-Infinity)]] as const){if(text.startsWith(token,pos)){pos+=token.length;return result;}}
  const number=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(pos));
  if(number){pos+=number[0].length;const result=Number(number[0]);return /[.eE]/.test(number[0])?new PythonFloat(result):result;}
  error('Expecting value');
 }
 if(text[0]==='\uFEFF')error('Unexpected UTF-8 BOM (decode using utf-8-sig)',0);
 const out=value();whitespace();if(pos<text.length)error('Extra data');return out;
}
