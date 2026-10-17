import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createViewControls} from '../viewer/web/view-controls.js';
import {requestJson,requestPreview,requestErrorMessage} from '../viewer/web/data-client.js';
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
    const actual=h.snapshot();
    // RC4 intentionally shares complete-model rendering between 3D and MPR.
    // Keep the historical layout/navigation contract; exercise the new render
    // contract below instead of asserting the former slices-only behavior.
    if(fixture.input.kind==='volume'){
      assert.deepEqual(actual.mpr,fixture.expected.mpr);
      assert.equal(actual.state.faceSection,fixture.expected.state.faceSection);
      for(const id of ['section-controls','mpr-toggle','slice-fields','mpr-help'])if(fixture.expected.nodes[id])assert.deepEqual(actual.nodes[id],fixture.expected.nodes[id]);
      if(actual.mpr.active&&(fixture.action==='toggleMPR'||fixture.input.mode==='mpr')){assert.ok(['mip','iso'].includes(actual.calls.findLast(c=>c[0]==='volumeMode')[1]));}
    }else{
      delete actual.nodes['mpr-render-field'];delete actual.nodes['mpr-render-mode'];
      assert.deepEqual(actual,fixture.expected);
    }
  });
}

test('MPR retains the complete 3D rendering mode and model display controls in both directions',()=>{
  for(const mode of ['mip','iso']){
    const h=viewHarness({kind:'volume',mode,active:false,renderer:true,preview:true,grid:true}),controls=createViewControls(h);
    controls.updateVolumeMode();controls.toggleMPR();
    assert.equal(h.mpr.active,true);assert.equal(h.state.volume3DMode,mode);
    assert.deepEqual(h.snapshot().calls.filter(c=>c[0]==='volumeMode').at(-1),['volumeMode',mode]);
    assert.equal(h.element('iso-field').hidden,mode!=='iso');assert.equal(h.element('mpr-render-mode').value,mode);
    controls.show3D();assert.equal(h.mpr.active,false);assert.equal(h.element('volume-mode').value,mode);
    assert.equal(h.element('show-grid').checked,true);
  }
});

test('network failures explain the local service boundary without masking HTTP or numerical errors',()=>{
  assert.match(requestErrorMessage(new TypeError('Failed to fetch')),/启动窗口.*退出/);
  assert.equal(requestErrorMessage(new Error('切面位置超出数据范围')),'切面位置超出数据范围');
});

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
