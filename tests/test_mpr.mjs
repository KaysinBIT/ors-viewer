import test from 'node:test';
import assert from 'node:assert/strict';
import { planeTransform, imageToScreen, screenToIndices, IN_PLANE, clampIndex, LatestRequest } from '../viewer/web/mpr-math.js';

const shape=[5,4,3],matrix=[[0,-3,0,10],[2,0,1,20],[0,0,4,30],[0,0,0,1]];
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
