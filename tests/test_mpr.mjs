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

test('pose changes retain the last valid pixels while invalidating requests and point picking',()=>{
  const panes=[0,1,2].map(axis=>({axis,packet:{meta:{shape_yx:[12,7]}},loadedKey:'previous',key:'previous',loadedGeneration:1,focus:[3,6],zoom:2,transform:{},status:{},panel:{classList:{add(){}}},queue:{reset(cancel){assert.equal(cancel,false);}}}));
  const packets=panes.map(p=>p.packet),view={id:'volume',time:0,kind:'volume',generation:1,active:true,panes,probe:{reset(){}},readout:{},draw(){},position(){assert.equal(this.suspended,true);},reslicePlanes:{source(){},setActive(){}},meshSections:{clear(){}}};
  MPRView.prototype.beginReslice.call(view);assert.equal(view.suspended,true);assert.deepEqual(panes.map(p=>p.packet),packets);assert.ok(panes.every(p=>p.transform===null));
  const info={shape_xyz:[20,24,30],bounds:[[0,0,0],[20,24,30]]};
  MPRView.prototype.resliceSource.call(view,'volume',info,{enabled:true},0,[10,12,15]);
  assert.deepEqual(panes.map(p=>p.packet),packets);assert.ok(panes.every(p=>p.loadedGeneration!==view.generation));
  assert.ok(panes.every(p=>p.zoom===2));assert.equal(MPRView.prototype.ready.call(view),false);
  view.active=false;
  MPRView.prototype.resliceSource.call(view,'different-volume',info,{enabled:true},0,[10,12,15]);
  assert.ok(panes.every(p=>p.packet===null),'frames must never leak between datasets');
});

test('retained images use their own dimensions and affine until the new pose arrives',()=>{
  const savedWindow=globalThis.window,transforms=[],drawn=[],canvas={dataset:{},getContext:()=>context};
  const context={setTransform(){},fillRect(){},save(){},restore(){},transform(...v){transforms.push(v);},drawImage(image){drawn.push(image);}};
  const p={axis:2,zoom:1,focus:null,canvas,image:{width:7,height:12},body:{getBoundingClientRect:()=>({width:400,height:300})},packet:{meta:{shape_yx:[12,7],voxel_xyz_to_world:[[.00004,0,0,0],[0,.00004,0,0],[0,0,.00004,0],[0,0,0,1]]}},loadedGeneration:1,loadedKey:'old',key:'new'};
  const view={active:true,id:'volume',kind:'reslice',generation:2,suspended:true,shape:[100,300,100],theme:{canvas:'#000'},paneFocus:MPRView.prototype.paneFocus};
  globalThis.window={devicePixelRatio:1};
  try{
    MPRView.prototype.draw.call(view,p);assert.equal(drawn[0],p.image);
    const [a,,c,d,e,f]=transforms[0];assert.ok(Math.abs(e+a*3.5+c*6-200)<1e-8);assert.ok(Math.abs(f+d*6-150)<1e-8);
    assert.equal(p.transform,null,'stale images must not be interpreted in the new coordinate system');
  }finally{globalThis.window=savedWindow;}
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

function maximizedView(){
  const classList=()=>({values:new Set(),toggle(name,on){on?this.values.add(name):this.values.delete(name);}});
  const view={active:true,maximizedAxis:null,indices:[2,3,4],layout:{classList:classList(),dataset:{}},draw(){},scene:{dirty:false},
    panes:[0,1,2].map(axis=>({axis,zoom:axis+1,focus:[axis,axis+1],panel:{classList:classList()},maximizeButton:{attributes:{},setAttribute(k,v){this.attributes[k]=v;}}})),
    visiblePanes:MPRView.prototype.visiblePanes};
  view.setMaximized=MPRView.prototype.setMaximized;return view;
}
test('each plane maximizes independently and restoring keeps source position, zoom and pan',()=>{
  const view=maximizedView(),before=view.panes.map(p=>({zoom:p.zoom,focus:p.focus.slice()}));
  for(const axis of [0,1,2]){
    view.setMaximized(axis);assert.deepEqual(view.visiblePanes().map(p=>p.axis),[axis]);
    assert.equal(view.panes[axis].maximizeButton.attributes['aria-pressed'],'true');
    assert.ok(view.panes.filter(p=>p.panel.classList.values.has('is-maximized')).length===1);
  }
  view.setMaximized(null);assert.equal(view.visiblePanes().length,3);assert.equal(view.layout.dataset.maximizedAxis,undefined);
  assert.deepEqual(view.indices,[2,3,4]);assert.deepEqual(view.panes.map(p=>({zoom:p.zoom,focus:p.focus})),before);
  view.active=false;view.setMaximized(1);assert.equal(view.maximizedAxis,null);
});
test('maximized screenshot readiness only waits for its visible plane and the current readout',()=>{
  const view=maximizedView();Object.assign(view,{kind:'volume',id:'object',time:1,readout:{dataset:{xyz:'2,3,4',time:'1',object:'object'}}});
  Object.assign(view.panes[2],{packet:{},loadedKey:'latest',key:'latest'});view.setMaximized(2);
  assert.equal(MPRView.prototype.ready.call(view),true);
  view.readout.dataset.time='0';assert.equal(MPRView.prototype.ready.call(view),false);view.readout.dataset.time='1';
  view.setMaximized(null);assert.equal(MPRView.prototype.ready.call(view),false);
});
test('maximized export draws only the visible canvas and skips the hidden 3D renderer',()=>{
  const originalDocument=globalThis.document,view=maximizedView(),drawn=[];
  const bounds={left:10,top:20,width:640,height:480};view.layout.getBoundingClientRect=()=>bounds;
  Object.assign(view,{kind:'volume',theme:{header:'#000',text:'#fff',axes:['red','green','blue']},readout:{textContent:'position'}});
  view.scene.screenshot=()=>{throw Error('Hidden 3D view must not be exported');};
  for(const p of view.panes){p.panel.getBoundingClientRect=()=>bounds;p.canvas={axis:p.axis,getBoundingClientRect:()=>bounds};p.title={textContent:'plane'};p.status={textContent:'ready'};}
  const context={scale(){},fillRect(){},save(){},beginPath(){},rect(){},clip(){},fillText(){},restore(){},drawImage(canvas){drawn.push(canvas.axis);}};
  globalThis.document={createElement:()=>({getContext:()=>context,toDataURL:()=> 'data:image/png;base64,test'})};
  try{view.setMaximized(1);assert.match(MPRView.prototype.screenshot.call(view),/^data:image\/png/);assert.deepEqual(drawn,[1]);}
  finally{globalThis.document=originalDocument;}
});
test('leaving MPR restores the four-pane layout before the 3D view is shown',()=>{
  const oldDocument=globalThis.document,view=maximizedView();
  const body={dataset:{},classList:{toggle(){}}},heading={};
  globalThis.document={body,getElementById:()=>heading};
  Object.assign(view,{kind:'mesh',id:null,readout:{},probe:{reset(){}},scene:{camera:{isPerspectiveCamera:true,zoom:1,updateProjectionMatrix(){}}}});
  for(const p of view.panes){p.canvas={setAttribute(){}};p.queue={reset(){}};}
  try{
    view.setMaximized(2);MPRView.prototype.setActive.call(view,false);
    assert.equal(view.maximizedAxis,null);assert.equal(view.active,false);assert.equal(view.readout.hidden,true);
    assert.equal(view.layout.classList.values.has('mpr-maximized'),false);
    MPRView.prototype.setActive.call(view,true);
    assert.equal(view.visiblePanes().length,3);assert.equal(view.maximizedAxis,null);assert.deepEqual(view.panes.map(p=>p.zoom),[1,2,3]);
  }finally{globalThis.document=oldDocument;}
});
