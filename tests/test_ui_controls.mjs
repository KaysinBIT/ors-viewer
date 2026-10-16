import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createViewControls} from '../viewer/web/view-controls.js';
import {requestJson,requestPreview} from '../viewer/web/data-client.js';
import {viewHarness} from './view_harness.mjs';
import {createPreviewPLY} from '../viewer/web/export-ply.js';

// Golden snapshots were captured from v0.9.1RC2 before extracting its controls.
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/view-controls-v091rc2.json',import.meta.url)));
const exports=JSON.parse(readFileSync(new URL('./fixtures/ply-v091rc2.json',import.meta.url)));
for(const fixture of exports){
  test(`PLY bytes match v0.9.1RC2: ${fixture.name}`,async()=>{
    const storage=new Float32Array(fixture.positions.length+6);
    storage.set(fixture.positions,3);
    const positions=storage.subarray(3,storage.length-3),indices=new Uint32Array(fixture.indices);
    const before=positions.slice(),beforeIndices=indices.slice();
    const blob=createPreviewPLY(positions,indices);
    assert.equal(blob.type,'application/octet-stream');
    assert.equal(Buffer.from(await blob.arrayBuffer()).toString('base64'),fixture.base64);
    assert.deepEqual(positions,before);assert.deepEqual(indices,beforeIndices);
  });
}
for(const fixture of fixtures){
  test(`preserve ${fixture.name}`,()=>{
    const h=viewHarness(fixture.input),controls=createViewControls(h);
    controls[fixture.action]();
    assert.deepEqual(h.snapshot(),fixture.expected);
  });
}

test('JSON requests preserve successful responses and HTTP error fallbacks',async()=>{
  const original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>({ok:true,json:async()=>({value:7})});
    assert.deepEqual(await requestJson('/test'),{value:7});
    globalThis.fetch=async()=>({ok:false,status:403,json:async()=>({error:'denied'})});
    await assert.rejects(requestJson('/test'),/denied/);
    globalThis.fetch=async()=>({ok:false,status:500,json:async()=>{throw new SyntaxError();}});
    await assert.rejects(requestJson('/test'),/请求失败 \(500\)/);
  }finally{globalThis.fetch=original;}
});
test('preview requests retain cancellation, binary bytes and endpoint errors',async()=>{
  const original=globalThis.fetch,controller=new AbortController(),bytes=new Uint8Array([1,2,3]).buffer;
  try{
    globalThis.fetch=async(path,options)=>{assert.equal(options.signal,controller.signal);return {ok:true,arrayBuffer:async()=>bytes};};
    assert.equal(await requestPreview('/preview',controller.signal,value=>value),bytes);
    globalThis.fetch=async()=>({ok:false,json:async()=>({error:'bad preview'})});
    await assert.rejects(requestPreview('/preview',controller.signal,()=>{}),/bad preview/);
    globalThis.fetch=async()=>{throw new DOMException('cancelled','AbortError');};
    await assert.rejects(requestPreview('/preview',controller.signal,()=>{}),{name:'AbortError'});
  }finally{globalThis.fetch=original;}
});
