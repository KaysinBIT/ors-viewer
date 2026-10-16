import * as THREE from './vendor/three.module.js';
import {THEMES} from './themes.js';

export class MeshSections {
  constructor(view,onResult,onStatus){
    this.view=view;this.onResult=onResult;this.onStatus=onStatus;this.root=new THREE.Group();view.scene.add(this.root);
    this.theme=THEMES.mono;this.revision=0;this.active=false;
  }
  clear(){
    this.worker?.terminate();this.worker=null;this.workerReady=false;this.busy=false;this.pending=null;this.failed=false;
    this.root.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});this.root.clear();this.packet=null;
    this.planes=[];this.edges=[];this.lines=[];this.resultRevision=-1;this.revision++;
  }
  source(packet){
    this.clear();this.packet=packet;
    this.center=this.view.bounds.getCenter(new THREE.Vector3()).toArray();this.scale=this.view.group.scale.x;
    this.bounds=[this.view.bounds.min.toArray(),this.view.bounds.max.toArray()];
    this.normalized=this.bounds.map(b=>b.map((x,i)=>(x-this.center[i])*this.scale));
    for(let axis=0;axis<3;axis++){
      const plane=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({side:THREE.DoubleSide,transparent:true,opacity:.07,depthWrite:false}));
      const edge=new THREE.LineLoop(new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(new Float32Array(12),3)),new THREE.LineBasicMaterial({depthTest:false}));
      const line=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({depthTest:false}));
      plane.matrixAutoUpdate=false;plane.frustumCulled=edge.frustumCulled=line.frustumCulled=false;edge.renderOrder=3;line.renderOrder=4;
      this.planes.push(plane);this.edges.push(edge);this.lines.push(line);this.root.add(plane,edge,line);
    }
    this.root.visible=this.active;this.setTheme(this.theme);
  }
  setTheme(theme){this.theme=theme;for(let i=0;i<(this.planes?.length||0);i++)for(const o of [this.planes[i],this.edges[i],this.lines[i]])o.material.color.set(theme.axes[i]);this.view.dirty=true;}
  setActive(active){
    this.active=active;this.root.visible=active;this.view.dirty=true;
    if(!active){this.pending=null;this.revision++;this.resultRevision=-1;}
  }
  update(coordinates){
    if(!this.packet||!this.active)return;
    this.coordinates=coordinates.slice();this.revision++;
    const local=coordinates.map((x,i)=>(x-this.center[i])*this.scale),[lo,hi]=this.normalized;
    for(let axis=0;axis<3;axis++){
      const [u,v]=[[1,2],[0,2],[0,1]][axis],width=Math.max(hi[u]-lo[u],.005),height=Math.max(hi[v]-lo[v],.005);
      const e=new THREE.Vector3(),f=new THREE.Vector3(),n=new THREE.Vector3();e.setComponent(u,width);f.setComponent(v,height);n.setComponent(axis,1);
      const origin=new THREE.Vector3();origin.setComponent(axis,local[axis]);origin.setComponent(u,(lo[u]+hi[u])/2);origin.setComponent(v,(lo[v]+hi[v])/2);
      this.planes[axis].matrix.makeBasis(e,f,n).setPosition(origin);
      const positions=this.edges[axis].geometry.attributes.position;
      [[lo[u],lo[v]],[hi[u],lo[v]],[hi[u],hi[v]],[lo[u],hi[v]]].forEach((xy,j)=>{const p=local.slice();p[u]=xy[0];p[v]=xy[1];positions.setXYZ(j,...p);});
      positions.needsUpdate=true;this.lines[axis].visible=false;
    }
    this.view.meshPlaneCoordinates=coordinates.slice();this.view.dirty=true;
    this.pending={type:'sections',revision:this.revision,coordinates:coordinates.slice(),center:this.center,scale:this.scale,
      epsilon:Math.max(this.view.bounds.getSize(new THREE.Vector3()).length()*1e-10,1e-20)};
    if(this.failed){this.onStatus('error','截线计算不可用，请重新选择对象重试。');return;}
    this.onStatus('pending');this.start();this.dispatch();
  }
  start(){
    if(this.worker||this.failed)return;const packet=this.packet;
    try{
      const worker=this.worker=new Worker(new URL('./mesh-sections-worker.js',import.meta.url),{type:'module'});
      worker.onmessage=({data})=>{
        if(this.packet!==packet||this.worker!==worker)return;
        if(data.type==='ready')this.workerReady=true;
        else {
          this.busy=false;
          if(this.active&&data.revision===this.revision){
            if(data.type==='error')this.onStatus('error',data.message);
            else if(data.type==='sections'){
              this.resultRevision=data.revision;
              data.lines.forEach((values,axis)=>{const line=this.lines[axis];line.geometry.dispose();line.geometry=new THREE.BufferGeometry();line.geometry.setAttribute('position',new THREE.BufferAttribute(values,3));line.visible=true;});
              this.view.dirty=true;this.onResult(data);
            }
          }
        }
        this.dispatch();
      };
      worker.onerror=()=>{this.failed=true;worker.terminate();this.worker=null;this.busy=false;this.onStatus('error','网格截线计算失败，三维定位仍可操作。请重新选择对象重试。');};
      const positions=new Float32Array(packet.arrays.positions),indices=new Uint32Array(packet.arrays.indices);
      worker.postMessage({type:'mesh',positions,indices},[positions.buffer,indices.buffer]);
    }catch(error){this.failed=true;this.worker?.terminate();this.worker=null;this.onStatus('error','无法准备网格截线：'+error.message);}
  }
  dispatch(){if(this.worker&&this.workerReady&&!this.busy&&this.pending){this.busy=true;const job=this.pending;this.pending=null;this.worker.postMessage(job);}}
}
