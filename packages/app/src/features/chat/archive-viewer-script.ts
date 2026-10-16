/** Standalone browser code: no app runtime, network requests or dependencies. */
export const archiveViewerScript = String.raw`(() => {
  'use strict';
  const data = JSON.parse(document.getElementById('yumina-export').textContent);
  const byId = new Map(data.participants.map(p => [p.id, p]));
  const messages = data.messages.filter(m => m.role !== 'system');
  const sourceIndex = new Map(messages.map((m,i) => [m.id,i]));
  const rows = data.display.length ? data.display : messages.map((m,i) => ({messageId:m.id,speakerId:m.role==='user'?'player':'assistant',kind:m.role==='user'?'choice':'dialogue',text:m.content,turn:i+1}));
  const groups = new Map();
  rows.forEach(r => {if(!groups.has(r.messageId)) groups.set(r.messageId,[]);groups.get(r.messageId).push(r);});
  const el = id => document.getElementById(id);
  const node = (tag,text,className) => {const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;};
  el('title').textContent = data.session.name || data.world.name;
  el('meta').textContent = data.world.name + ' · ' + messages.length + ' messages · Exported ' + new Date(data.exportedAt).toLocaleString();
  el('save-kind').textContent = data.mode === 'full-save' ? 'Full save: includes world, progress, checkpoints and continuity memory.' : 'Transcript: includes messages and portraits.';
  data.participants.forEach(p => {const option=node('option',p.name);option.value=p.id;el('speaker').append(option);});
  function url(value,image=false){const result=data.assets[value] || value;if(typeof result!=='string')return null;if(/^data:(?:image\/(?:png|jpeg|gif|webp)|audio\/[\w.+-]+|video\/[\w.+-]+);base64,/i.test(result))return result;if(!image && /^https?:\/\//i.test(result))return result;return null;}
  function inline(parent,text){
    const pattern=/!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|\*([^*\n]+)\*|\x60([^\x60]+)\x60/g;
    let offset=0;
    for(const match of text.matchAll(pattern)){
      parent.append(document.createTextNode(text.slice(offset,match.index)));
      if(match[2]){const src=url(match[2],true);if(src){const img=node('img');img.src=src;img.alt=match[1];img.loading='lazy';parent.append(img);}else parent.append(document.createTextNode(match[1] || '[Image]'));}
      else if(match[4]){const href=url(match[4]);if(href){const a=node('a',match[3]);a.href=href;a.rel='noopener noreferrer';a.target='_blank';parent.append(a);}else parent.append(document.createTextNode(match[3]));}
      else parent.append(node(match[5]?'strong':match[6]?'em':'code',match[5]||match[6]||match[7]));
      offset=match.index+match[0].length;
    }
    parent.append(document.createTextNode(text.slice(offset)));
  }
  function highlight(parent,query){if(!query)return;const walker=document.createTreeWalker(parent,NodeFilter.SHOW_TEXT);const texts=[];while(walker.nextNode())texts.push(walker.currentNode);texts.forEach(text=>{const value=text.nodeValue;const lower=value.toLocaleLowerCase();let offset=0,index=lower.indexOf(query);if(index<0)return;const fragment=document.createDocumentFragment();while(index>=0){fragment.append(document.createTextNode(value.slice(offset,index)),node('mark',value.slice(index,index+query.length)));offset=index+query.length;index=lower.indexOf(query,offset);}fragment.append(document.createTextNode(value.slice(offset)));text.replaceWith(fragment);});}
  function portrait(p){const wrap=node('span',undefined,'avatar');wrap.textContent=(p.name || '?').slice(0,1);const src=url(p.avatar,true);if(src){const img=node('img',undefined,'avatar');img.src=src;img.alt='';img.loading='lazy';img.addEventListener('error',()=>img.replaceWith(node('span',(p.name||'?').slice(0,1),'avatar')));return img;}return wrap;}
  function render(){
    const query=el('search').value.trim().toLocaleLowerCase(),speaker=el('speaker').value,role=el('role').value,from=el('from').value,until=el('until').value;
    let visible=messages.map(m=>({message:m,rows:(groups.get(m.id)||[]).filter(r=>(!speaker||r.speakerId===speaker)&&(!query||r.text.toLocaleLowerCase().includes(query)))})).filter(item=>item.rows.length&&(!role||(role==='attachments'?(item.message.attachments||[]).length>0:item.message.role===role))&&(!from||item.message.createdAt.slice(0,10)>=from)&&(!until||item.message.createdAt.slice(0,10)<=until));
    if(el('sort').value==='newest')visible=visible.slice().reverse();
    const fragment=document.createDocumentFragment();
    visible.forEach(({message,rows})=>{
      const article=node('article');article.dataset.messageId=message.id;article.dataset.turn=String(rows[0].turn);
      const head=node('div',undefined,'message-head');head.append(node('span','Turn '+rows[0].turn+' · Message '+(sourceIndex.get(message.id)+1)),node('time',new Date(message.createdAt).toLocaleString()));article.append(head);
      rows.forEach(row=>{const p=byId.get(row.speakerId)||{name:row.kind==='narration'?'Narrator':message.role==='user'?data.player.name:'Assistant',avatar:null};const passage=node('div',undefined,'passage '+row.kind),speaker=node('div',undefined,'speaker'),copy=node('div',undefined,'copy');speaker.append(portrait(p),node('span',p.name));inline(copy,row.text);highlight(copy,query);passage.append(speaker,copy);article.append(passage);});
      (message.attachments||[]).forEach(attachment=>{const src=url(attachment.url,true);const wrap=node('div',undefined,'attachment');if(src){const type=attachment.mimeType.startsWith('image/')?'img':attachment.mimeType.startsWith('audio/')?'audio':attachment.mimeType.startsWith('video/')?'video':null;if(type){const media=node(type);media.src=src;if(type==='img'){media.alt=attachment.name;media.loading='lazy';}else media.controls=true;wrap.append(media);}}wrap.append(node('span',attachment.name));article.append(wrap);});
      fragment.append(article);
    });
    if(!visible.length)fragment.append(node('p','No messages match these filters. Clear filters to see the full transcript.','empty'));
    el('transcript').replaceChildren(fragment);el('count').textContent='Showing '+visible.length+' of '+messages.length+' messages';
  }
  ['search','speaker','role','sort','from','until'].forEach(id=>el(id).addEventListener('input',render));
  el('reset').addEventListener('click',()=>{['search','speaker','role','from','until','jump'].forEach(id=>el(id).value='');el('sort').value='oldest';render();});
  el('jump').addEventListener('change',()=>{const turn=Number(el('jump').value);const target=[...el('transcript').querySelectorAll('article')].find(n=>Number(n.dataset.turn)===turn);if(target)target.scrollIntoView({behavior:'smooth',block:'start'});});
  el('theme').addEventListener('click',()=>document.body.classList.toggle('light'));
  el('print').addEventListener('click',()=>window.print());
  el('json').addEventListener('click',()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),href=URL.createObjectURL(blob),link=node('a');link.href=href;link.download=(data.session.name||data.world.name).replace(/[<>:"/\\|?*]/g,'_')+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(href),10000);});
  render();
})();`;
