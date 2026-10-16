import * as THREE from './vendor/three.module.js';
import {THEMES} from './themes.js';

const sliceVertex=`uniform mat4 uWorldToVolume;out vec3 vTex;
void main(){vec4 w=modelMatrix*vec4(position,1.0);vTex=(uWorldToVolume*w).xyz+.5;gl_Position=projectionMatrix*viewMatrix*w;}`;
const sliceFragment=`precision highp sampler3D;uniform sampler3D uData;uniform vec2 uWindow;uniform float uOpacity;in vec3 vTex;out vec4 fragColor;
void main(){if(any(lessThan(vTex,vec3(0)))||any(greaterThan(vTex,vec3(1))))discard;
float v=clamp((texture(uData,vTex).r-uWindow.x)/max(uWindow.y-uWindow.x,.00001),0.0,1.0);fragColor=vec4(vec3(v),uOpacity);}`;
// A pixel-width band gives immediate feedback while exact lines are computed.
// The live pass shares the original mesh geometry without any decimation.
const liveVertex=`uniform vec4 uPlane;varying float vDistance;
void main(){vec4 world=modelMatrix*vec4(position,1.0);vDistance=dot(uPlane.xyz,world.xyz)+uPlane.w;gl_Position=projectionMatrix*viewMatrix*world;}`;
const liveFragment=`varying float vDistance;uniform vec3 uLineColor;
void main(){float slope=fwidth(vDistance);if(slope<1e-8)discard;
float coverage=1.0-smoothstep(.5,1.5,abs(vDistance)/slope);if(coverage<.01)discard;gl_FragColor=vec4(uLineColor,coverage);}`;

export class SectionController {
  constructor(view,onStatus=()=>{}) {
    this.view=view;this.onStatus=onStatus;this.plane=new THREE.Plane();this.root=new THREE.Group();view.scene.add(this.root);
    view.renderer.localClippingEnabled=true;this.revision=0;
    this.options={enabled:false,azimuth:0,elevation:0,distance:0,flip:false,only:false,guide:true};
    this.theme=THEMES.mono;this.fillMode='both';this.fillOpacity=.35;
  }
  clear(){
    this.worker?.terminate();this.worker=null;this.workerReady=false;this.busy=false;this.pending=null;
    if(this.live){this.view.group.remove(this.live);this.live.material.dispose();this.live=null;}
    this.root.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});this.root.clear();
    this.guide=null;this.edge=null;this.slice=null;this.exact=null;this.cap=null;this.fill=null;this.resultLines=null;this.resultRevision=-1;
    this.packet=null;this.segmentCount=0;this.workerFailed=false;
  }
  ensureResources(){
    const v=this.view;
    if(this.packet===v.packet)return;
    this.clear();this.packet=v.packet;
    this.guide=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({color:0x62dec4,opacity:.065,transparent:true,side:THREE.DoubleSide,depthWrite:false}));
    this.edge=new THREE.LineSegments(new THREE.EdgesGeometry(this.guide.geometry),new THREE.LineBasicMaterial({color:0x67dec0,transparent:true,opacity:.55}));
    this.root.add(this.guide,this.edge);
    if(v.volume){
      const material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,side:THREE.DoubleSide,transparent:true,
        uniforms:{...v.volume.common,uWorldToVolume:{value:new THREE.Matrix4()}},vertexShader:sliceVertex,fragmentShader:sliceFragment});
      this.slice=new THREE.Mesh(new THREE.PlaneGeometry(1,1),material);this.root.add(this.slice);
    }else if(v.mesh){
      const material=new THREE.ShaderMaterial({side:THREE.DoubleSide,transparent:true,depthTest:false,depthWrite:false,
        uniforms:{uPlane:{value:new THREE.Vector4()},uLineColor:{value:new THREE.Color(this.theme.axes[0])}},vertexShader:liveVertex,fragmentShader:liveFragment});
      this.live=new THREE.Mesh(v.mesh.geometry,material);this.live.renderOrder=10;v.group.add(this.live);
      this.exact=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0x78ffe0,depthTest:false,depthWrite:false,transparent:true,opacity:.95}));
      this.exact.renderOrder=10;this.root.add(this.exact);
      this.cap=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial({side:THREE.DoubleSide,transparent:true,opacity:this.fillOpacity,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1}));
      this.cap.renderOrder=9;this.cap.visible=false;this.cap.frustumCulled=false;this.root.add(this.cap);
    }
    this.setTheme(this.theme);
  }
  setTheme(theme){this.theme=theme;for(const o of [this.guide,this.edge,this.exact,this.cap])o?.material.color.set(theme.axes[0]);if(this.live)this.live.material.uniforms.uLineColor.value.set(theme.axes[0]);this.view.dirty=true;}
  setDisplay(mode,opacity){
    this.fillMode=['line','fill','both'].includes(mode)?mode:'both';this.fillOpacity=Math.max(.1,Math.min(1,opacity));
    this.applyDisplay();if(this.options.enabled&&this.exact)this.reportStatus();
  }
  applyDisplay(){
    if(!this.exact)return;
    const current=this.options.enabled&&this.resultRevision===this.revision;
    const filled=current&&this.fill?.status==='filled'&&this.fillMode!=='line';
    this.cap.visible=filled;this.cap.material.opacity=this.fillOpacity;
    this.live.visible=this.options.enabled&&!current;
    this.exact.visible=current&&(!filled||this.fillMode!=='fill');
    const lines=filled?this.fill.boundary:this.resultLines;
    if(current&&lines&&this.exact.geometry.attributes.position?.array!==lines){
      this.exact.geometry.dispose();this.exact.geometry=new THREE.BufferGeometry();
      this.exact.geometry.setAttribute('position',new THREE.BufferAttribute(lines,3));
    }
    this.view.canvas.dataset.sectionFillStatus=this.fill?.status||'unavailable';
    this.view.canvas.dataset.sectionFillMode=this.fillMode;
    this.view.dirty=true;
  }
  reportStatus(){
    const status=this.workerFailed?'live':this.resultRevision===this.revision?'exact':'updating';
    this.onStatus(status,this.segmentCount,this.fillMode==='line'?null:this.fill);
  }
  ready(){
    if(!this.options.enabled||this.view.volume||this.fillMode==='line'||this.workerFailed)return true;
    return this.resultRevision===this.revision&&Boolean(this.fill)&&this.fill.status!=='pending';
  }
  limits(azimuth,elevation){
    const a=THREE.MathUtils.degToRad(azimuth),e=THREE.MathUtils.degToRad(elevation);
    const normal=new THREE.Vector3(Math.cos(e)*Math.cos(a),Math.cos(e)*Math.sin(a),Math.sin(e));
    const size=this.view.bounds?.getSize(new THREE.Vector3())||new THREE.Vector3(1,1,1);
    return {normal,half:(Math.abs(normal.x)*size.x+Math.abs(normal.y)*size.y+Math.abs(normal.z)*size.z)/2};
  }
  update(options){
    this.options={...this.options,...options};const o=this.options,v=this.view;
    if(!v.bounds)return;this.ensureResources();++this.revision;
    const {normal,half}=this.limits(o.azimuth,o.elevation);
    o.distance=Math.max(-half,Math.min(half,o.distance));
    const scale=v.group.scale.x,point=normal.clone().multiplyScalar(o.distance*scale);
    this.point=point;this.normal=normal;
    this.plane.setFromNormalAndCoplanarPoint(o.flip?normal.clone().negate():normal,point);
    v.materials.forEach(m=>{
      if(Boolean(m.clippingPlanes?.length)!==o.enabled){m.clippingPlanes=o.enabled?[this.plane]:[];m.needsUpdate=true;}
    });
    if(v.mesh)v.mesh.visible=!(o.enabled&&o.only);
    this.guide.visible=this.edge.visible=o.enabled&&o.guide;
    this.place(this.guide,point,normal);this.place(this.edge,point,normal);
    if(v.volume){
      v.group.updateMatrixWorld(true);
      const inverse=v.volume.mesh.matrixWorld.clone().invert(),local=this.plane.clone().applyMatrix4(inverse);
      v.volume.common.uClipEnabled.value=o.enabled;
      v.volume.common.uClipPlane.value.set(local.normal.x,local.normal.y,local.normal.z,local.constant);
      v.volumeMode(v.volume.mode||'mip');
      if(o.enabled&&o.only){v.volume.mesh.visible=false;v.volume.planes.forEach(p=>p.visible=false);v.volume.outlines.forEach(p=>p.visible=false);}
      this.slice.visible=o.enabled;this.slice.material.uniforms.uWorldToVolume.value.copy(inverse);this.place(this.slice,point,normal);
    }
    if(this.live){
      this.live.matrixAutoUpdate=false;this.live.matrix.copy(v.mesh.matrix);
      this.live.visible=o.enabled;this.exact.visible=false;this.cap.visible=false;this.fill=null;
      v.canvas.dataset.sectionFillStatus=o.enabled?'pending':'disabled';
      v.canvas.dataset.sectionFillMode=this.fillMode;
      this.live.material.uniforms.uPlane.value.set(normal.x,normal.y,normal.z,-normal.dot(point));
      if(o.enabled){
        const c=v.bounds.getCenter(new THREE.Vector3());
        const e=v.alignment?.elements,transform=e?[0,1,2,3].map(r=>[0,1,2,3].map(col=>e[col*4+r])):null;
        this.pending={type:'section',revision:this.revision,transform,normal:normal.toArray(),constant:-normal.dot(c)-o.distance,
          point:point.toArray(),center:c.toArray(),scale,epsilon:Math.max(v.bounds.getSize(new THREE.Vector3()).length()*1e-10,1e-20)};
        this.startWorker();this.dispatch();this.onStatus(this.workerFailed?'live':'updating');
      }else this.pending=null;
    }
    v.sectionRevision=this.revision;v.sectionDistance=o.distance;v.dirty=true;return half;
  }
  startWorker(){
    if(this.worker||this.workerFailed)return;
    const packet=this.packet;
    try{
      const worker=this.worker=new Worker(new URL('./section-worker.js',import.meta.url),{type:'module'});
      worker.onmessage=({data})=>{
        if(this.packet!==packet||this.worker!==worker)return;
        if(data.type==='ready')this.workerReady=true;
        else if(data.type==='section'){
          this.busy=false;
          if(data.revision===this.revision&&this.options.enabled){
            this.resultRevision=data.revision;this.resultLines=data.lines;this.segmentCount=data.lines.length/6;
            this.fill=data.fillPending?{status:'pending',message:'截面填充后台计算中'}:null;
            this.applyDisplay();this.reportStatus();
          }
        }else if(data.type==='fill'&&data.revision===this.revision&&this.options.enabled){
          this.fill=data.fill;this.cap.geometry.dispose();this.cap.geometry=new THREE.BufferGeometry();
          if(data.fill.status==='filled'){
            this.cap.geometry.setAttribute('position',new THREE.BufferAttribute(data.fill.positions,3));
            this.cap.geometry.setIndex(new THREE.BufferAttribute(data.fill.indices,1));
          }
          this.applyDisplay();this.reportStatus();
        }else if(data.type==='fill-error'&&data.revision===this.revision&&this.options.enabled){
          this.fill={status:'invalid',message:'填充计算失败，保留截线'};this.applyDisplay();this.reportStatus();
        }
        this.dispatch();
      };
      worker.onerror=()=>{
        if(this.worker!==worker||this.packet!==packet)return;
        this.workerFailed=true;worker.terminate();this.worker=null;this.busy=false;this.cap.visible=false;this.fill=null;this.onStatus('live');
      };
      // Transfer copies once per object; original rendering arrays stay intact.
      const positions=new Float32Array(packet.arrays.positions),indices=new Uint32Array(packet.arrays.indices);
      worker.postMessage({type:'mesh',positions,indices},[positions.buffer,indices.buffer]);
    }catch{this.workerFailed=true;this.worker?.terminate();this.worker=null;this.onStatus('live');}
  }
  dispatch(){if(this.workerReady&&!this.busy&&this.pending&&this.worker){this.busy=true;const job=this.pending;this.pending=null;this.worker.postMessage(job);}}
  place(mesh,point,normal){
    const diameter=this.view.bounds.getSize(new THREE.Vector3()).length()*this.view.group.scale.x*1.05;
    mesh.position.copy(point);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),normal);mesh.scale.setScalar(diameter);
  }
  face(reset=false){if(!this.point)return;this.view.sectionView(this.normal,this.point,reset);
    this.view.canvas.dataset.projection='orthographic';
    this.view.canvas.dataset.faceAlignment=String(-this.view.camera.getWorldDirection(new THREE.Vector3()).dot(this.normal));
  }
}
