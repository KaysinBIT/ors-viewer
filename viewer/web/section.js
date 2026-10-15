import * as THREE from './vendor/three.module.js';

const sliceVertex=`uniform mat4 uWorldToVolume;out vec3 vTex;
void main(){vec4 w=modelMatrix*vec4(position,1.0);vTex=(uWorldToVolume*w).xyz+.5;gl_Position=projectionMatrix*viewMatrix*w;}`;
const sliceFragment=`precision highp sampler3D;uniform sampler3D uData;uniform vec2 uWindow;uniform float uOpacity;in vec3 vTex;out vec4 fragColor;
void main(){if(any(lessThan(vTex,vec3(0)))||any(greaterThan(vTex,vec3(1))))discard;
float v=clamp((texture(uData,vTex).r-uWindow.x)/max(uWindow.y-uWindow.x,.00001),0.0,1.0);fragColor=vec4(vec3(v),uOpacity);}`;
// A pixel-width band gives immediate feedback while exact lines are computed.
// The live pass shares the original mesh geometry without any decimation.
const liveVertex=`uniform vec4 uPlane;varying float vDistance;
void main(){vec4 world=modelMatrix*vec4(position,1.0);vDistance=dot(uPlane.xyz,world.xyz)+uPlane.w;gl_Position=projectionMatrix*viewMatrix*world;}`;
const liveFragment=`varying float vDistance;
void main(){float slope=fwidth(vDistance);if(slope<1e-8)discard;
float coverage=1.0-smoothstep(.5,1.5,abs(vDistance)/slope);if(coverage<.01)discard;gl_FragColor=vec4(.47,1.0,.88,coverage);}`;

export class SectionController {
  constructor(view,onStatus=()=>{}) {
    this.view=view;this.onStatus=onStatus;this.plane=new THREE.Plane();this.root=new THREE.Group();view.scene.add(this.root);
    view.renderer.localClippingEnabled=true;this.revision=0;
    this.options={enabled:false,azimuth:0,elevation:0,distance:0,flip:false,only:false,guide:true};
  }
  clear(){
    this.worker?.terminate();this.worker=null;this.workerReady=false;this.busy=false;this.pending=null;
    if(this.live){this.view.group.remove(this.live);this.live.material.dispose();this.live=null;}
    this.root.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});this.root.clear();
    this.guide=null;this.edge=null;this.slice=null;this.exact=null;this.segmentCount=0;this.workerFailed=false;
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
        uniforms:{uPlane:{value:new THREE.Vector4()}},vertexShader:liveVertex,fragmentShader:liveFragment});
      this.live=new THREE.Mesh(v.mesh.geometry,material);this.live.renderOrder=10;v.group.add(this.live);
      this.exact=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0x78ffe0,depthTest:false,depthWrite:false,transparent:true,opacity:.95}));
      this.exact.renderOrder=10;this.root.add(this.exact);
    }
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
      if(o.enabled&&o.only){v.volume.mesh.visible=false;v.volume.planes.forEach(p=>p.visible=false);}
      this.slice.visible=o.enabled;this.slice.material.uniforms.uWorldToVolume.value.copy(inverse);this.place(this.slice,point,normal);
    }
    if(this.live){
      this.live.visible=o.enabled;this.exact.visible=false;
      this.live.material.uniforms.uPlane.value.set(normal.x,normal.y,normal.z,-normal.dot(point));
      if(o.enabled){
        const c=v.bounds.getCenter(new THREE.Vector3());
        this.pending={type:'section',revision:this.revision,normal:normal.toArray(),constant:-normal.dot(c)-o.distance,
          center:c.toArray(),scale,epsilon:Math.max(v.bounds.getSize(new THREE.Vector3()).length()*1e-10,1e-20)};
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
        if(this.packet!==packet)return;
        if(data.type==='ready')this.workerReady=true;
        else if(data.type==='section'){
          this.busy=false;
          if(data.revision===this.revision&&this.options.enabled){
            this.exact.geometry.dispose();this.exact.geometry=new THREE.BufferGeometry();
            this.exact.geometry.setAttribute('position',new THREE.BufferAttribute(data.lines,3));
            this.segmentCount=data.lines.length/6;this.exact.visible=true;this.live.visible=false;
            this.view.dirty=true;this.onStatus('exact',this.segmentCount);
          }
        }
        this.dispatch();
      };
      worker.onerror=()=>{this.workerFailed=true;worker.terminate();this.worker=null;this.busy=false;this.onStatus('live');};
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
