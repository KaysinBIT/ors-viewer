import * as THREE from './vendor/three.module.js';

const sliceVertex = `
uniform mat4 uWorldToVolume;
out vec3 vTex;
void main(){vec4 w=modelMatrix*vec4(position,1.0);vTex=(uWorldToVolume*w).xyz+.5;gl_Position=projectionMatrix*viewMatrix*w;}`;
const sliceFragment = `
precision highp sampler3D;
uniform sampler3D uData;
uniform vec2 uWindow;
uniform float uOpacity;
in vec3 vTex;
out vec4 fragColor;
void main(){if(any(lessThan(vTex,vec3(0)))||any(greaterThan(vTex,vec3(1))))discard;
float v=clamp((texture(uData,vTex).r-uWindow.x)/max(uWindow.y-uWindow.x,.00001),0.0,1.0);
fragColor=vec4(vec3(v),uOpacity);}`;

export class SectionController {
  constructor(view) {
    this.view=view;this.plane=new THREE.Plane();this.root=new THREE.Group();view.scene.add(this.root);
    view.renderer.localClippingEnabled=true;
    this.options={enabled:false,azimuth:0,elevation:0,distance:0,flip:false,only:false,guide:true};
  }
  clear(){this.root.traverse(o=>{o.geometry?.dispose();o.material?.dispose();});this.root.clear();}
  limits(azimuth,elevation){
    const a=THREE.MathUtils.degToRad(azimuth),e=THREE.MathUtils.degToRad(elevation);
    const normal=new THREE.Vector3(Math.cos(e)*Math.cos(a),Math.cos(e)*Math.sin(a),Math.sin(e));
    const size=this.view.bounds?.getSize(new THREE.Vector3())||new THREE.Vector3(1,1,1);
    const half=(Math.abs(normal.x)*size.x+Math.abs(normal.y)*size.y+Math.abs(normal.z)*size.z)/2;
    return {normal,half};
  }
  update(options){
    this.options={...this.options,...options};const o=this.options,v=this.view;
    this.clear();if(!v.bounds)return;
    const {normal,half}=this.limits(o.azimuth,o.elevation);
    o.distance=Math.max(-half,Math.min(half,o.distance));
    const scale=v.group.scale.x,point=normal.clone().multiplyScalar(o.distance*scale);
    this.point=point;this.normal=normal;
    this.plane.setFromNormalAndCoplanarPoint(o.flip?normal.clone().negate():normal,point);
    v.materials.forEach(m=>{m.clippingPlanes=o.enabled?[this.plane]:[];m.needsUpdate=true;});
    if(v.mesh)v.mesh.visible=!(o.enabled&&o.only);
    if(v.volume){
      v.group.updateMatrixWorld(true);
      const inverse=v.volume.mesh.matrixWorld.clone().invert();
      const local=this.plane.clone().applyMatrix4(inverse);
      v.volume.common.uClipEnabled.value=o.enabled;
      v.volume.common.uClipPlane.value.set(local.normal.x,local.normal.y,local.normal.z,local.constant);
      v.volumeMode(v.volume.mode||'mip');
      if(o.enabled&&o.only){v.volume.mesh.visible=false;v.volume.planes.forEach(p=>p.visible=false);}
      if(o.enabled){
        const material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,side:THREE.DoubleSide,transparent:true,
          uniforms:{...v.volume.common,uWorldToVolume:{value:inverse}},vertexShader:sliceVertex,fragmentShader:sliceFragment});
        const slice=new THREE.Mesh(new THREE.PlaneGeometry(1,1),material);
        this.place(slice,point,normal);this.root.add(slice);
      }
    }
    if(o.enabled){
      if(o.guide){
        const plane=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({color:0x62dec4,opacity:.065,transparent:true,side:THREE.DoubleSide,depthWrite:false}));
        this.place(plane,point,normal);this.root.add(plane);
        const edge=new THREE.LineSegments(new THREE.EdgesGeometry(plane.geometry),new THREE.LineBasicMaterial({color:0x67dec0,transparent:true,opacity:.55}));
        edge.position.copy(plane.position);edge.quaternion.copy(plane.quaternion);edge.scale.copy(plane.scale);this.root.add(edge);
      }
      if(v.mesh)this.contour();
    }
    v.dirty=true;return half;
  }
  place(mesh,point,normal){
    const diameter=this.view.bounds.getSize(new THREE.Vector3()).length()*this.view.group.scale.x*1.05;
    mesh.position.copy(point);mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),normal);mesh.scale.setScalar(diameter);
  }
  contour(){
    const v=this.view,{positions:p,indices:f}=v.packet.arrays;
    const n=this.normal,c=v.bounds.getCenter(new THREE.Vector3()),scale=v.group.scale.x;
    const constant=-n.dot(c)-this.options.distance,lines=[];
    const epsilon=Math.max(v.bounds.getSize(new THREE.Vector3()).length()*1e-10,1e-20);
    for(let i=0;i<f.length;i+=3){
      const hit=[];
      for(let j=0;j<3;j++){
        const a=f[i+j]*3,b=f[i+(j+1)%3]*3;
        const da=n.x*p[a]+n.y*p[a+1]+n.z*p[a+2]+constant,db=n.x*p[b]+n.y*p[b+1]+n.z*p[b+2]+constant;
        if(Math.abs(da)<=epsilon)hit.push([p[a],p[a+1],p[a+2]]);
        else if((da<0&&db>epsilon)||(da>0&&db<-epsilon)){
          const t=da/(da-db);hit.push([p[a]+t*(p[b]-p[a]),p[a+1]+t*(p[b+1]-p[a+1]),p[a+2]+t*(p[b+2]-p[a+2])]);
        }
      }
      if(hit.length===2){for(const h of hit)lines.push((h[0]-c.x)*scale,(h[1]-c.y)*scale,(h[2]-c.z)*scale);}
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(lines,3));
    const segments=new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:0x78ffe0,depthTest:false,transparent:true,opacity:.95}));
    segments.renderOrder=10;this.root.add(segments);this.segmentCount=lines.length/6;
  }
  face(){if(!this.point)return;this.view.sectionView(this.normal,this.point);
    this.view.canvas.dataset.projection='orthographic';
    this.view.canvas.dataset.faceAlignment=String(-this.view.camera.getWorldDirection(new THREE.Vector3()).dot(this.normal));
  }
}
