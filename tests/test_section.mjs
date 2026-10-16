import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionSegments, sectionContours } from '../viewer/web/section-math.js';
import { obliqueSectionFill, planeBasis } from '../viewer/web/section-fill.js';
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

test('oblique fill preserves holes, area and plane coordinates for rotated and reversed normals',()=>{
  for(const normal of [[1,2,3],[0,0,1],[0,0,-1],[1e-12,0,1]]){
    const {u,v,normal:n}=planeBasis(normal),point=[.25,-.4,.7],lines=[];
    const world=xy=>point.map((p,d)=>p+xy[0]*u[d]+xy[1]*v[d]);
    for(const ring of [[[-2,-2],[2,-2],[2,2],[-2,2]],[[-1,-1],[-1,1],[1,1],[1,-1]]]){
      ring.forEach((p,i)=>lines.push(...world(p),...world(ring[(i+1)%ring.length])));
    }
    const raw=new Float32Array(lines),before=raw.slice(),fill=obliqueSectionFill(raw,normal,point);
    assert.equal(fill.status,'filled');assert.equal(fill.holes,1);assert.ok(Math.abs(fill.area-12)<1e-5);
    for(let i=0;i<fill.positions.length;i+=3){
      const distance=n.reduce((sum,x,d)=>sum+x*(fill.positions[i+d]-point[d]),0);
      assert.ok(Math.abs(distance)<1e-6);
    }
    for(let i=0;i<fill.indices.length;i+=3){
      const center=[0,0,0];for(const k of fill.indices.subarray(i,i+3))for(let d=0;d<3;d++)center[d]+=fill.positions[k*3+d]/3-point[d]/3;
      const x=center.reduce((sum,p,d)=>sum+p*u[d],0),y=center.reduce((sum,p,d)=>sum+p*v[d],0);
      assert.ok(Math.abs(x)>=1-1e-6||Math.abs(y)>=1-1e-6,'triangle must not cover the hole');
    }
    assert.deepEqual(raw,before);
  }
});

test('real oblique intersections fill the transformed tetrahedron without modifying its mesh',()=>{
  const normal=[1,1,1].map(v=>v/Math.sqrt(3)),point=[-2/3,-2/3,-2/3];
  const before=vertices.slice(),faces=triangles.slice();
  const section=sectionContours(vertices,triangles,normal,-.5/Math.sqrt(3),[.5,.5,.5],2,1e-10);
  const fill=obliqueSectionFill(section.lines,normal,point,section.coplanarFlags);
  assert.equal(fill.status,'filled');assert.equal(fill.loops,1);assert.equal(fill.holes,0);
  assert.ok(Math.abs(fill.area-Math.sqrt(3)/2)<1e-6);
  assert.deepEqual(vertices,before);assert.deepEqual(triangles,faces);
});

test('coplanar triangle patches fill their boundary and open oblique contours stay unfilled',()=>{
  const square=new Float32Array([0,0,0,1,0,0,1,1,0,0,1,0]),faces=new Uint32Array([0,1,2,0,2,3]);
  const section=sectionContours(square,faces,[0,0,1],0,[0,0,0],1,1e-10);
  assert.equal(section.coplanarFlags.length,6);
  const fill=obliqueSectionFill(section.lines,[0,0,1],[0,0,0],section.coplanarFlags);
  assert.equal(fill.status,'filled');assert.equal(fill.area,1);assert.equal(fill.boundary.length,24);
  const raw=new Float32Array([0,0,0,1,0,0,1,0,0,1,1,0]),before=raw.slice();
  assert.equal(obliqueSectionFill(raw,[0,0,1],[0,0,0]).status,'open');assert.deepEqual(raw,before);
});

test('section cap modes share geometry, reject stale fills and clean up retained results',()=>{
  const previous=globalThis.Worker;let worker;
  globalThis.Worker=class{constructor(){worker=this;this.messages=[];}postMessage(data){this.messages.push(data);}terminate(){this.terminated=true;}};
  try{
    const geometry=new THREE.BufferGeometry(),material=new THREE.MeshBasicMaterial(),mesh=new THREE.Mesh(geometry,material),group=new THREE.Group();group.add(mesh);
    const view={scene:new THREE.Scene(),renderer:{},group,mesh,materials:[material],packet:{arrays:{positions:vertices,indices:triangles}},
      bounds:new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(1,1,1)),canvas:{dataset:{}}};
    const controller=new SectionController(view);controller.update({enabled:true,distance:-.25});
    worker.onmessage({data:{type:'ready'}});const job=worker.messages.at(-1);
    const contour=sectionContours(vertices,triangles,job.normal,job.constant,job.center,job.scale,job.epsilon);
    const fill=obliqueSectionFill(contour.lines,job.normal,job.point,contour.coplanarFlags);
    worker.onmessage({data:{type:'section',revision:job.revision,lines:contour.lines,fillPending:true}});
    assert.equal(controller.cap.visible,false);assert.equal(controller.exact.visible,true);assert.equal(controller.ready(),false);
    worker.onmessage({data:{type:'fill',revision:job.revision,fill}});
    assert.equal(controller.cap.visible,true);assert.equal(controller.ready(),true);const capGeometry=controller.cap.geometry,requestCount=worker.messages.length;
    controller.setDisplay('fill',.6);assert.equal(controller.exact.visible,false);assert.equal(controller.cap.material.opacity,.6);
    controller.setDisplay('line',.6);assert.equal(controller.cap.visible,false);assert.equal(controller.exact.visible,true);
    controller.setDisplay('both',.6);assert.equal(controller.cap.geometry,capGeometry);assert.equal(worker.messages.length,requestCount);
    controller.update({distance:0,only:true});assert.equal(controller.cap.visible,false);assert.equal(view.mesh.visible,false);
    worker.onmessage({data:{type:'fill',revision:job.revision,fill}});assert.equal(controller.cap.visible,false);
    const current=worker.messages.at(-1);
    worker.onmessage({data:{type:'section',revision:current.revision,lines:contour.lines,fillPending:true}});
    worker.onmessage({data:{type:'fill-error',revision:current.revision}});
    assert.equal(controller.exact.visible,true);assert.equal(controller.fill.status,'invalid');
    controller.update({enabled:false});assert.equal(controller.cap.visible,false);assert.equal(view.mesh.visible,true);
    controller.clear();assert.equal(controller.fill,null);assert.equal(controller.resultLines,null);assert.equal(controller.packet,null);assert.equal(worker.terminated,true);
    worker.onerror();assert.equal(controller.workerFailed,false,'cleared workers must not affect a new view');
  }finally{globalThis.Worker=previous;}
});
test('section worker publishes contours first and cancels superseded fill jobs',async()=>{
  const originalSelf=globalThis.self,messages=[];let complete;
  const finished=new Promise(resolve=>complete=resolve);
  globalThis.self={postMessage(data){messages.push(data);if(data.type==='fill'||data.type==='fill-error')complete(data);}};
  let timeout;
  try{
    await import('../viewer/web/section-worker.js');
    self.onmessage({data:{type:'mesh',positions:vertices,indices:triangles}});
    const common={type:'section',center:[0,0,0],scale:1,epsilon:1e-10};
    self.onmessage({data:{...common,revision:1,normal:[1,0,0],constant:-.25,point:[.25,0,0]}});
    self.onmessage({data:{...common,revision:2,normal:[0,0,1],constant:-.5,point:[0,0,.5]}});
    const result=await Promise.race([finished,new Promise((_,reject)=>timeout=setTimeout(()=>reject(Error('Fill did not complete')),2000))]);
    assert.equal(result.type,'fill');assert.equal(result.revision,2);assert.equal(result.fill.status,'filled');
    assert.deepEqual(messages.filter(m=>m.type==='fill').map(m=>m.revision),[2]);
    assert.deepEqual(messages.filter(m=>m.type==='section').map(m=>m.revision),[1,2]);
    assert.ok(Math.abs(result.fill.area-.125)<1e-6);
  }finally{clearTimeout(timeout);globalThis.self=originalSelf;}
});
