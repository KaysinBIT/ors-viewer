import { parsePacket } from './scene.js';
import { AXES, IN_PLANE, clampIndex, planeTransform, imageToScreen, screenToIndices, LatestRequest } from './mpr-math.js';
import {MeshSections} from './mesh-sections.js';
import {meshPlaneTransform,meshToScreen,screenToMesh} from './mesh-sections-math.js';
import {THEMES} from './themes.js';

export class MPRView {
  constructor(layout, scene, onPosition, onRange=()=>{}) {
    this.layout=layout;this.scene=scene;this.onPosition=onPosition;this.indices=[0,0,0];this.panes=[];
    this.low=0;this.high=1;this.generation=0;this.kind='volume';this.theme=THEMES.mono;
    if(scene)this.meshSections=new MeshSections(scene,data=>{
      this.meshResult=data;
      for(const p of this.panes){p.panel.classList.remove('pending');p.status.textContent=`${data.counts[p.axis].toLocaleString()} 段${data.coplanar[p.axis]?' · 共面三角边':''}`;
        p.canvas.dataset.loadedPosition=String(data.coordinates[p.axis]);p.canvas.dataset.revision=String(data.revision);this.draw(p);}
    },(status,message)=>{
      this.meshResult=null;
      for(const p of this.panes){p.panel.classList.add('pending');p.status.textContent=status==='error'?message:'计算截线…';p.status.title=p.status.textContent;this.draw(p);}
    });
    for (const axis of [1,2,0]) {
      const [u,v]=IN_PLANE[axis], panel=document.createElement('section');
      panel.className='mpr-pane mpr-axis-'+axis;panel.style.setProperty('--plane-color',this.theme.axes[axis]);
      const header=document.createElement('div');header.className='mpr-heading';
      const title=document.createElement('b');title.textContent=`${AXES[axis]} · ${AXES[u]}${AXES[v]} 切面`;
      const status=document.createElement('span');header.append(title,status);
      const body=document.createElement('div');body.className='mpr-image';
      const canvas=document.createElement('canvas');canvas.tabIndex=0;canvas.setAttribute('aria-label',`${AXES[axis]} 原始切面，滚轮翻片，点击或拖动十字定位`);
      const hint=document.createElement('span');hint.className='mpr-hint';hint.textContent=`${AXES[u]} →　${AXES[v]} ↑`;
      body.append(canvas,hint);panel.append(header,body);layout.append(panel);
      const p={axis,panel,header,status,body,canvas,image:document.createElement('canvas'),key:null};this.panes[axis]=p;
      p.queue=new LatestRequest(async(job,signal)=>{
        const response=await fetch(`/api/objects/${job.id}/slice?axis=${axis}&index=${job.index}&time=${job.time}`,{signal});
        if(!response.ok)throw new Error((await response.json()).error);
        return parsePacket(await response.arrayBuffer());
      },(packet,job)=>{
        if(packet.meta.range)onRange(packet.meta.range);
        p.packet=packet;p.loadedKey=job.key;p.status.textContent=`${job.index} / ${this.shape[axis]-1} · 原始切片`;
        p.canvas.dataset.loadedIndex=job.index;p.canvas.dataset.time=job.time;p.canvas.dataset.source='original';
        p.panel.classList.remove('pending');this.colorize(p);this.draw(p);
      },error=>{p.status.textContent=error.message;p.panel.classList.add('pending');p.packet=null;this.draw(p);});
      new ResizeObserver(()=>this.draw(p)).observe(body);
      const locate=event=>{
        if(!this.active||!p.transform)return;
        const rect=canvas.getBoundingClientRect(),xy=this.kind==='mesh'?screenToMesh(p.transform,event.clientX-rect.left,event.clientY-rect.top):screenToIndices(p.transform,event.clientX-rect.left,event.clientY-rect.top);
        if(!xy)return;const next=this.indices.slice();next[u]=this.kind==='mesh'?xy[0]/this.meshSections.scale+this.meshSections.center[u]:xy[0];next[v]=this.kind==='mesh'?xy[1]/this.meshSections.scale+this.meshSections.center[v]:xy[1];this.onPosition(next);
      };
      canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;canvas.focus();canvas.setPointerCapture(event.pointerId);locate(event);});
      canvas.addEventListener('pointermove',event=>{if(event.buttons&1)locate(event);});
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
      const [x,y,z]=job.xyz,response=await fetch(`/api/objects/${job.id}/voxel?x=${x}&y=${y}&z=${z}&time=${job.time}`,{signal});
      if(!response.ok)throw new Error((await response.json()).error);return response.json();
    },(result,job)=>{
      this.readout.textContent=`X ${result.xyz[0]}　Y ${result.xyz[1]}　Z ${result.xyz[2]}　│　原始值 ${result.value}`;
      this.readout.title=`原始 ${result.dtype} · 世界坐标 ${result.world_xyz.map(n=>Number(n.toPrecision(7))).join(', ')}（源坐标单位）`;
      this.readout.dataset.xyz=result.xyz.join(',');this.readout.dataset.value=result.value;
      this.readout.dataset.time=String(result.time_step);this.readout.dataset.object=job.id;
    },error=>{this.readout.textContent=error.message;});
  }
  clear() {
    this.setActive(false);this.id=null;this.probe.reset();this.probeKey=null;
    this.meshSections?.clear();this.meshResult=null;this.meshPacket=null;
    for(const p of this.panes){p.queue.reset();p.packet=null;p.key=null;p.loadedKey=null;delete p.canvas.dataset.loadedIndex;}
  }
  source(id, meta, time, indices) {
    // Reloads of the same source keep navigation; time changes invalidate planes.
    this.kind='volume';this.id=id;this.shape=meta.grid.shape_tzyx.slice(1).reverse();this.time=time;this.indices=indices.slice();
    this.meshSections?.clear();this.meshPacket=null;
    for(const p of this.panes){p.queue.reset();p.packet=null;p.key=null;p.loadedKey=null;}
    this.probe.reset();this.probeKey=null;
    if(this.active)this.position(indices);
  }
  meshSource(id,packet,coordinates){
    this.kind='mesh';this.id=id;this.meshPacket=packet;this.indices=coordinates.slice();this.probe.reset();this.probeKey=null;this.meshResult=null;
    for(const p of this.panes){p.queue.reset();p.packet=null;p.key=null;p.loadedKey=null;}
    this.meshSections?.source(packet);if(this.active)this.position(coordinates);
  }
  clamp(axis,value){return this.kind==='mesh'?Math.max(this.meshSections.bounds[0][axis],Math.min(this.meshSections.bounds[1][axis],value)):clampIndex(value,this.shape[axis]);}
  step(axis){return this.kind==='mesh'?(this.meshSections.bounds[1][axis]-this.meshSections.bounds[0][axis])/200:1;}
  setTheme(theme){this.theme=theme;this.meshSections?.setTheme(theme);for(const p of this.panes){p.panel.style.setProperty('--plane-color',theme.axes[p.axis]);this.draw(p);}}
  setActive(active) {
    this.active=active;document.body.classList.toggle('mpr-active',active);document.body.dataset.mprKind=this.kind;this.layout.classList.toggle('mpr-layout',active);
    this.meshSections?.setActive(active&&this.kind==='mesh');
    for(const p of this.panes)p.canvas.setAttribute('aria-label',`${AXES[p.axis]} ${this.kind==='mesh'?'网格截面':'原始切面'}，滚轮移动，点击或拖动十字定位`);
    if(this.scene?.camera.isPerspectiveCamera){this.scene.camera.zoom=active?(this.kind==='mesh'?1.05:1.6):1;this.scene.camera.updateProjectionMatrix();this.scene.dirty=true;}
    this.readout.hidden=!active;document.getElementById('volume-3d-heading').hidden=!active;
    if(active&&this.id)this.position(this.indices);
    else if(!active){this.probe.reset();this.probeKey=null;for(const p of this.panes){p.queue.reset();p.key=null;}}
  }
  position(indices) {
    if(!this.id)return;this.indices=indices.map((x,i)=>this.clamp(i,x));
    if(!this.active)return;
    if(this.kind==='mesh'){
      this.meshSections.update(this.indices);
      const fmt=x=>Number(x.toPrecision(7)).toString();
      this.readout.textContent=this.indices.map((x,i)=>AXES[i]+' '+fmt(x)).join('　')+'　│　源坐标 · '+(this.meshPacket.meta.simplified===false?'原始网格':'手动简化网格');
      this.readout.title=this.indices.map((x,i)=>AXES[i]+' = '+x).join(' · ');this.readout.dataset.xyz=this.indices.join(',');
      for(const p of this.panes){p.canvas.dataset.requestedPosition=String(this.indices[p.axis]);p.canvas.dataset.xyz=this.indices.join(',');p.canvas.dataset.source='mesh';this.draw(p);}
      return;
    }
    for(const p of this.panes){
      const index=this.indices[p.axis],key=`${this.id}:${this.time}:${index}`;
      if(p.key!==key){p.key=key;p.status.textContent=`${index} / ${this.shape[p.axis]-1} · 读取中…`;p.panel.classList.add('pending');
        p.queue.submit({id:this.id,index,time:this.time,key});}
      p.canvas.dataset.requestedIndex=index;p.canvas.dataset.xyz=this.indices.join(',');this.draw(p);
    }
    const key=`${this.id}:${this.time}:${this.indices.join(',')}`;
    if(key!==this.probeKey){this.probeKey=key;this.readout.textContent=`X ${this.indices[0]}　Y ${this.indices[1]}　Z ${this.indices[2]}　│　读取原始值…`;
      this.probe.submit({id:this.id,xyz:this.indices.slice(),time:this.time});}
  }
  window(low,high) { this.low=low;this.high=high;for(const p of this.panes)if(p.packet){this.colorize(p);this.draw(p);} }
  colorize(p) {
    const {meta,arrays}=p.packet,[rows,cols]=meta.shape_yx;
    p.image.width=cols;p.image.height=rows;const ctx=p.image.getContext('2d'),image=ctx.createImageData(cols,rows);
    const scale=255/Math.max(this.high-this.low,1e-20);
    for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
      const value=arrays.pixels[row*cols+col],j=((rows-1-row)*cols+col)*4;
      const gray=Number.isFinite(value)?Math.max(0,Math.min(255,(value-this.low)*scale)):0;
      image.data[j]=image.data[j+1]=image.data[j+2]=gray;image.data[j+3]=255;
    }
    ctx.putImageData(image,0,0);
    if(p.loadedKey===p.key&&meta.index===this.indices[p.axis]&&meta.time_step===this.time)this.scene?.exactSlice(p.axis,p.image);
  }
  draw(p) {
    if(!this.active||!this.id)return;
    const rect=p.body.getBoundingClientRect(),w=rect.width,h=rect.height;
    if(w<=0||h<=0)return;const dpr=Math.min(window.devicePixelRatio||1,2),cw=Math.round(w*dpr),ch=Math.round(h*dpr);
    if(p.canvas.width!==cw||p.canvas.height!==ch){p.canvas.width=cw;p.canvas.height=ch;}
    const ctx=p.canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle=this.theme.canvas;ctx.fillRect(0,0,w,h);
    if(this.kind==='mesh'){this.drawMesh(p,ctx,w,h);return;}
    p.transform=null;if(!p.packet)return;
    try{p.transform=planeTransform(this.shape,p.packet.meta.voxel_xyz_to_world,p.axis,w,h);}
    catch(error){p.status.textContent=error.message;return;}
    const t=p.transform,[u,v]=IN_PLANE[p.axis];
    ctx.save();ctx.transform(t.a,0,t.c,t.d,t.e,t.f);ctx.imageSmoothingEnabled=false;
    ctx.globalAlpha=p.loadedKey===p.key?1:.35;ctx.drawImage(p.image,0,0);ctx.restore();
    const line=(a,b,axis)=>{ctx.setLineDash(this.theme.dashes[axis]);ctx.beginPath();ctx.moveTo(...imageToScreen(t,...a));ctx.lineTo(...imageToScreen(t,...b));this.strokeCrosshair(ctx,axis);};
    const col=this.indices[u]+.5,row=t.rows-this.indices[v]-.5;
    line([col,0],[col,t.rows],u);line([0,row],[t.cols,row],v);
    const xy=imageToScreen(t,col,row);ctx.setLineDash([]);ctx.strokeStyle=this.theme.text;ctx.lineWidth=1;ctx.strokeRect(xy[0]-3,xy[1]-3,6,6);
  }
  strokeCrosshair(ctx,axis){ctx.strokeStyle=this.theme.halo;ctx.lineWidth=3;ctx.stroke();ctx.strokeStyle=this.theme.axes[axis];ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);}
  drawMesh(p,ctx,w,h){
    const mesh=this.meshSections;if(!mesh?.packet)return;
    const t=p.transform=meshPlaneTransform(mesh.normalized,p.axis,w,h),[u,v]=IN_PLANE[p.axis];
    const lines=this.meshResult?.lines[p.axis];
    if(lines){ctx.strokeStyle=this.theme.axes[p.axis];ctx.lineWidth=1.5;ctx.beginPath();
      for(let i=0;i<lines.length;i+=6){ctx.moveTo(...meshToScreen(t,lines[i+u],lines[i+v]));ctx.lineTo(...meshToScreen(t,lines[i+3+u],lines[i+3+v]));}ctx.stroke();}
    const local=this.indices.map((x,i)=>(x-mesh.center[i])*mesh.scale),xy=meshToScreen(t,local[u],local[v]);
    ctx.setLineDash(this.theme.dashes[u]);ctx.beginPath();ctx.moveTo(xy[0],t.top);ctx.lineTo(xy[0],t.top+t.height);this.strokeCrosshair(ctx,u);
    ctx.setLineDash(this.theme.dashes[v]);ctx.beginPath();ctx.moveTo(t.left,xy[1]);ctx.lineTo(t.left+t.width,xy[1]);this.strokeCrosshair(ctx,v);
    ctx.strokeStyle=this.theme.text;ctx.strokeRect(xy[0]-3,xy[1]-3,6,6);
  }
  screenshot() {
    if(!this.active)return this.scene.screenshot();
    this.scene.screenshot();const rect=this.layout.getBoundingClientRect(),canvas=document.createElement('canvas');
    canvas.width=Math.round(rect.width*2);canvas.height=Math.round(rect.height*2)+50;
    const ctx=canvas.getContext('2d');ctx.scale(2,2);ctx.fillStyle=this.theme.header;ctx.fillRect(0,0,rect.width,rect.height+25);
    const draw=(element,source,title,color)=>{const r=element.getBoundingClientRect(),x=r.left-rect.left,y=r.top-rect.top;
      ctx.fillStyle=this.theme.header;ctx.fillRect(x,y,r.width,r.height);ctx.fillStyle=color;ctx.font='12px sans-serif';ctx.fillText(title,x+8,y+18);
      ctx.drawImage(source,x,y+28,r.width,r.height-28);};
    for(const p of this.panes)draw(p.panel,p.canvas,p.header.textContent,this.theme.axes[p.axis]);
    draw(document.getElementById('canvas-wrap'),this.scene.canvas,'3D · 三切面空间定位',this.theme.text);
    ctx.fillStyle=this.theme.text;ctx.font='12px sans-serif';ctx.fillText(this.readout.textContent,8,rect.height+18);
    return canvas.toDataURL('image/png');
  }
  ready(){if(this.kind==='mesh')return Boolean(this.meshResult)&&this.meshSections.resultRevision===this.meshSections.revision;return this.panes.every(p=>p.packet&&p.loadedKey===p.key)&&this.readout.dataset.xyz===this.indices.join(',')&&this.readout.dataset.time===String(this.time)&&this.readout.dataset.object===this.id;}
}
