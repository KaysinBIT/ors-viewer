import { parsePacket, labelColor } from './scene.js';
import {ReslicePlanes} from './reslice-planes.js';
import {poseMatrix,sourcePoint,transformPoint} from './alignment-math.js';
import { AXES, IN_PLANE, clampIndex, planeTransform, imageToScreen, screenToIndices, LatestRequest } from './mpr-math.js';
import {MeshSections} from './mesh-sections.js';
import {meshPlaneTransform,meshToScreen,screenToMesh} from './mesh-sections-math.js';
import {DEFAULT_THEME} from './themes.js';
import {clampZoom,zoomImageTransform,zoomMeshTransform,panImageFocus,panMeshFocus} from './pane-view.js';

async function resliceRequest(id,action,body,signal){
  const response=await fetch(`/api/objects/${id}/${action}`,{method:'POST',signal,headers:{'Content-Type':'application/json','X-Viewer-Token':document.querySelector('meta[name=viewer-token]').content},body:JSON.stringify(body)});
  if(!response.ok)throw new Error((await response.json()).error);return response;
}

export class MPRView {
  constructor(layout, scene, onPosition, onRange=()=>{}) {
    this.layout=layout;this.scene=scene;this.onPosition=onPosition;this.indices=[0,0,0];this.panes=[];
    this.low=0;this.high=1;this.generation=0;this.kind='volume';this.theme=DEFAULT_THEME;this.fillMode='both';this.fillOpacity=.35;this.maximizedAxis=null;
    if(scene)this.reslicePlanes=new ReslicePlanes(scene);
    if(scene)this.meshSections=new MeshSections(scene,data=>{
      this.meshResult=data;
      for(const p of this.panes){
        p.canvas.dataset.loadedPosition=String(data.coordinates[p.axis]);p.canvas.dataset.revision=String(data.revision);this.draw(p);this.recordFrame(p,data.coordinates[p.axis]);}
      this.meshStatus();
    },(status,message)=>{
      for(const p of this.panes){p.panel.classList.add('pending');p.status.textContent=status==='error'?message:'计算截面…';p.status.title=p.status.textContent;this.draw(p);}
      if(this.meshResult)this.meshStatus();
      const note=document.getElementById('mesh-fill-status');if(note)note.textContent=status==='error'||status==='fill-error'?message:'截线持续更新，填充后台计算；标题标明当前显示位置。';
    });
    for (const axis of [1,2,0]) {
      const [u,v]=IN_PLANE[axis], panel=document.createElement('section');
      panel.className='mpr-pane mpr-axis-'+axis;panel.style.setProperty('--plane-color',this.theme.axes[axis]);
      const header=document.createElement('div');header.className='mpr-heading';
      const title=document.createElement('b');title.textContent=`${AXES[axis]} · ${AXES[u]}${AXES[v]} 切面`;
      const status=document.createElement('span');
      const maximizeButton=document.createElement('button');maximizeButton.type='button';maximizeButton.className='mpr-maximize';
      maximizeButton.textContent='最大化';maximizeButton.title='最大化此切面';maximizeButton.setAttribute('aria-label',`${AXES[axis]} 切面最大化`);maximizeButton.setAttribute('aria-pressed','false');
      maximizeButton.onclick=()=>this.setMaximized(this.maximizedAxis===axis?null:axis);
      header.append(title,status,maximizeButton);
      const body=document.createElement('div');body.className='mpr-image';
      const canvas=document.createElement('canvas');canvas.tabIndex=0;canvas.setAttribute('aria-label',`${AXES[axis]} 原始切面，滚轮翻片，点击或拖动十字定位`);
      const hint=document.createElement('span');hint.className='mpr-hint';hint.textContent=`${AXES[u]} →　${AXES[v]} ↑`;
      const zoomBar=document.createElement('div');zoomBar.className='mpr-zoom';
      const zoomLabel=document.createElement('span');zoomLabel.textContent='缩放';
      const zoomInput=document.createElement('input');zoomInput.type='range';zoomInput.min=25;zoomInput.max=800;zoomInput.step=5;zoomInput.value=100;zoomInput.setAttribute('aria-label',`${AXES[axis]} 切面缩放比例`);zoomInput.title='100% 为适应当前窗口';
      const zoomOutput=document.createElement('output');zoomOutput.textContent='100%';
      const focusButton=document.createElement('button');focusButton.textContent='定位';focusButton.title='把十字线移到视窗中心';focusButton.setAttribute('aria-label',`${AXES[axis]} 切面居中十字线`);
      const resetButton=document.createElement('button');resetButton.textContent='适应';resetButton.title='恢复 100% 并显示完整切面';resetButton.setAttribute('aria-label',`${AXES[axis]} 切面恢复适应窗口`);
      zoomBar.append(zoomLabel,zoomInput,zoomOutput,focusButton,resetButton);
      body.append(canvas,hint);panel.append(header,body,zoomBar);layout.append(panel);
      const p={axis,panel,header,title,status,maximizeButton,body,canvas,zoomBar,zoomInput,zoomOutput,zoom:1,focus:null,image:document.createElement('canvas'),key:null};this.panes[axis]=p;
      zoomInput.oninput=()=>{p.zoom=clampZoom(Number(zoomInput.value)/100);zoomOutput.textContent=Math.round(p.zoom*100)+'%';this.draw(p);};
      focusButton.onclick=()=>{if(!this.id)return;p.focus=this.crosshairFocus(p);this.draw(p);};
      resetButton.onclick=()=>{this.resetPane(p);this.draw(p);};
      p.queue=new LatestRequest(async(job,signal)=>{
        if(job.pose)return parsePacket(await (await resliceRequest(job.id,'reslice',{pose:job.pose,axis,coordinate:job.index,time:job.time},signal)).arrayBuffer());
        const response=await fetch(`/api/objects/${job.id}/slice?axis=${axis}&index=${job.index}&time=${job.time}`,{signal});
        if(!response.ok)throw new Error((await response.json()).error);
        return parsePacket(await response.arrayBuffer());
      },(packet,job)=>{
        if(packet.meta.range)onRange(packet.meta.range);
        p.packet=packet;p.loadedKey=job.key;p.loadedGeneration=job.generation;const current=job.key===p.key;p.status.textContent=job.pose?`${Number(job.index.toPrecision(7))} · ${packet.meta.labels?'标签最近邻':'CT 线性采样'}${current?'':' · 更新中'}`:`${job.index} / ${this.shape[axis]-1} · ${current?'原始切片':'当前显示 · 更新中'}`;
        p.canvas.dataset.loadedIndex=job.index;p.canvas.dataset.time=job.time;p.canvas.dataset.source=job.pose?'reslice':'original';
        p.panel.classList.toggle('pending',!current);this.colorize(p);this.draw(p);this.recordFrame(p,job.index);
      },error=>{p.status.textContent=error.message+(p.packet?' · 保留上一切面':'');p.panel.classList.add('pending');this.draw(p);},true);
      new ResizeObserver(()=>this.draw(p)).observe(body);
      const locate=event=>{
        if(!this.active||this.suspended||!p.transform||p.loadedGeneration!==this.generation)return;
        const rect=canvas.getBoundingClientRect(),xy=this.kind==='mesh'?screenToMesh(p.transform,event.clientX-rect.left,event.clientY-rect.top):screenToIndices(p.transform,event.clientX-rect.left,event.clientY-rect.top);
        if(!xy)return;const next=this.indices.slice();
        next[u]=this.kind==='mesh'?xy[0]/this.meshSections.scale+this.meshSections.center[u]:this.worldIndex(u,xy[0]);
        next[v]=this.kind==='mesh'?xy[1]/this.meshSections.scale+this.meshSections.center[v]:this.worldIndex(v,xy[1]);
        if(this.pickPoint&&this.picking){
          if(event.type!=='pointerdown')return;
          if(this.kind!=='mesh'&&p.loadedKey!==p.key)return;
          if(this.kind==='reslice'&&!p.packet?.arrays.mask[xy[1]*p.packet.meta.shape_yx[1]+xy[0]])return;
          const source=this.kind==='reslice'?sourcePoint(poseMatrix(this.pose),next):this.kind==='volume'?transformPoint(this.sourceMatrix,next):sourcePoint(this.alignmentMatrix||poseMatrix(null),next);
          this.pickPoint(source);return;
        }
        this.onPosition(next);
      };
      canvas.addEventListener('contextmenu',event=>event.preventDefault());
      canvas.addEventListener('pointerdown',event=>{
        if(event.button!==0&&event.button!==2)return;canvas.focus();canvas.setPointerCapture(event.pointerId);
        if(event.button===2&&p.transform){event.preventDefault();p.drag=[event.clientX,event.clientY];p.focus=this.paneFocus(p);}else if(event.button===0)locate(event);
      });
      canvas.addEventListener('pointermove',event=>{
        if((event.buttons&2)&&p.drag&&p.transform){const dx=event.clientX-p.drag[0],dy=event.clientY-p.drag[1];p.focus=this.kind==='mesh'?panMeshFocus(p.transform,p.focus,dx,dy):panImageFocus(p.transform,p.focus,dx,dy);p.drag=[event.clientX,event.clientY];this.draw(p);}
        else if(event.buttons&1)locate(event);
      });
      for(const name of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(name,()=>p.drag=null);
      canvas.addEventListener('wheel',event=>{event.preventDefault();if(!this.active||!event.deltaY)return;
        const next=this.indices.slice();next[axis]=this.clamp(axis,next[axis]+Math.sign(event.deltaY)*this.step(axis));this.onPosition(next);
      },{passive:false});
      canvas.addEventListener('keydown',event=>{
        const key=event.key,next=this.indices.slice();let a,step;
        if(key==='PageUp'||key==='PageDown'){a=axis;step=key==='PageUp'?1:-1;}
        else if(key==='ArrowLeft'||key==='ArrowRight'){a=u;step=key==='ArrowRight'?1:-1;}
        else if(key==='ArrowUp'||key==='ArrowDown'){a=v;step=key==='ArrowUp'?1:-1;}
        else return;event.preventDefault();next[a]=this.clamp(a,next[a]+step*this.step(a));this.onPosition(next);
      });
    }
    this.readout=document.getElementById('mpr-readout');
    this.probe=new LatestRequest(async(job,signal)=>{
      if(job.pose)return (await resliceRequest(job.id,'reslice-probe',{pose:job.pose,xyz:job.xyz,time:job.time},signal)).json();
      const [x,y,z]=job.xyz,response=await fetch(`/api/objects/${job.id}/voxel?x=${x}&y=${y}&z=${z}&time=${job.time}`,{signal});
      if(!response.ok)throw new Error((await response.json()).error);return response.json();
    },(result,job)=>{
      this.readout.textContent=job.pose?`对齐坐标 ${job.xyz.map(x=>Number(x.toPrecision(6))).join(' / ')}　│　${result.interpolation==='linear'?'插值 '+result.sampled_value+' · 邻近原始值':'标签'} ${result.value}`:`X ${result.xyz[0]}　Y ${result.xyz[1]}　Z ${result.xyz[2]}　│　原始值 ${result.value}`;
      this.readout.title=`原始 ${result.dtype} · 世界坐标 ${result.world_xyz.map(n=>Number(n.toPrecision(7))).join(', ')}（源坐标单位）`;
      this.readout.dataset.xyz=(job.pose?job.xyz:result.xyz).join(',');this.readout.dataset.value=result.value;
      this.readout.dataset.time=String(result.time_step);this.readout.dataset.object=job.id;
    },error=>{this.readout.textContent=error.message;});
    window.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&this.maximizedAxis!==null&&!document.querySelector('dialog[open]')){
        event.preventDefault();this.setMaximized(null);
      }
    });
  }
  clear() {
    this.standalone=false;
    this.setActive(false);this.id=null;this.probe.reset();this.probeKey=null;
    this.meshSections?.clear();this.meshResult=null;this.meshPacket=null;
    this.reslicePlanes?.clear();
    this.resetViews?.();
    for(const p of this.panes){p.queue.reset();p.packet=null;p.key=null;p.loadedKey=null;p.frames=[];for(const key of ['loadedIndex','requestedIndex','loadedPosition','requestedPosition','revision','fillMode','fillStatus','recentFrames','source','time','xyz'])delete p.canvas.dataset[key];}
  }
  source(id, meta, time, indices) {
    // Reloads of the same source keep navigation; time changes invalidate planes.
    const preserve=this.id===id&&this.time===time;
    this.generation=(this.generation||0)+1;
    if(this.id!==id)this.resetViews?.();
    this.kind='volume';this.id=id;this.shape=meta.grid.shape_tzyx.slice(1).reverse();this.time=time;this.indices=indices.slice();
    const spacing=meta.grid.spacing_xyz||[1,1,1];this.sourceMatrix=meta.grid.voxel_xyz_to_world||[[spacing[0],0,0,0],[0,spacing[1],0,0],[0,0,spacing[2],0],[0,0,0,1]];
    this.reslicePlanes?.clear();
    this.meshSections?.clear();this.meshPacket=null;
    for(const p of this.panes){p.queue.reset();if(!preserve){p.packet=null;p.loadedKey=null;}p.key=null;}
    this.probe.reset();this.probeKey=null;
    if(this.active)this.position(indices);
  }
  meshSource(id,packet,coordinates){
    this.reslicePlanes?.clear();
    if(this.id!==id)this.resetViews?.();
    this.kind='mesh';this.id=id;this.meshPacket=packet;this.indices=coordinates.slice();this.probe.reset();this.probeKey=null;this.meshResult=null;
    for(const p of this.panes){p.queue.reset();p.packet=null;p.key=null;p.loadedKey=null;}
    this.meshSections?.source(packet);if(this.active)this.position(coordinates);
  }
  resliceSource(id,info,pose,time,coordinates){
    const preserve=this.id===id&&this.time===time;
    this.generation=(this.generation||0)+1;
    const same=this.id===id&&this.kind==='reslice'&&JSON.stringify(this.info)===JSON.stringify(info);
    this.kind='reslice';this.id=id;this.info=info;this.pose=structuredClone(pose);this.shape=info.shape_xyz;this.time=time;this.indices=coordinates.slice();
    this.meshSections?.clear();this.meshPacket=null;this.meshResult=null;this.probe.reset(false);this.probeKey=null;
    for(const p of this.panes){p.queue.reset(false);if(!preserve){p.packet=null;p.loadedKey=null;}p.key=null;if(!same)p.focus=null;}
    this.reslicePlanes?.source(info);this.reslicePlanes?.setActive(this.active||this.standalone);if(this.active||this.standalone)this.position(coordinates);
  }
  beginReslice(){
    this.suspended=true;this.generation=(this.generation||0)+1;this.probe.reset(false);this.probeKey=null;
    for(const p of this.panes){
      p.queue.reset(false);p.key=null;p.transform=null;p.panel.classList.add('pending');
      p.status.textContent=p.packet?'保留上一切面 · 正在更新姿态…':'正在更新姿态…';this.draw(p);
    }
    if(this.readout)this.readout.textContent='正在计算新姿态的完整切面，暂时保留上一帧。';
  }
  worldIndex(axis,index){return this.kind==='reslice'?this.info.origin[axis]+index*this.info.spacing[axis]:index;}
  pixelIndex(axis,value){return this.kind==='reslice'?(value-this.info.origin[axis])/this.info.spacing[axis]:value;}
  clamp(axis,value){const bounds=this.kind==='reslice'?this.info.bounds:this.meshSections?.bounds;return this.kind==='mesh'||this.kind==='reslice'?Math.max(bounds[0][axis],Math.min(bounds[1][axis],value)):clampIndex(value,this.shape[axis]);}
  step(axis){return this.kind==='reslice'?this.info.spacing[axis]:this.kind==='mesh'?(this.meshSections.bounds[1][axis]-this.meshSections.bounds[0][axis])/200:1;}
  resetPane(p){p.zoom=1;p.focus=null;p.drag=null;if(p.zoomInput)p.zoomInput.value=100;if(p.zoomOutput)p.zoomOutput.textContent='100%';}
  resetViews(){this.setMaximized?.(null);for(const p of this.panes)this.resetPane(p);}
  setMaximized(axis=null){
    if(axis!==null&&(!this.active||!Number.isInteger(axis)||axis<0||axis>2))return;
    this.maximizedAxis=axis;
    this.layout.classList.toggle('mpr-maximized',axis!==null);
    if(axis===null)delete this.layout.dataset.maximizedAxis;
    else this.layout.dataset.maximizedAxis=AXES[axis];
    for(const pane of this.panes){
      const selected=pane.axis===axis;
      pane.panel.classList.toggle('is-maximized',selected);
      pane.maximizeButton.textContent=selected?'还原':'最大化';
      pane.maximizeButton.title=selected?'还原四窗口布局 (Esc)':'最大化此切面';
      pane.maximizeButton.setAttribute('aria-label',`${AXES[pane.axis]} 切面${selected?'还原':'最大化'}`);
      pane.maximizeButton.setAttribute('aria-pressed',String(selected));
      this.draw(pane);
    }
    if(this.scene)this.scene.dirty=true;
  }
  recordFrame(p,position){
    const frames=p.frames??=[];if(frames.at(-1)?.position===position)return;
    const duringDrag=Boolean(document.querySelector('#mesh-x:active,#mesh-y:active,#mesh-z:active,#slice-x:active,#slice-y:active,#slice-z:active,.mpr-image canvas:active'));
    frames.push({position,duringDrag});if(frames.length>12)frames.shift();p.canvas.dataset.recentFrames=JSON.stringify(frames);
  }
  paneFocus(p){
    if(p.focus)return p.focus.slice();const [u,v]=IN_PLANE[p.axis];
    if(this.kind==='mesh'){const b=this.meshSections.normalized;return [(b[0][u]+b[1][u])/2,(b[0][v]+b[1][v])/2];}
    return p.packet?[p.packet.meta.shape_yx[1]/2,p.packet.meta.shape_yx[0]/2]:[this.shape[u]/2,this.shape[v]/2];
  }
  crosshairFocus(p){const [u,v]=IN_PLANE[p.axis];return this.kind==='mesh'?[u,v].map(i=>(this.indices[i]-this.meshSections.center[i])*this.meshSections.scale):[this.pixelIndex(u,this.indices[u])+.5,this.shape[v]-this.pixelIndex(v,this.indices[v])-.5];}
  setMeshDisplay(mode,opacity){
    this.fillMode=['line','fill','both'].includes(mode)?mode:'both';this.fillOpacity=Math.max(.1,Math.min(1,opacity));
    this.meshSections?.setDisplay(this.fillMode,this.fillOpacity);this.meshStatus();for(const p of this.panes)this.draw(p);
  }
  meshStatus(){
    if(this.kind!=='mesh'||!this.meshResult)return;const data=this.meshResult,warnings=[];
    for(const p of this.panes){const fill=data.fills?.[p.axis],current=data.coordinates[p.axis]===this.indices[p.axis],pending=this.fillMode!=='line'&&fill?.status==='pending';
      let detail=!current?`显示 ${AXES[p.axis]}=${Number(data.coordinates[p.axis].toPrecision(6))} · 更新中`:this.fillMode==='line'?(data.coplanar[p.axis]?'共面三角边':'截线'):fill?.status==='filled'?`${fill.loops} 个闭环 · ${fill.holes} 个孔洞`:fill?.message||'仅截线';
      p.panel.classList.toggle('pending',!current||pending);
      p.status.textContent=`${data.counts[p.axis].toLocaleString()} 段 · ${detail}`;p.status.title=p.status.textContent;
      p.canvas.dataset.fillStatus=fill?.status||'unavailable';p.canvas.dataset.fillMode=this.fillMode;
      if(this.fillMode!=='line'&&fill&& !['filled','empty'].includes(fill.status))warnings.push(AXES[p.axis]+'：'+fill.message);
    }
    const note=document.getElementById('mesh-fill-status');if(note)note.textContent=this.fillMode==='line'?'仅显示截线。':warnings.length?warnings.join('；'):'闭合轮廓按内部 / 孔洞交替填充；原始网格和导出文件不改变。';
  }
  setTheme(theme){this.theme=theme;this.meshSections?.setTheme(theme);this.reslicePlanes?.setTheme(theme);for(const p of this.panes){p.panel.style.setProperty('--plane-color',theme.axes[p.axis]);this.draw(p);}}
  setActive(active) {
    if(!active)this.setMaximized(null);
    this.active=active;document.body.classList.toggle('mpr-active',active);document.body.dataset.mprKind=this.kind;this.layout.classList.toggle('mpr-layout',active);
    this.meshSections?.setActive(active&&this.kind==='mesh');
    this.reslicePlanes?.setActive(active&&this.kind==='reslice');
    for(const p of this.panes)p.canvas.setAttribute('aria-label',`${AXES[p.axis]} ${this.kind==='mesh'?'网格截面':this.kind==='reslice'?'对齐切面':'原始切面'}，滚轮移动，左键定位，右键平移`);
    if(this.scene?.camera.isPerspectiveCamera){this.scene.camera.zoom=active?(this.kind==='mesh'?1.05:1.6):1;this.scene.camera.updateProjectionMatrix();this.scene.dirty=true;}
    this.readout.hidden=!active;document.getElementById('volume-3d-heading').hidden=!active;
    if(active&&this.id)this.position(this.indices);
    else if(!active){this.probe.reset();this.probeKey=null;for(const p of this.panes){p.queue.reset(this.kind!=='reslice');p.key=null;}}
  }
  setStandalone(active){this.standalone=active;this.reslicePlanes?.setActive((active||this.active)&&this.kind==='reslice');if(active&&this.id)this.position(this.indices);}
  position(indices) {
    if(!this.id||this.suspended)return;this.indices=indices.map((x,i)=>this.clamp(i,x));
    if(!this.active&&!this.standalone)return;
    if(this.kind==='mesh'){
      this.meshSections.update(this.indices);
      const fmt=x=>Number(x.toPrecision(7)).toString();
      this.readout.textContent=this.indices.map((x,i)=>AXES[i]+' '+fmt(x)).join('　')+'　│　源坐标 · '+(this.meshPacket.meta.simplified===false?'原始网格':'手动简化网格');
      this.readout.title=this.indices.map((x,i)=>AXES[i]+' = '+x).join(' · ');this.readout.dataset.xyz=this.indices.join(',');
      for(const p of this.panes){p.canvas.dataset.requestedPosition=String(this.indices[p.axis]);p.canvas.dataset.xyz=this.indices.join(',');p.canvas.dataset.source='mesh';this.draw(p);}
      return;
    }
    if(this.kind==='reslice')this.reslicePlanes?.position(this.indices);
    for(const p of this.panes){
      const index=this.indices[p.axis],key=`${this.id}:${this.generation}:${this.time}:${index}`;
      if(p.key!==key){p.key=key;p.status.textContent=this.kind==='reslice'?`${Number(index.toPrecision(7))} · ${p.packet?'保留上一切面，':''}更新中…`:`${index} / ${this.shape[p.axis]-1} · 读取中…`;p.panel.classList.add('pending');
        p.queue.submit({id:this.id,index,time:this.time,key,generation:this.generation,pose:this.kind==='reslice'?this.pose:null});}
      p.canvas.dataset.requestedIndex=index;p.canvas.dataset.xyz=this.indices.join(',');this.draw(p);
    }
    const key=`${this.id}:${this.time}:${this.indices.join(',')}`;
    if(key!==this.probeKey){this.probeKey=key;this.readout.textContent=`X ${this.indices[0]}　Y ${this.indices[1]}　Z ${this.indices[2]}　│　读取原始值…`;
      this.probe.submit({id:this.id,xyz:this.indices.slice(),time:this.time,pose:this.kind==='reslice'?this.pose:null});}
  }
  window(low,high) { this.low=low;this.high=high;for(const p of this.panes)if(p.packet){this.colorize(p);this.draw(p);} }
  colorize(p) {
    const {meta,arrays}=p.packet,[rows,cols]=meta.shape_yx;
    p.image.width=cols;p.image.height=rows;const ctx=p.image.getContext('2d'),image=ctx.createImageData(cols,rows);
    const scale=255/Math.max(this.high-this.low,1e-20);
    const colors=new Map();
    for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
      const value=arrays.pixels[row*cols+col],j=((rows-1-row)*cols+col)*4;
      const gray=Number.isFinite(value)?Math.max(0,Math.min(255,(value-this.low)*scale)):0;
      image.data[j]=image.data[j+1]=image.data[j+2]=gray;image.data[j+3]=255;
      if(meta.labels){
        if(!colors.has(value))colors.set(value,value?labelColor(value).getHex():0);
        const color=colors.get(value);image.data[j]=color>>16;image.data[j+1]=(color>>8)&255;image.data[j+2]=color&255;
      }
      if(arrays.mask&&!arrays.mask[row*cols+col])image.data[j+3]=0;
    }
    ctx.putImageData(image,0,0);
    if(p.loadedKey===p.key&&meta.index===this.indices[p.axis]&&meta.time_step===this.time){
      if(this.kind==='reslice'){if(this.reslicePlanes&&!this.reslicePlanes.image(p.axis,p.image))p.status.textContent+=' · 超出显卡纹理上限，仅显示二维切面';}
      else this.scene?.exactSlice(p.axis,p.image);
    }
  }
  draw(p) {
    if(!this.active||!this.id)return;
    const rect=p.body.getBoundingClientRect(),w=rect.width,h=rect.height;
    if(w<=0||h<=0)return;const dpr=Math.min(window.devicePixelRatio||1,2),cw=Math.round(w*dpr),ch=Math.round(h*dpr);
    if(p.canvas.width!==cw||p.canvas.height!==ch){p.canvas.width=cw;p.canvas.height=ch;}
    p.canvas.dataset.zoom=String(Math.round(p.zoom*100));p.canvas.dataset.viewFocus=this.paneFocus(p).join(',');
    const ctx=p.canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle=this.theme.canvas;ctx.fillRect(0,0,w,h);
    if(this.kind==='mesh'){this.drawMesh(p,ctx,w,h);return;}
    p.transform=null;if(!p.packet)return;
    const displayShape=this.shape.slice(),inPlane=IN_PLANE[p.axis];
    displayShape[inPlane[0]]=p.packet.meta.shape_yx[1];displayShape[inPlane[1]]=p.packet.meta.shape_yx[0];
    try{p.transform=zoomImageTransform(planeTransform(displayShape,p.packet.meta.voxel_xyz_to_world,p.axis,w,h),p.zoom,w,h,this.paneFocus(p));}
    catch(error){p.status.textContent=error.message;return;}
    const t=p.transform,[u,v]=IN_PLANE[p.axis];
    ctx.save();ctx.transform(t.a,0,t.c,t.d,t.e,t.f);ctx.imageSmoothingEnabled=false;
    ctx.globalAlpha=p.loadedKey===p.key?1:.7;ctx.drawImage(p.image,0,0);ctx.restore();
    // Retained frames use their own dimensions/affine; do not overlay a new
    // pose's crosshair or let point picking interpret them as current data.
    if(this.suspended||p.loadedGeneration!==this.generation){p.transform=null;return;}
    const line=(a,b,axis)=>{ctx.setLineDash(this.theme.dashes[axis]);ctx.beginPath();ctx.moveTo(...imageToScreen(t,...a));ctx.lineTo(...imageToScreen(t,...b));this.strokeCrosshair(ctx,axis);};
    const col=this.pixelIndex(u,this.indices[u])+.5,row=t.rows-this.pixelIndex(v,this.indices[v])-.5;
    line([col,0],[col,t.rows],u);line([0,row],[t.cols,row],v);
    const xy=imageToScreen(t,col,row);ctx.setLineDash([]);ctx.strokeStyle=this.theme.text;ctx.lineWidth=1;ctx.strokeRect(xy[0]-3,xy[1]-3,6,6);
  }
  strokeCrosshair(ctx,axis){ctx.strokeStyle=this.theme.halo;ctx.lineWidth=3;ctx.stroke();ctx.strokeStyle=this.theme.axes[axis];ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);}
  drawMesh(p,ctx,w,h){
    const mesh=this.meshSections;if(!mesh?.packet)return;
    const t=p.transform=zoomMeshTransform(meshPlaneTransform(mesh.normalized,p.axis,w,h),p.zoom,w,h,this.paneFocus(p)),[u,v]=IN_PLANE[p.axis];
    const fill=this.meshResult?.fills?.[p.axis],filled=fill?.status==='filled',current=this.meshResult?.coordinates[p.axis]===this.indices[p.axis],showFill=filled&&current&&this.fillMode!=='line';
    if(showFill){
      ctx.save();ctx.fillStyle=this.theme.axes[p.axis];ctx.globalAlpha=this.fillOpacity;ctx.beginPath();
      for(let j=0;j<fill.offsets.length-1;j++){const start=fill.offsets[j],end=fill.offsets[j+1];for(let i=start;i<end;i++){const xy=meshToScreen(t,fill.positions[i*3+u],fill.positions[i*3+v]);if(i===start)ctx.moveTo(...xy);else ctx.lineTo(...xy);}ctx.closePath();}
      ctx.fill('evenodd');ctx.restore();
    }
    const lines=showFill?fill.boundary:this.meshResult?.lines[p.axis];
    if(lines&&(this.fillMode!=='fill'||!filled||!current)){ctx.strokeStyle=this.theme.axes[p.axis];ctx.lineWidth=1.5;ctx.beginPath();
      for(let i=0;i<lines.length;i+=6){ctx.moveTo(...meshToScreen(t,lines[i+u],lines[i+v]));ctx.lineTo(...meshToScreen(t,lines[i+3+u],lines[i+3+v]));}ctx.stroke();}
    const local=this.indices.map((x,i)=>(x-mesh.center[i])*mesh.scale),xy=meshToScreen(t,local[u],local[v]);
    ctx.setLineDash(this.theme.dashes[u]);ctx.beginPath();ctx.moveTo(xy[0],t.top);ctx.lineTo(xy[0],t.top+t.height);this.strokeCrosshair(ctx,u);
    ctx.setLineDash(this.theme.dashes[v]);ctx.beginPath();ctx.moveTo(t.left,xy[1]);ctx.lineTo(t.left+t.width,xy[1]);this.strokeCrosshair(ctx,v);
    ctx.strokeStyle=this.theme.text;ctx.strokeRect(xy[0]-3,xy[1]-3,6,6);
  }
  screenshot() {
    if(!this.active)return this.scene.screenshot();
    if(this.maximizedAxis===null)this.scene.screenshot();
    const rect=this.layout.getBoundingClientRect(),canvas=document.createElement('canvas');
    canvas.width=Math.round(rect.width*2);canvas.height=Math.round(rect.height*2)+50;
    const ctx=canvas.getContext('2d');ctx.scale(2,2);ctx.fillStyle=this.theme.header;ctx.fillRect(0,0,rect.width,rect.height+25);
    const draw=(element,source,title,color,footer='')=>{const r=element.getBoundingClientRect(),x=r.left-rect.left,y=r.top-rect.top,im=source.getBoundingClientRect();
      if(!r.width||!r.height||!im.width||!im.height)return;
      ctx.fillStyle=this.theme.header;ctx.fillRect(x,y,r.width,r.height);ctx.fillStyle=color;ctx.font='12px sans-serif';ctx.save();ctx.beginPath();ctx.rect(x+5,y,r.width-10,28);ctx.clip();ctx.fillText(title,x+8,y+18);ctx.restore();
      ctx.drawImage(source,im.left-rect.left,im.top-rect.top,im.width,im.height);if(footer){ctx.fillStyle=this.theme.text;ctx.font='11px sans-serif';ctx.fillText(footer,x+8,y+r.height-10);}};
    for(const p of this.visiblePanes())draw(p.panel,p.canvas,p.title.textContent+' '+p.status.textContent,this.theme.axes[p.axis],`缩放 ${Math.round(p.zoom*100)}%${this.kind==='mesh'?' · '+({line:'仅截线',fill:'填充',both:'填充 + 轮廓'})[this.fillMode]:''}`);
    if(this.maximizedAxis===null)draw(document.getElementById('canvas-wrap'),this.scene.canvas,'3D · 三切面空间定位',this.theme.text);
    ctx.fillStyle=this.theme.text;ctx.font='12px sans-serif';ctx.fillText(this.readout.textContent,8,rect.height+18);
    return canvas.toDataURL('image/png');
  }
  visiblePanes(){return this.maximizedAxis===null?this.panes:[this.panes[this.maximizedAxis]];}
  ready(){
    if(this.suspended)return false;
    const panes=this.visiblePanes();
    if(this.kind==='mesh')return Boolean(this.meshResult)&&this.meshSections.resultRevision===this.meshSections.revision&&(this.fillMode==='line'||!panes.some(p=>this.meshResult.fills?.[p.axis]?.status==='pending'));
    return panes.every(p=>p.packet&&p.loadedKey===p.key)&&this.readout.dataset.xyz===this.indices.join(',')&&this.readout.dataset.time===String(this.time)&&this.readout.dataset.object===this.id;
  }
}
