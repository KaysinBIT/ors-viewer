import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../viewer/web/vendor/three.module.js';
import {IDENTITY,poseMatrix,sourcePoint,transformPoint,sourcePlane,rotationFromAngles,anglesFromRotation,faceRotation,faceAlignedRotation,pointsRotation,originalPose} from '../viewer/web/alignment-math.js';
import {contourFill} from '../viewer/web/contour-fill.js';
import {obliqueSectionFill} from '../viewer/web/section-fill.js';
import {createPreviewPLY} from '../viewer/web/export-ply.js';
import {sectionContours} from '../viewer/web/section-math.js';
import {buildSectionIndex,queryPlaneIndex} from '../viewer/web/mesh-section-index.js';
import {SceneView} from '../viewer/web/scene.js';
import {MeshSections} from '../viewer/web/mesh-sections.js';
import {MPRView} from '../viewer/web/mpr.js';
import {ReslicePlanes} from '../viewer/web/reslice-planes.js';
import {createViewControls} from '../viewer/web/view-controls.js';
import {viewHarness} from './view_harness.mjs';
import {THEMES} from '../viewer/web/themes.js';
import {LatestRequest} from '../viewer/web/mpr-math.js';

const close=(a,b,tolerance=1e-7)=>{assert.equal(a.length,b.length);a.forEach((x,i)=>assert.ok(Math.abs(x-b[i])<=tolerance,`${x} != ${b[i]}`));};
const pose={enabled:true,pivot:[100,-25,12],rotation:rotationFromAngles([23,-47,91])};
const vertices=new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1]),indices=new Uint32Array([0,2,1,0,1,3,1,2,3,2,0,3]);
const mirrors=Array.from({length:8},(_,bits)=>[0,1,2].map(i=>Boolean(bits&(1<<i))));
test('XYZ mirrors follow rotation about one dataset pivot and reset together',()=>{
  const point=[11,27,32],rotated=transformPoint(poseMatrix(pose),point);
  for(const mirror of mirrors){
    const matrix=poseMatrix({...pose,mirror}),actual=transformPoint(matrix,point);
    close(actual,rotated.map((x,i)=>mirror[i]?2*pose.pivot[i]-x:x));
    close(transformPoint(matrix,pose.pivot),pose.pivot);close(sourcePoint(matrix,actual),point);
    close([new THREE.Matrix4().set(...matrix.flat()).determinant()],[(-1)**mirror.filter(Boolean).length]);
  }
  const reset=originalPose(pose.pivot);assert.deepEqual(reset.mirror,[false,false,false]);assert.deepEqual(poseMatrix(reset),poseMatrix(null));
  assert.notEqual(reset.pivot,pose.pivot);
});
test('face and three-point auto alignment preserve mirror switches and produce the selected orientation',()=>{
  const points=[[10,20,30],[12,21,33],[8,25,31]],normal=new THREE.Vector3(2,-3,5).normalize().toArray();
  for(const mirror of mirrors)for(let axis=0;axis<3;axis++){
    const rotation=faceAlignedRotation({...pose,mirror},normal,axis),m=poseMatrix({...pose,mirror,rotation,pivot:[0,0,0]}),target=[0,0,0];target[axis]=1;
    close(transformPoint(m,normal),target);close([new THREE.Matrix3().set(...rotation.flat()).determinant()],[1]);
    const r=pointsRotation(points,axis,mirror),matrix=poseMatrix({...pose,mirror,rotation:r}),q=points.map(p=>new THREE.Vector3(...transformPoint(matrix,p)));
    close(q.map(p=>p.getComponent(axis)),Array(3).fill(q[0].getComponent(axis)));
    const tangent=q[1].clone().sub(q[0]).normalize(),orderedNormal=tangent.clone().cross(q[2].clone().sub(q[0])).normalize();
    close(orderedNormal.toArray(),target);assert.ok(tangent.getComponent(axis===0?1:0)>.999999);
    close([new THREE.Matrix3().set(...r.flat()).determinant()],[1]);
  }
});
test('mirrored mesh MPR and oblique fills match transformed geometry while source PLY stays byte identical',async()=>{
  const before=Buffer.from(await createPreviewPLY(vertices,indices).arrayBuffer());
  const sort=lines=>Array.from({length:lines.length/6},(_,i)=>Array.from(lines.slice(i*6,i*6+6),x=>x.toFixed(5)).join(',')).sort();
  for(const mirror of mirrors){
    const matrix=poseMatrix({...pose,mirror}),transformed=new Float64Array(vertices.length),center=transformPoint(matrix,[.25,.25,.25]);
    for(let i=0;i<vertices.length;i+=3)transformed.set(transformPoint(matrix,Array.from(vertices.slice(i,i+3))),i);
    const normals=[[1,0,0],[0,1,0],[0,0,1],new THREE.Vector3(1,2,3).normalize().toArray()];
    for(const [axis,normal] of normals.entries()){
      const constant=-normal.reduce((s,x,i)=>s+x*center[i],0),source=sourcePlane(matrix,normal,constant);
      const a=sectionContours(vertices,indices,source.normal,source.constant,center,2,1e-9,matrix),b=sectionContours(transformed,indices,normal,constant,center,2,1e-9);
      assert.deepEqual(sort(a.lines),sort(b.lines));
      const fill=axis<3?contourFill(a.lines,axis,a.coplanarFlags):obliqueSectionFill(a.lines,normal,[0,0,0],a.coplanarFlags);
      assert.equal(fill.status,'filled');assert.equal(fill.loops,1);
    }
  }
  assert.deepEqual(Buffer.from(await createPreviewPLY(vertices,indices).arrayBuffer()),before);
});
test('rapid pose changes retain one CPU request slot and discard every previous pose',async()=>{
  const pending=[],accepted=[],queue=new LatestRequest((job,signal)=>new Promise(resolve=>pending.push({job,signal,resolve})),value=>accepted.push(value),error=>{throw error;},true);
  queue.submit('old');
  for(let i=0;i<50;i++){queue.reset(false);queue.submit(i);}
  assert.equal(pending.length,1);assert.equal(pending[0].signal.aborted,false);
  pending[0].resolve('old');await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(accepted,[]);assert.equal(pending[1].job,49);
  pending[1].resolve('new');await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(accepted,['new']);
});

test('dataset rotation keeps a common pivot, pairwise registration and reversible source coordinates',()=>{
  const matrix=poseMatrix(pose);close(transformPoint(matrix,pose.pivot),pose.pivot);
  for(const p of [[0,0,0],[50,10,-200],[1e7,-1e6,20]])close(sourcePoint(matrix,transformPoint(matrix,p)),p);
  const a=[1,2,3],b=[40,20,10],ra=transformPoint(matrix,a),rb=transformPoint(matrix,b);
  close([Math.hypot(...a.map((x,i)=>x-b[i]))],[Math.hypot(...ra.map((x,i)=>x-rb[i]))]);
  assert.deepEqual(poseMatrix({...pose,enabled:false}),poseMatrix(null));
});
test('fixed X Y Z Euler order and gimbal-lock conversion preserve the matrix',()=>{
  close(transformPoint(poseMatrix({enabled:true,pivot:[0,0,0],rotation:rotationFromAngles([90,90,0])}),[0,1,0]),[1,0,0]);
  for(const angles of [[23,47,-170],[-180,-90,75],[12,90,20],[95,145,-135]])close(rotationFromAngles(anglesFromRotation(rotationFromAngles(angles))).flat(),rotationFromAngles(angles).flat());
});
test('reference face including antiparallel normals and three points align to every target plane',()=>{
  for(let axis=0;axis<3;axis++){
    const normal=[0,0,0];normal[axis]=-1;const target=[0,0,0];target[axis]=1;
    close(transformPoint(poseMatrix({enabled:true,pivot:[0,0,0],rotation:faceRotation(normal,axis)}),normal),target);
    const points=[[10,20,30],[12,21,33],[8,25,31]],matrix=poseMatrix({...pose,rotation:pointsRotation(points,axis)}),result=points.map(p=>transformPoint(matrix,p));
    close(result.map(p=>p[axis]),[result[0][axis],result[0][axis],result[0][axis]]);
    const u=axis===0?1:0;assert.ok(result[1][u]>result[0][u]);
    close([new THREE.Matrix3().set(...pointsRotation(points,axis).flat()).determinant()],[1]);
  }
  assert.throws(()=>pointsRotation([[0,0,0],[1,1,1],[2,2,2]],2),/共线/);
  assert.throws(()=>pointsRotation([[0,0,0],[0,0,0],[1,1,1]],2),/重合/);
  close(pointsRotation([[0,0,0],[1e-10,0,0],[0,1e-10,0]],2).flat(),IDENTITY.flat());
});
test('rotated mesh intersections match transformed geometry, retain every face and reject allocation overflow',()=>{
  const matrix=poseMatrix(pose),original=vertices.slice(),faces=indices.slice(),rotated=new Float64Array(vertices.length);
  for(let i=0;i<vertices.length;i+=3)rotated.set(transformPoint(matrix,Array.from(vertices.slice(i,i+3))),i);
  const index=buildSectionIndex(vertices,indices,[[0,0,0],[1,1,1]],4);
  const center=transformPoint(matrix,[.25,.25,.25]);
  const sort=x=>Array.from({length:x.length/6},(_,i)=>Array.from(x.slice(i*6,i*6+6),n=>n.toFixed(5)).join(',')).sort();
  for(let axis=0;axis<3;axis++){
    const normal=[0,0,0];normal[axis]=1;const constant=-center[axis],p=sourcePlane(matrix,normal,constant);
    const cut=sectionContours(vertices,indices,p.normal,p.constant,center,2,1e-9,matrix,queryPlaneIndex(index,p.normal,p.constant,1e-9));
    const full=sectionContours(rotated,indices,normal,constant,center,2,1e-9);
    assert.deepEqual(sort(cut.lines),sort(full.lines));for(let i=axis;i<cut.lines.length;i+=3)close([cut.lines[i]],[0]);
    assert.throws(()=>sectionContours(vertices,indices,p.normal,p.constant,center,2,1e-9,matrix,null,1),/未截断或自动简化/);
  }
  assert.deepEqual(vertices,original);assert.deepEqual(indices,faces);assert.equal(index.faces.length,indices.length/3);
});
test('scene pose changes reuse full mesh buffers and also transform the CT grid matrix',()=>{
  const group=new THREE.Group(),geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(vertices,3));geometry.setIndex(new THREE.BufferAttribute(indices,1));
  const mesh=new THREE.Mesh(geometry);group.add(mesh);
  const sourceBounds=new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(1,1,1));
  const volume={meta:{matrix:[[2,0,0,10],[0,3,0,20],[0,0,4,30],[0,0,0,1]]},mesh:new THREE.Mesh(),planes:[new THREE.Mesh()],outlines:[new THREE.Line()]};
  group.add(volume.mesh,...volume.planes,...volume.outlines);
  const view={group,sourceBounds,mesh,volume,alignment:new THREE.Matrix4(),grid:new THREE.Group(),axes:new THREE.Group(),box:new THREE.Box3Helper(sourceBounds.clone())};
  const matrix=poseMatrix({...pose,mirror:[true,false,false]});SceneView.prototype.setAlignment.call(view,matrix);
  assert.equal(mesh.geometry.attributes.position.array,vertices);assert.equal(mesh.geometry.index.array,indices);
  const expected=new THREE.Matrix4().set(...matrix.flat()).multiply(new THREE.Matrix4().set(...volume.meta.matrix.flat()));
  for(const o of [volume.mesh,...volume.planes,...volume.outlines])close(o.matrix.elements,expected.elements);
  close(mesh.matrix.elements,new THREE.Matrix4().set(...matrix.flat()).elements);
});
test('pose generation rejects stale progressive mesh frames while retaining the one geometry upload',()=>{
  const saved=globalThis.Worker;let worker;globalThis.Worker=class{constructor(){worker=this;this.messages=[];}postMessage(data){this.messages.push(data);}terminate(){}};
  try{
    const bounds=new THREE.Box3(new THREE.Vector3(),new THREE.Vector3(1,1,1)),view={scene:new THREE.Scene(),bounds,sourceBounds:bounds.clone(),alignment:new THREE.Matrix4(),group:{scale:{x:2}}},results=[];
    const controller=new MeshSections(view,data=>results.push(data),()=>{});controller.source({arrays:{positions:vertices,indices}});controller.setActive(true);controller.update([.2,.3,.4]);worker.onmessage({data:{type:'ready'}});
    const old=worker.messages.at(-1);view.alignment.makeRotationZ(.5);controller.alignmentChanged();controller.update([.3,.4,.5]);
    const lines=[new Float32Array(),new Float32Array(),new Float32Array()];worker.onmessage({data:{...old,type:'sections',phase:'lines',lines}});assert.equal(results.length,0);
    const current=worker.messages.at(-1);worker.onmessage({data:{...current,type:'sections',phase:'lines',lines}});assert.equal(results.length,1);
    assert.equal(worker.messages.filter(m=>m.type==='mesh').length,1);controller.clear();
  }finally{globalThis.Worker=saved;}
});
test('label MPR returns to 3D and restores pane navigation on repeated toggles',()=>{
  const h=viewHarness({kind:'labels',mode:'mpr',meshMPR:false,active:false,renderer:true,preview:true,grid:true});h.state.labelMPRAvailable=true;const controls=createViewControls(h);
  for(let i=0;i<5;i++){controls.toggleMPR();assert.equal(h.mpr.active,true);controls.show3D();assert.equal(h.mpr.active,false);}
  assert.deepEqual(h.mpr.indices,[3,4,5]);assert.deepEqual(h.mpr.panes.map(p=>p.zoom),[1.5,2,.75]);
});
test('aligned CT three-dimensional slice mode requests world planes without entering the four-pane layout',()=>{
  const h=viewHarness({kind:'volume',mode:'slices',active:true,renderer:true,preview:true,grid:true}),requests=[];
  h.mpr.kind='reslice';h.mpr.id='ct';h.mpr.reslicePlanes={setActive(active){requests.push(['planes',active]);},setDisplayMode(){}};
  h.mpr.position=xyz=>requests.push(['position',xyz]);h.mpr.setStandalone=MPRView.prototype.setStandalone;
  const controls=createViewControls(h);controls.updateVolumeMode();assert.equal(h.mpr.active,false);assert.equal(h.mpr.standalone,true);assert.ok(requests.some(r=>r[0]==='position'));
  h.element('volume-mode').value='mip';controls.updateVolumeMode();assert.equal(h.mpr.standalone,false);assert.deepEqual(requests.at(-1),['planes',false]);
  controls.toggleMPR();assert.equal(h.mpr.active,true);controls.show3D();assert.equal(h.mpr.active,false);assert.equal(h.mpr.standalone,false);
});
test('reslice coordinates use world units, image pixels and source point picking consistently',()=>{
  const view={kind:'reslice',info:{origin:[10,20,30],spacing:[2,3,4],bounds:[[9,18.5,28],[19,30.5,40]]},shape:[5,4,3],indices:[14,23,34],pixelIndex:MPRView.prototype.pixelIndex};
  for(let a=0;a<3;a++){close([MPRView.prototype.pixelIndex.call(view,a,MPRView.prototype.worldIndex.call(view,a,1.25))],[1.25]);close([MPRView.prototype.step.call(view,a)],[view.info.spacing[a]]);}
  close(MPRView.prototype.crosshairFocus.call(view,{axis:2}),[2.5,2.5]);assert.equal(MPRView.prototype.clamp.call(view,0,999),19);
});
test('reslice locator planes stay axis aligned and hide stale textures after moving',()=>{
  const view={scene:new THREE.Scene(),bounds:new THREE.Box3(new THREE.Vector3(10,20,30),new THREE.Vector3(20,40,60)),group:{scale:{x:.1}},theme:THEMES.mono,renderer:{capabilities:{maxTextureSize:8192}}};
  const planes=new ReslicePlanes(view),info={shape_xyz:[5,4,3],spacing:[2,5,10],origin:[11,22.5,35]};planes.source(info);planes.setActive(true);planes.position([13,28,42]);
  for(let axis=0;axis<3;axis++){
    const p=new THREE.Vector3(.2,-.3,0).applyMatrix4(planes.planes[axis].matrix);close([p.getComponent(axis)],[([13,28,42][axis]-[15,30,45][axis])*.1]);
    assert.equal(planes.image(axis,{width:5,height:4}),true);assert.equal(planes.planes[axis].visible,true);
  }
  planes.position([14,28,42]);assert.equal(planes.planes[0].visible,false);assert.equal(planes.planes[1].visible,true);assert.equal(planes.image(0,{width:99999,height:2}),false);
  planes.clear();assert.equal(planes.root.children.length,0);
  assert.doesNotThrow(()=>planes.position([0,0,0]),'cleared locators must not retain a stale grid');
});

test('MPR shows the same complete volume as 3D, with only locator outlines overlaid',()=>{
  const volume={mesh:new THREE.Mesh(),planes:[new THREE.Mesh(),new THREE.Mesh(),new THREE.Mesh()],outlines:[new THREE.Line(),new THREE.Line(),new THREE.Line()],material:{uniforms:{uMode:{value:0}}}};
  const view={volume,volumeMode:SceneView.prototype.volumeMode};
  for(const mode of ['mip','iso']){
    SceneView.prototype.volumeGuides.call(view,true);view.volumeMode(mode);
    assert.equal(volume.mesh.visible,true);assert.ok(volume.planes.every(p=>!p.visible));assert.ok(volume.outlines.every(p=>p.visible));
    assert.equal(volume.material.uniforms.uMode.value,mode==='iso'?1:0);
    SceneView.prototype.volumeGuides.call(view,false);assert.equal(volume.mesh.visible,true);assert.ok(volume.outlines.every(p=>!p.visible));
  }
  view.volumeMode('slices');assert.equal(volume.mesh.visible,false);assert.ok(volume.planes.every(p=>p.visible));
});

test('aligned locator guides hide filled slices in MPR and restore them in explicit 3D slice mode',()=>{
  const view={scene:new THREE.Scene(),bounds:new THREE.Box3(new THREE.Vector3(),new THREE.Vector3(10,10,10)),group:{scale:{x:.2}},theme:THEMES.ocean,renderer:{capabilities:{maxTextureSize:8192}}};
  const planes=new ReslicePlanes(view);planes.source({shape_xyz:[10,10,10],spacing:[1,1,1],origin:[.5,.5,.5]});planes.setActive(true);planes.setDisplayMode('guides');planes.position([5,5,5]);
  for(let axis=0;axis<3;axis++)planes.image(axis,{width:10,height:10});
  assert.ok(planes.planes.every(p=>!p.visible));assert.ok(planes.edges.every(p=>p.visible));
  planes.setDisplayMode('slices');assert.ok(planes.planes.every(p=>p.visible));planes.clear();
});

test('CT locator preview remains visible during full-resolution work and uses the transformed volume texture',()=>{
  const group=new THREE.Group(),volumeMesh=new THREE.Mesh(),data=new THREE.Data3DTexture(new Uint8Array(8),2,2,2);volumeMesh.matrixAutoUpdate=false;group.add(volumeMesh);
  const view={scene:new THREE.Scene(),group,sourceBounds:new THREE.Box3(new THREE.Vector3(-.02,-.03,-.04),new THREE.Vector3(.02,.03,.04)),alignment:new THREE.Matrix4(),
    volume:{mesh:volumeMesh,planes:[],outlines:[],meta:{matrix:[[.04,0,0,0],[0,.06,0,0],[0,0,.08,0],[0,0,0,1]]},common:{uData:{value:data},uWindow:{value:new THREE.Vector2(0,1)},uOpacity:{value:1}}},
    grid:new THREE.Group(),axes:new THREE.Group(),theme:THEMES.ocean,renderer:{capabilities:{maxTextureSize:8192}}};view.scene.add(group);
  const planes=new ReslicePlanes(view);let disposed=0;data.addEventListener('dispose',()=>disposed++);
  for(const angles of [[1,0,0],[0,90,0],[20,30,40]]){
    SceneView.prototype.setAlignment.call(view,poseMatrix({enabled:true,rotation:rotationFromAngles(angles),pivot:[0,0,0],mirror:[true,false,false]}));
    const low=view.bounds.min.toArray(),high=view.bounds.max.toArray(),spacing=low.map((x,i)=>(high[i]-x)/10),info={shape_xyz:[10,10,10],spacing,origin:low.map((x,i)=>x+spacing[i]/2)};
    planes.source(info);planes.setActive(true);planes.position([0,0,0]);view.scene.updateMatrixWorld(true);
    assert.equal(planes.fallbacks.filter(p=>p.visible).length,3);assert.ok(planes.planes.every(p=>!p.visible));
    for(let axis=0;axis<3;axis++){
      const fallback=planes.fallbacks[axis],uniforms=fallback.material.uniforms;
      assert.equal(uniforms.uData,view.volume.common.uData);
      const center=new THREE.Vector3().applyMatrix4(fallback.matrixWorld).applyMatrix4(uniforms.uWorldToVolume.value);close(center.toArray(),[0,0,0]);
      assert.equal(planes.image(axis,{width:10,height:10}),true);assert.equal(fallback.visible,false);assert.equal(planes.planes[axis].visible,true);
    }
    planes.position([spacing[0],0,0]);assert.equal(planes.fallbacks[0].visible,true);assert.equal(planes.planes[0].visible,false);assert.equal(planes.planes[1].visible,true);
  }
  planes.clear();assert.equal(disposed,0,'the locator must not dispose the shared CT volume texture');assert.equal(planes.info,null);data.dispose();
});
