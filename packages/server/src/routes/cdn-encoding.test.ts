import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {gzipSync,gunzipSync} from 'node:zlib';
import {Hono} from 'hono';
process.env.BETTER_AUTH_SECRET='cdn-encoding-test-only';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/test';
const {streamS3Object}=await import('./cdn.js');

function imageFixture() {
 let reads = 0, heads = 0, changedDuringRead = false;
 let etag: string | null = 'version-one';
 let missing = false;
 const options: unknown[] = [];
 const metadata = () => ({contentType:'image/webp',contentLength:3,etag});
 const app = new Hono();
 app.get('/image', c => streamS3Object(c, 'users/test/image.webp', 'fixture', async (_key, opts) => {
  reads++; options.push(opts);
  if (changedDuringRead && opts?.ifMatch) {
   changedDuringRead=false; etag='version-two';
   throw Object.assign(new Error('Changed'), {$metadata:{httpStatusCode:412}});
  }
  const ranged = !!opts?.range;
  return {...metadata(),body:Readable.from([Buffer.from(ranged?'ab':'abc')]),contentLength:ranged?2:3,contentRange:ranged?'bytes 0-1/3':null};
 }, async () => {
  heads++;
  if (missing) throw Object.assign(new Error('Deleted'), {$metadata:{httpStatusCode:404}});
  return metadata();
 }));
 return {app,options,get reads(){return reads;},get heads(){return heads;},set etag(value:string|null){etag=value;},set missing(value:boolean){missing=value;},set changedDuringRead(value:boolean){changedDuringRead=value;}};
}

test('unchanged media revalidates without transferring or opening its body',async()=>{
 const fixture=imageFixture();
 const original=await fixture.app.request('/image');
 assert.equal(original.status,200); assert.equal(fixture.heads,0); assert.equal(fixture.reads,1);
 assert.equal(original.headers.get('etag'),'"version-one"');
 const cached=await fixture.app.request('/image',{headers:{'If-None-Match':original.headers.get('etag')!}});
 assert.equal(cached.status,304); assert.equal(await cached.text(),'');
 assert.equal(fixture.reads,1); assert.equal(fixture.heads,1);
 assert.equal(cached.headers.get('etag'),original.headers.get('etag'));
 assert.equal(cached.headers.get('cache-control'),'public, max-age=0, s-maxage=300, must-revalidate');
 assert.equal(cached.headers.get('access-control-allow-origin'),'*');
 assert.equal(cached.headers.get('content-length'),null);
});

test('conditional reads handle weak tags, lists, wildcard and malformed validators',async()=>{
 for(const tag of ['W/"version-one"','"other", W/"version-one"','*']){
  const fixture=imageFixture();
  assert.equal((await fixture.app.request('/image',{headers:{'If-None-Match':tag}})).status,304);
  assert.equal(fixture.reads,0);
 }
 for(const tag of ['"other"','version-one','garbage "version-one"','"version-one", garbage']){
  const fixture=imageFixture();
  assert.equal((await fixture.app.request('/image',{headers:{'If-None-Match':tag}})).status,200);
  assert.equal(fixture.reads,1);
 }
 const fixture=imageFixture();fixture.etag='opaque,tag';
 assert.equal((await fixture.app.request('/image',{headers:{'If-None-Match':'"other", W/"opaque,tag"'}})).status,304);
 const noTag=imageFixture();noTag.etag=null;
 assert.equal((await noTag.app.request('/image',{headers:{'If-None-Match':'*'}})).status,304);
});

test('changed and deleted media never reuse stale cached bytes',async()=>{
 const fixture=imageFixture();fixture.etag='version-two';
 const changed=await fixture.app.request('/image',{headers:{'If-None-Match':'"version-one"'}});
 assert.equal(changed.status,200);assert.equal(changed.headers.get('etag'),'"version-two"');assert.equal(await changed.text(),'abc');
 fixture.missing=true;
 const deleted=await fixture.app.request('/image',{headers:{'If-None-Match':'"version-two"'}});
 assert.equal(deleted.status,404);assert.equal(fixture.reads,1);
});

test('HEAD inspects metadata without downloading media, including ranged requests',async()=>{
 const fixture=imageFixture();
 const response=await fixture.app.request('/image',{method:'HEAD',headers:{Range:'bytes=0-1'}});
 assert.equal(response.status,200);assert.equal(await response.text(),'');
 assert.equal(response.headers.get('content-length'),'3');assert.equal(response.headers.get('etag'),'"version-one"');
 assert.equal(response.headers.get('content-range'),null);assert.equal(fixture.reads,0);
 assert.equal((await fixture.app.request('/image',{method:'HEAD',headers:{'If-None-Match':'"version-one"'}})).status,304);
 assert.equal(fixture.reads,0);
});

test('cache validation precedes range handling and strong If-Range pins the read',async()=>{
 const fixture=imageFixture();
 const unchanged=await fixture.app.request('/image',{headers:{Range:'bytes=0-1','If-None-Match':'"version-one"'}});
 assert.equal(unchanged.status,304);assert.equal(fixture.reads,0);
 const ranged=await fixture.app.request('/image',{headers:{Range:'bytes=0-1','If-Range':'"version-one"'}});
 assert.equal(ranged.status,206);assert.equal(await ranged.text(),'ab');
 assert.deepEqual(fixture.options[0],{range:'bytes=0-1',ifMatch:'"version-one"'});
 for(const tag of ['"outdated"','W/"version-one"','Wed, 21 Oct 2015 07:28:00 GMT']){
  const full=await fixture.app.request('/image',{headers:{Range:'bytes=0-1','If-Range':tag}});
  assert.equal(full.status,200);assert.equal(await full.text(),'abc');
  assert.equal(fixture.options.at(-1),undefined);
 }
});

test('an overwrite between inspection and range read returns the new full image',async()=>{
 const fixture=imageFixture();fixture.changedDuringRead=true;
 const response=await fixture.app.request('/image',{headers:{Range:'bytes=0-1','If-Range':'"version-one"'}});
 assert.equal(response.status,200);assert.equal(await response.text(),'abc');
 assert.equal(response.headers.get('etag'),'"version-two"');assert.equal(fixture.reads,2);
 assert.equal(fixture.options.at(-1),undefined);
});

test('a matching actual read after changed metadata returns 304 and closes its body',async()=>{
 const app=new Hono();const body=Readable.from([Buffer.from('abc')]);
 app.get('/image',c=>streamS3Object(c,'users/test/image.webp','fixture',async()=>({
  body,contentType:'image/webp',contentLength:3,contentRange:null,etag:'"version-one"',
 }),async()=>({contentType:'image/webp',contentLength:3,etag:'version-two'})));
 const response=await app.request('/image',{headers:{'If-None-Match':'"version-one"'}});
 assert.equal(response.status,304);assert.equal(await response.text(),'');
 assert.equal(response.headers.get('etag'),'"version-one"');assert.equal(response.headers.get('content-length'),null);
 assert.equal(body.destroyed,true);
});

test('compressed packs preserve HEAD encoding and progress metadata without a body read',async()=>{
 const app=new Hono();let reads=0;
 app.get('/pack',c=>streamS3Object(c,'worlds/pvz-previews/'+'b'.repeat(64)+'/main.pak','fixture',async()=>{
  reads++;throw new Error('HEAD must not fetch the body');
 },async()=>({contentType:'application/octet-stream',contentLength:100,etag:'compressed',contentEncoding:'gzip',decodedLength:1000})));
 const response=await app.request('/pack',{method:'HEAD'});
 assert.equal(response.status,200);assert.equal(reads,0);
 assert.equal(response.headers.get('content-encoding'),'gzip');assert.equal(response.headers.get('content-length'),'100');
 assert.equal(response.headers.get('x-uncompressed-length'),'1000');assert.equal(await response.text(),'');
});

test('compressed immutable packs preserve encoding, byte length and decoded progress size',async()=>{
 const original=Buffer.from('actual game resource\n'.repeat(1000)),compressed=gzipSync(original);
 const app=new Hono();
 app.get('/pack',c=>streamS3Object(c,'worlds/pvz-previews/'+'b'.repeat(64)+'/main.pak','fixture',async()=>({
  body:Readable.from([compressed]),contentType:'application/octet-stream',contentLength:compressed.length,
  contentRange:null,etag:'"compressed"',contentEncoding:'gzip',decodedLength:original.length,
 })));
 const response=await app.request('/pack');
 assert.equal(response.headers.get('content-encoding'),'gzip');
 assert.equal(response.headers.get('content-length'),String(compressed.length));
 assert.equal(response.headers.get('x-uncompressed-length'),String(original.length));
 assert.match(response.headers.get('access-control-expose-headers')??'',/X-Uncompressed-Length/);
 assert.match(response.headers.get('cache-control')??'',/immutable/);
 assert.deepEqual(gunzipSync(Buffer.from(await response.arrayBuffer())),original);
});

test('ordinary ranged media retains its unencoded range and short cache policy',async()=>{
 const app=new Hono();let received:unknown;
 app.get('/media',c=>streamS3Object(c,'users/test/audio.ogg','fixture',async(_key,opts)=>{
  received=opts;return {body:Readable.from([Buffer.from('abc')]),contentType:'audio/ogg',contentLength:3,contentRange:'bytes 2-4/10',etag:null};
 }));
 const response=await app.request('/media',{headers:{Range:'bytes=2-4'}});
 assert.deepEqual(received,{range:'bytes=2-4'});assert.equal(response.status,206);
 assert.equal(response.headers.get('content-encoding'),null);assert.equal(response.headers.get('x-uncompressed-length'),null);
 assert.equal(response.headers.get('content-range'),'bytes 2-4/10');assert.equal(await response.text(),'abc');
 assert.doesNotMatch(response.headers.get('cache-control')??'',/immutable/);
});
