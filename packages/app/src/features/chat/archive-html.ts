import { sessionArchiveSchema, type SessionArchive } from "@yumina/shared";
import { archiveViewerScript } from "./archive-viewer-script";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/** JSON remains inert even when authored text contains a closing script tag. */
export function buildArchiveHtml(archive: SessionArchive): string {
  const payload = JSON.stringify(sessionArchiveSchema.parse(archive)).replace(/[<\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(archive.session.name || archive.world.name)} — Yumina transcript</title>
<style>
:root{color-scheme:dark;--bg:#211c18;--paper:#2b241e;--text:#eee5d6;--muted:#c1b19b;--line:#78684e;--accent:#dbc08c}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 Georgia,serif}body.light{color-scheme:light;--bg:#f7f3ec;--paper:#fffdf8;--text:#302920;--muted:#71614b;--line:#c6b99e;--accent:#735820}header,main{max-width:1060px;margin:auto;padding:24px}h1{font-weight:400;font-size:clamp(26px,5vw,40px);line-height:1.2;margin:0 0 10px}p{margin:0 0 12px}.meta,#count,time{color:var(--muted);font:13px/1.5 system-ui,sans-serif}.toolbar{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px;font:14px system-ui,sans-serif}label{display:flex;flex-direction:column;gap:5px;flex:1;min-width:140px}input,select,button{font:inherit;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--text);min-height:44px;padding:9px 12px;max-width:100%}button{cursor:pointer}button:hover{border-color:var(--accent)}:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;font:14px system-ui,sans-serif}#count{display:block;margin-top:16px}article{padding:24px 0;border-top:1px solid var(--line);scroll-margin-top:20px}.message-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px;color:var(--muted);font:13px system-ui,sans-serif}.passage{display:grid;grid-template-columns:150px minmax(0,1fr);gap:20px;margin:16px 0}.speaker{display:flex;align-items:start;gap:10px;font:14px/1.4 system-ui,sans-serif;overflow-wrap:anywhere}.avatar{flex:none;width:36px;height:36px;border-radius:50%;object-fit:cover;background:var(--line);display:grid;place-items:center;font:14px system-ui,sans-serif}.copy{white-space:pre-wrap;overflow-wrap:anywhere;max-width:75ch}.narration .copy{font-style:italic;color:var(--muted)}.choice .copy{border-left:3px solid var(--accent);padding-left:16px}.copy img,.attachment img{max-width:100%;max-height:440px;object-fit:contain;border-radius:8px}.attachment{display:block;margin:12px 0 0 170px}.attachment video,.attachment audio{max-width:100%}a{color:var(--accent)}mark{background:#dbc08c;color:#211c18;border-radius:2px}code{font:14px monospace;background:var(--bg);padding:2px 4px}#empty{padding:40px 0;color:var(--muted)}footer{max-width:1060px;margin:auto;padding:24px;color:var(--muted);font:13px system-ui,sans-serif}@media(max-width:600px){header,main{padding:20px 16px}.passage{grid-template-columns:90px minmax(0,1fr);gap:12px}.speaker{flex-direction:column;font-size:13px}.attachment{margin-left:102px}.message-head{align-items:start}label{min-width:calc(50% - 12px)}label.search{flex-basis:100%}.actions button{flex:1}article{padding:18px 0}}@media print{.toolbar,.actions,#count{display:none}body{--bg:white;--text:black;--muted:#444;--line:#aaa}header,main{max-width:none}article{break-inside:avoid}a{color:inherit}}
</style></head><body><header><h1 id="title"></h1><p class="meta" id="meta"></p><p class="meta" id="save-kind"></p>
<div class="toolbar"><label class="search">Search<input id="search" type="search" placeholder="Search this transcript"></label><label>Speaker<select id="speaker"><option value="">All speakers</option></select></label><label>Messages<select id="role"><option value="">All messages</option><option value="user">Player replies</option><option value="assistant">Story replies</option><option value="attachments">With attachments</option></select></label><label>Order<select id="sort"><option value="oldest">Oldest first</option><option value="newest">Newest first</option></select></label><label>From (UTC)<input id="from" type="date"></label><label>Until (UTC)<input id="until" type="date"></label><label>Jump to turn<input id="jump" type="number" min="1" placeholder="Turn number"></label></div>
<div class="actions"><button id="reset">Clear filters</button><button id="theme">Light / dark</button><button id="json">Download JSON</button><button id="print">Print</button></div><span id="count" role="status" aria-live="polite"></span></header><main id="transcript"></main><footer>Import this HTML file or its JSON into Yumina to restore the saved messages.</footer><noscript>This transcript needs JavaScript to show its messages. Its JSON payload remains available for import.</noscript><script type="application/json" id="yumina-export">${payload}</script><script>${archiveViewerScript}</script></body></html>`;
}

/** Extract only the marked data block. Never attach or execute imported HTML. */
export function parseArchiveFile(content: string): SessionArchive {
  let payload = content.trim().replace(/^\uFEFF/, "");
  if (payload.startsWith("<")) {
    const blocks: string[] = [], tags = /<script\b([^>]*)>/gi, closing = /<\/script\s*>/gi;
    for (let tag = tags.exec(payload); tag; tag = tags.exec(payload)) {
      closing.lastIndex = tags.lastIndex;
      const end = closing.exec(payload);
      if (!end) break;
      if (/\bid\s*=\s*["']yumina-export["']/i.test(tag[1]) && /\btype\s*=\s*["']application\/json["']/i.test(tag[1])) blocks.push(payload.slice(tags.lastIndex, end.index));
      tags.lastIndex = closing.lastIndex;
    }
    if (blocks.length !== 1) throw new Error("Choose a Yumina HTML transcript or JSON archive.");
    payload = blocks[0];
  }
  let value: unknown;
  try { value = JSON.parse(payload); } catch { throw new Error("This file does not contain valid archive JSON."); }
  const result = sessionArchiveSchema.safeParse(value);
  if (!result.success) throw new Error("This archive is incomplete or uses an unsupported format/version.");
  return result.data;
}
