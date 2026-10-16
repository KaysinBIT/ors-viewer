import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../viewer/web/vendor/three.module.js';
import {meshSections,meshPlaneTransform,meshToScreen,screenToMesh} from '../viewer/web/mesh-sections-math.js';
import {MeshSections} from '../viewer/web/mesh-sections.js';
import {SceneView} from '../viewer/web/scene.js';
import {THEMES,themeFor} from '../viewer/web/themes.js';
import {MPRView} from '../viewer/web/mpr.js';
import {contourFill} from '../viewer/web/contour-fill.js';
import {buildSectionIndex,querySectionIndex} from '../viewer/web/mesh-section-index.js';

const vertices=new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1]);
const indices=new Uint32Array([0,2,1,0,1,3,1,2,3,2,0,3]);
test('spatial index keeps every triangle and produces the same cuts as exhaustive traversal',()=>{
  const points=[],faces=[];
  for(let i=0;i<24;i++){const offset=points.length/3;for(let j=0;j<vertices.length;j++)points.push(vertices[j]+[i%4,Math.floor(i/4)%3,Math.floor(i/12)][j%3]*2);for(const v of indices)faces.push(v+offset);}
  const p=new Float32Array(points),f=new Uint32Array(faces),before=p.slice(),order=f.slice(),index=buildSectionIndex(p,f,[[0,0,0],[7,5,3]],4);
  assert.deepEqual(Array.from(index.faces).sort((a,b)=>a-b),Array.from({length:f.length/3},(_,i)=>i));
  const sorted=values=>Array.from({length:values.length/6},(_,i)=>Array.from(values.slice(i*6,i*6+6)).join(',')).sort();
  for(const cuts of [[.25,.4,.6],[2,2,2],[6.5,4.5,2.5],[-1,-1,-1]]){
    const raw=meshSections(p,f,cuts,[0,0,0],1,1e-10),fast=meshSections(p,f,cuts,[0,0,0],1,1e-10,2000000,querySectionIndex(index,cuts,1e-10));
    assert.deepEqual(fast.counts,raw.counts);for(let axis=0;axis<3;axis++)assert.deepEqual(sorted(fast.lines[axis]),sorted(raw.lines[axis]));
  }
  const subset=meshSections(p,f,[.3,.3,.3],[0,0,0],1,1e-10,2000000,querySectionIndex(index,[.3,.3,.3],1e-10,[true,false,false]));assert.equal(subset.counts[1],0);assert.equal(subset.counts[2],0);
  assert.deepEqual(p,before);assert.deepEqual(f,order);
});
test('leaving a mesh releases retained geometry packets before a volume is loaded',()=>{
  const view={meshPacket:{arrays:{positions:vertices,indices}},meshResult:{lines:[]},id:'old',
    setActive(){},probe:{reset(){}},meshSections:{clear(){}},panes:[{queue:{reset(){}},canvas:{dataset:{loadedIndex:'0'}}}]};
  MPRView.prototype.clear.call(view);assert.equal(view.meshPacket,null);assert.equal(view.meshResult,null);assert.equal(view.id,null);
  view.meshPacket={arrays:{positions:vertices,indices}};
  MPRView.prototype.source.call(view,'volume',{grid:{shape_tzyx:[1,2,3,4]}},0,[1,1,1]);
  assert.equal(view.meshPacket,null);assert.equal(view.kind,'volume');assert.equal(indices.length,12);
});
test('three mesh sections share the requested coordinates without changing original triangles',()=>{
  const before=vertices.slice(),faces=indices.slice(),cuts=[.2,.3,.4],center=[.5,.5,.5],scale=2;
  const result=meshSections(vertices,indices,cuts,center,scale,1e-10);
  assert.deepEqual(result.counts,[3,3,3]);
  for(let axis=0;axis<3;axis++)for(let i=0;i<result.lines[axis].length;i+=3){
    const p=Array.from(result.lines[axis].slice(i,i+3),(n,d)=>n/scale+center[d]);
    assert.ok(Math.abs(p[axis]-cuts[axis])<1e-7);assert.ok(p.every(v=>v>=-1e-7));assert.ok(p.reduce((a,b)=>a+b)<=1+1e-7);
  }
  assert.deepEqual(vertices,before);assert.deepEqual(indices,faces);
});
test('coplanar triangles show triangle edges while isolated tangent vertices produce no false segment',()=>{
  const coplanar=meshSections(vertices,indices,[0,0,0],[0,0,0],1,1e-10);
  assert.deepEqual(coplanar.coplanar,[1,1,1]);assert.deepEqual(coplanar.counts,[6,6,6]);
  assert.deepEqual(meshSections(vertices,indices,[1,1,1],[0,0,0],1,1e-10).counts,[0,0,0]);
  assert.deepEqual(meshSections(vertices,indices,[2,2,2],[0,0,0],1,1e-10).counts,[0,0,0]);
});
test('translated and anisotropic mesh coordinates round trip through normalized intersections',()=>{
  const transformed=vertices.map((v,i)=>v*[2,3,4][i%3]+[10,20,30][i%3]);
  const cuts=[10.5,20.75,31],result=meshSections(transformed,indices,cuts,[11,21.5,32],.5,1e-10);
  assert.deepEqual(result.counts,[3,3,3]);
  result.lines.forEach((line,axis)=>{for(let i=axis;i<line.length;i+=3)assert.ok(Math.abs(line[i]-(cuts[axis]-[11,21.5,32][axis])*.5)<1e-7);});
});
test('section memory limit reports failure rather than returning a truncated or simplified contour',()=>{
  assert.throws(()=>meshSections(vertices,indices,[.2,.3,.4],[0,0,0],1,1e-10,1),/未截断或自动简化/);
});
test('mesh plane picking preserves aspect and supports flat meshes and boundaries',()=>{
  for(const bounds of [[[-2,-3,-4],[2,3,4]],[[10,20,0],[15,26,0]]])for(let axis=0;axis<3;axis++){
    const t=meshPlaneTransform(bounds,axis,400,300);
    const u=(bounds[0][t.u]+bounds[1][t.u])/2,v=(bounds[0][t.v]+bounds[1][t.v])/2;
    const back=screenToMesh(t,...meshToScreen(t,u,v));assert.ok(Math.abs(back[0]-u)<1e-10&&Math.abs(back[1]-v)<1e-10);
    assert.equal(screenToMesh(t,-50,-50),null);assert.ok(Number.isFinite(t.scale));
  }
});
test('mesh worker copies full geometry once, updates locator immediately and rejects stale results',()=>{
  const saved=globalThis.Worker,workers=[];globalThis.Worker=class {constructor(){this.messages=[];workers.push(this);}postMessage(data){this.messages.push(data);}terminate(){this.terminated=true;}};
  try{
    const result=[],view={scene:new THREE.Scene(),bounds:new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(1,1,1)),group:{scale:{x:2}}};
    const packet={arrays:{positions:vertices,indices}},controller=new MeshSections(view,data=>result.push(data),()=>{});
    controller.source(packet);controller.setActive(true);controller.update([.2,.3,.4]);
    const worker=workers[0];assert.deepEqual(worker.messages[0].positions,vertices);assert.notEqual(worker.messages[0].positions,vertices);assert.deepEqual(worker.messages[0].indices,indices);
    worker.onmessage({data:{type:'ready'}});const first=worker.messages[1];
    for(let i=0;i<20;i++)controller.update([i/20,.3,.4]);assert.deepEqual(view.meshPlaneCoordinates,[.95,.3,.4]);assert.equal(worker.messages.length,2);
    worker.onmessage({data:{type:'sections',revision:first.revision,lines:[new Float32Array(),new Float32Array(),new Float32Array()]}});assert.equal(result.length,0);
    const latest=worker.messages[2];assert.equal(latest.revision,controller.revision);
    worker.onmessage({data:{type:'sections',revision:latest.revision,lines:[new Float32Array(6),new Float32Array(6),new Float32Array(6)]}});assert.equal(result.length,1);
    controller.setTheme(THEMES.light);controller.lines.forEach((line,i)=>assert.equal(line.material.color.getHexString(),new THREE.Color(THEMES.light.axes[i]).getHexString()));
    controller.clear();assert.equal(worker.terminated,true);assert.deepEqual(vertices,new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1]));
  }finally{globalThis.Worker=saved;}
});
test('shared palette updates background, mesh, locator and volume material together',()=>{
  const values=[],view={renderer:{setClearColor(...args){values.push(args);}},grid:new THREE.GridHelper(1,1),axes:new THREE.AxesHelper(1),
    packet:{meta:{kind:'mesh'}},mesh:{},materials:[new THREE.MeshStandardMaterial()],volume:{material:{uniforms:{uTint:{value:new THREE.Color()}}},outlines:[0,1,2].map(()=>({material:new THREE.LineBasicMaterial()}))}};
  for(const theme of Object.values(THEMES)){
    SceneView.prototype.setTheme.call(view,theme);assert.equal(values.at(-1)[0],theme.canvas);assert.equal(values.at(-1)[1],1);
    assert.equal(view.materials[0].color.getHexString(),new THREE.Color(theme.mesh).getHexString());
    assert.equal(view.volume.material.uniforms.uTint.value.getHexString(),new THREE.Color(theme.mesh).getHexString());
  }
  assert.equal(themeFor('invalid'),THEMES.ocean);
});
test('completed contour frames remain visible during continuous motion while stale fill is rejected',()=>{
  const saved=globalThis.Worker;let worker;globalThis.Worker=class {constructor(){worker=this;}postMessage(){}terminate(){}};
  try{
    const frames=[],view={scene:new THREE.Scene(),bounds:new THREE.Box3(new THREE.Vector3(),new THREE.Vector3(1,1,1)),group:{scale:{x:2}}};
    const c=new MeshSections(view,data=>frames.push(data),()=>{});c.source({arrays:{positions:vertices,indices}});c.setActive(true);c.update([.2,.3,.4]);worker.onmessage({data:{type:'ready'}});const first=c.revision;c.update([.4,.3,.4]);
    const data={type:'sections',phase:'lines',revision:first,coordinates:[.2,.3,.4],lines:[new Float32Array(6),new Float32Array(6),new Float32Array(6)]};
    worker.onmessage({data});assert.equal(frames.length,1);assert.ok(c.lines.every(line=>line.visible));assert.deepEqual(view.meshPlaneCoordinates,[.4,.3,.4]);
    worker.onmessage({data:{...data,phase:'fill'}});assert.equal(frames.length,1);c.clear();
  }finally{globalThis.Worker=saved;}
});
test('fill modes control both cap and outline geometry and fall back on open sections',()=>{
  const view={scene:new THREE.Scene(),bounds:new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(1,1,1)),group:{scale:{x:2}}};
  const controller=new MeshSections(view,()=>{},()=>{});controller.source({arrays:{positions:vertices,indices}});controller.setActive(true);
  const data=meshSections(vertices,indices,[.2,.3,.4],[.5,.5,.5],2,1e-10);data.fills=data.lines.map((line,axis)=>contourFill(line,axis,data.coplanarFlags[axis]));
  controller.result=data;controller.resultRevision=controller.revision;
  controller.setDisplay('both',.6);assert.ok(controller.caps.every(c=>c.visible&&c.material.opacity===.6));assert.ok(controller.lines.every(l=>l.visible));
  controller.setDisplay('fill',.8);assert.ok(controller.caps.every(c=>c.visible));assert.ok(controller.lines.every(l=>!l.visible));
  controller.setDisplay('line',.8);assert.ok(controller.caps.every(c=>!c.visible));assert.equal(controller.lines[0].geometry.attributes.position.array,data.lines[0]);
  data.fills[0]={status:'open'};controller.setDisplay('fill',.5);assert.equal(controller.caps[0].visible,false);assert.equal(controller.lines[0].visible,true);
  controller.clear();assert.equal(controller.result,null);assert.equal(controller.packet,null);assert.equal(controller.root.children.length,0);
});
