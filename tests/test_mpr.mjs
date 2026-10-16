import test from 'node:test';
import assert from 'node:assert/strict';
import { planeTransform, imageToScreen, screenToIndices, IN_PLANE, clampIndex, LatestRequest } from '../viewer/web/mpr-math.js';
import {clampZoom,zoomImageTransform,zoomMeshTransform,panImageFocus,panMeshFocus} from '../viewer/web/pane-view.js';
import {meshPlaneTransform,meshToScreen,screenToMesh} from '../viewer/web/mesh-sections-math.js';
import {MPRView} from '../viewer/web/mpr.js';

const shape=[5,4,3],matrix=[[0,-3,0,10],[2,0,1,20],[0,0,4,30],[0,0,0,1]];
test('zoomed and panned volume planes pick the original voxel across all axes',()=>{
  for(let axis=0;axis<3;axis++)for(const zoom of [.25,1,3.5,8]){
    const base=planeTransform(shape,matrix,axis,400,300),focus=[base.cols*.35,base.rows*.65];
    const t=zoomImageTransform(base,zoom,400,300,focus),[u,v]=IN_PLANE[axis];
    for(let x=0;x<shape[u];x++)for(let y=0;y<shape[v];y++)assert.deepEqual(screenToIndices(t,...imageToScreen(t,x+.5,t.rows-y-.5)),[x,y]);
    const next=panImageFocus(t,focus,23,-17),moved=zoomImageTransform(base,zoom,400,300,next),before=imageToScreen(t,1.5,1.5),after=imageToScreen(moved,1.5,1.5);
    assert.ok(Math.abs(after[0]-before[0]-23)<1e-9);assert.ok(Math.abs(after[1]-before[1]+17)<1e-9);
  }
});
test('mesh zoom preserves source-coordinate picking and pan direction',()=>{
  const bounds=[[-2,-3,-4],[2,3,4]];
  for(let axis=0;axis<3;axis++)for(const zoom of [.25,1,4,8]){
    const base=meshPlaneTransform(bounds,axis,500,300),focus=[.2,-.3],t=zoomMeshTransform(base,zoom,500,300,focus),xy=meshToScreen(t,.1,.2);
    const point=screenToMesh(t,...xy);assert.ok(Math.abs(point[0]-.1)<1e-9&&Math.abs(point[1]-.2)<1e-9);
    const after=meshToScreen(zoomMeshTransform(base,zoom,500,300,panMeshFocus(t,focus,-19,24)),.1,.2);
    assert.ok(Math.abs(after[0]-xy[0]+19)<1e-9&&Math.abs(after[1]-xy[1]-24)<1e-9);
  }
  assert.equal(clampZoom(100),8);assert.equal(clampZoom(-1),.25);assert.equal(clampZoom(NaN),1);
});
test('each pane retains its own zoom during time changes and resets on another object',()=>{
  const view={id:'same',probe:{reset(){}},meshSections:{clear(){}},active:false,
    panes:[2,3,4].map(z=>({zoom:z,focus:[1,2],zoomInput:{value:z*100},zoomOutput:{textContent:z*100+'%'},queue:{reset(){}},canvas:{dataset:{}}})),
    resetPane:MPRView.prototype.resetPane,resetViews:MPRView.prototype.resetViews};
  MPRView.prototype.source.call(view,'same',{grid:{shape_tzyx:[2,3,4,5]}},1,[1,1,1]);assert.deepEqual(view.panes.map(p=>p.zoom),[2,3,4]);
  view.resetPane(view.panes[1]);assert.deepEqual(view.panes.map(p=>p.zoom),[2,1,4]);
  MPRView.prototype.source.call(view,'new',{grid:{shape_tzyx:[1,3,4,5]}},0,[1,1,1]);assert.deepEqual(view.panes.map(p=>p.zoom),[1,1,1]);assert.ok(view.panes.every(p=>p.focus===null));
});
test('three planes invert every voxel center including anisotropy, shear, rotation and edges',()=>{
  for(let axis=0;axis<3;axis++){
    const t=planeTransform(shape,matrix,axis,400,300),[u,v]=IN_PLANE[axis];
    for(let i=0;i<shape[u];i++)for(let j=0;j<shape[v];j++){
      const point=imageToScreen(t,i+.5,t.rows-j-.5);
      assert.deepEqual(screenToIndices(t,...point),[i,j]);
    }
    const point=imageToScreen(t,-2,-2);assert.equal(screenToIndices(t,...point),null);
  }
  const t=planeTransform(shape,matrix,2,400,300);
  assert.ok(Math.abs(t.a/t.d-2/3)<1e-12);
});
test('single-voxel planes and index boundaries stay selectable',()=>{
  const t=planeTransform([1,1,1],matrix,0,100,100);
  assert.deepEqual(screenToIndices(t,...imageToScreen(t,.5,.5)),[0,0]);
  assert.equal(clampIndex(-20,1),0);assert.equal(clampIndex(100,5),4);
});
test('linked navigation bounds requests, discards old responses and applies latest',async()=>{
  const pending=[],accepted=[],errors=[];
  const queue=new LatestRequest((value,signal)=>new Promise(resolve=>pending.push({value,resolve,signal})),value=>accepted.push(value),e=>errors.push(e));
  queue.submit(1);for(let i=2;i<=50;i++)queue.submit(i);
  assert.equal(pending.length,1);pending[0].resolve(1);await new Promise(r=>setImmediate(r));
  assert.deepEqual(accepted,[]);assert.equal(pending.length,2);assert.equal(pending[1].value,50);
  pending[1].resolve(50);await new Promise(r=>setImmediate(r));assert.deepEqual(accepted,[50]);
  queue.submit(51);queue.reset();queue.submit(100);assert.equal(pending[2].signal.aborted,true);
  pending[2].resolve(51);await new Promise(r=>setImmediate(r));pending[3].resolve(100);await new Promise(r=>setImmediate(r));
  assert.deepEqual(accepted,[50,100]);assert.deepEqual(errors,[]);
});
test('progressive slice requests refresh during motion but never leak results from another object',async()=>{
  const waiting=[],accepted=[];const queue=new LatestRequest(value=>new Promise(resolve=>waiting.push({value,resolve})),value=>accepted.push(value),()=>{},true);
  queue.submit(1);queue.submit(2);waiting[0].resolve(1);await new Promise(r=>setImmediate(r));assert.deepEqual(accepted,[1]);
  queue.reset();queue.submit(3);waiting[1].resolve(2);await new Promise(r=>setImmediate(r));assert.deepEqual(accepted,[1]);
  waiting[2].resolve(3);await new Promise(r=>setImmediate(r));assert.deepEqual(accepted,[1,3]);
});
