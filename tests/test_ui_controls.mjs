import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createViewControls} from '../viewer/web/view-controls.js';
import {requestJson,requestPreview,requestErrorMessage} from '../viewer/web/data-client.js';
import {viewHarness} from './view_harness.mjs';
import {createPreviewPLY} from '../viewer/web/export-ply.js';
import {bindRangeNumber} from '../viewer/web/number-control.js';
import {validateFullVolume,customSampleCounts} from '../viewer/web/volume-quality.js';

test('manual XYZ sample counts validate exact integers against ZYX dimensions',()=>{
  assert.deepEqual(customSampleCounts([1024,1016,1004],['256','192','128']),[256,192,128]);
  assert.deepEqual(customSampleCounts([1,2,3],['3','2','1']),[3,2,1]);
  for(const values of [['','2','3'],['0','2','3'],['1.5','2','3'],['NaN','2','3'],['9','2','3'],['1','7','3'],['1','2','6']])assert.throws(()=>customSampleCounts([5,6,8],values));
  assert.throws(()=>customSampleCounts([2048,2048,2048],['2048','2048','2048']),/2 GiB/);
  assert.throws(()=>validateFullVolume([512,64,64],256,'自定义抽样'),/自定义抽样.*上限 256/);
});

test('full volume preflight rejects hardware and buffer limits without choosing another quality',()=>{
  assert.equal(validateFullVolume([1024,1016,1004],2048),1044545536);
  assert.throws(()=>validateFullVolume([1024,1016,1004],512),/单边上限 512/);
  assert.throws(()=>validateFullVolume([2048,2048,2048],4096),/2 GiB/);
  for(const shape of [[0,2,3],[1,2],[-1,2,3],[NaN,2,3]])assert.throws(()=>validateFullVolume(shape,2048),/维度无效/);
});

test('section angle inputs sync fractions, clamp boundaries and restore incomplete edits',()=>{
  for(const max of [180,90]){
    const range={min:-max,max,value:'0'},number={value:'0'},changes=[];
    bindRangeNumber(range,number,()=>changes.push(Number(range.value)));
    number.value='-23.625';number.oninput();assert.equal(Number(range.value),-23.625);
    number.value='';number.oninput();assert.equal(Number(range.value),-23.625);number.onchange();assert.equal(Number(number.value),-23.625);
    for(const value of ['-', 'NaN', 'Infinity']){number.value=value;number.oninput();assert.equal(Number(range.value),-23.625);number.onchange();assert.equal(Number(number.value),-23.625);}
    number.value='1000';number.oninput();assert.equal(Number(range.value),max);number.onchange();assert.equal(Number(number.value),max);
    number.value='-1000';number.onchange();assert.equal(Number(number.value),-max);
    range.value='12.5';range.oninput();assert.equal(number.value,'12.5');assert.equal(changes.at(-1),12.5);
  }
});

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
