import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionSegments } from '../viewer/web/section-math.js';
import { SectionController } from '../viewer/web/section.js';
import { SceneView } from '../viewer/web/scene.js';
import * as THREE from '../viewer/web/vendor/three.module.js';

const vertices=new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1]);
const triangles=new Uint32Array([0,2,1,0,1,3,1,2,3,2,0,3]);
test('tetrahedron section is a triangle at x = 0.25',()=>{
  const lines=sectionSegments(vertices,triangles,[1,0,0],-.25,[0,0,0],1,1e-10);
  assert.equal(lines.length,18);
  for(let i=0;i<lines.length;i+=3)assert.equal(lines[i],.25);
  const points=new Set(Array.from({length:6},(_,i)=>Array.from(lines.slice(i*3,i*3+3)).join(',')));
  assert.deepEqual(points,new Set(['0.25,0,0','0.25,0.75,0','0.25,0,0.75']));
});
test('oblique plane and world transform are respected without modifying source arrays',()=>{
  const before=vertices.slice(),faces=triangles.slice();
  const lines=sectionSegments(vertices,triangles,[1,1,1],-.5,[.5,.5,.5],2,1e-10);
  assert.equal(lines.length,18);
  for(let i=0;i<lines.length;i+=3)assert.ok(Math.abs(lines[i]+lines[i+1]+lines[i+2]+2)<1e-6);
  assert.deepEqual(vertices,before);assert.deepEqual(triangles,faces);
});
test('outside and vertex-tangent planes do not create zero-length lines',()=>{
  assert.equal(sectionSegments(vertices,triangles,[1,0,0],-2,[0,0,0],1,1e-10).length,0);
  assert.equal(sectionSegments(vertices,triangles,[1,1,1],0,[0,0,0],1,1e-10).length,0);
});
test('moving section reuses GPU resources and rejects stale worker results',()=>{
  const workers=[];const OriginalWorker=globalThis.Worker;
  globalThis.Worker=class { constructor(){this.messages=[];workers.push(this);} postMessage(m){this.messages.push(m);} terminate(){this.terminated=true;} };
  try{
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(vertices,3));geometry.setIndex(new THREE.BufferAttribute(triangles,1));
    const material=new THREE.MeshBasicMaterial(),mesh=new THREE.Mesh(geometry,material),group=new THREE.Group();group.add(mesh);group.scale.setScalar(2);
    const view={scene:new THREE.Scene(),renderer:{},group,mesh,materials:[material],packet:{arrays:{positions:vertices,indices:triangles}},
      bounds:new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(1,1,1)),canvas:{dataset:{}}};
    const controller=new SectionController(view);controller.update({enabled:true,distance:0});
    const guide=controller.guide,live=controller.live,worker=workers[0];worker.onmessage({data:{type:'ready'}});
    const initialJob=worker.messages.at(-1);
    for(let i=1;i<=20;i++)controller.update({distance:i/100});
    assert.equal(controller.guide,guide);assert.equal(controller.live,live);
    assert.equal(live.geometry,geometry);assert.equal(worker.messages.length,2);
    worker.onmessage({data:{type:'section',revision:initialJob.revision,lines:new Float32Array(6)}});
    assert.equal(controller.exact.visible,false);assert.equal(controller.live.visible,true);
    const latest=worker.messages.at(-1);assert.equal(latest.revision,controller.revision);
    assert.equal(latest.constant,-.7);
    worker.onmessage({data:{type:'section',revision:latest.revision,lines:new Float32Array([0,0,0,0,1,0])}});
    assert.equal(controller.exact.visible,true);assert.equal(controller.segmentCount,1);
    controller.clear();assert.equal(worker.terminated,true);
    assert.deepEqual(vertices,new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1]));
  }finally{globalThis.Worker=OriginalWorker;}
});
test('following a section preserves orthographic zoom and camera allocation',()=>{
  const camera=new THREE.OrthographicCamera(-2,2,2,-2,.01,100);camera.aspect=1;camera.zoom=2.75;
  camera.up.set(0,0,1);camera.position.set(6,0,0);
  const view={camera,controls:{target:new THREE.Vector3(),update(){camera.lookAt(this.target);}},
    replaceCamera(){throw new Error('Unnecessary camera replacement');}};
  const normal=new THREE.Vector3(1,1,.3).normalize(),point=normal.clone().multiplyScalar(.4);
  SceneView.prototype.sectionView.call(view,normal,point,false);
  assert.equal(view.camera,camera);assert.equal(camera.zoom,2.75);assert.equal(camera.top,2);
  assert.ok(view.controls.target.distanceTo(point)<1e-12);
  assert.ok(Math.abs(camera.getWorldDirection(new THREE.Vector3()).dot(normal)+1)<1e-12);
});
