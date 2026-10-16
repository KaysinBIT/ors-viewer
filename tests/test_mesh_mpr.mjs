import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../viewer/web/vendor/three.module.js';
import {meshSections,meshPlaneTransform,meshToScreen,screenToMesh} from '../viewer/web/mesh-sections-math.js';
import {MeshSections} from '../viewer/web/mesh-sections.js';
import {SceneView} from '../viewer/web/scene.js';
import {THEMES,themeFor} from '../viewer/web/themes.js';

const vertices=new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1]);
const indices=new Uint32Array([0,2,1,0,1,3,1,2,3,2,0,3]);
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
  assert.equal(themeFor('invalid'),THEMES.mono);
});
