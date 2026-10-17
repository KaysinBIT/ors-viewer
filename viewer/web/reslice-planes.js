import * as THREE from './vendor/three.module.js';

// Use the already loaded, user-selected CT preview while full-resolution planes
// are calculated. Coordinates stay in the fixed display frame, including mirrors.
const previewVertex=`uniform mat4 uWorldToVolume;out vec3 vTex;
void main(){vec4 world=modelMatrix*vec4(position,1.0);vTex=(uWorldToVolume*world).xyz+.5;gl_Position=projectionMatrix*viewMatrix*world;}`;
const previewFragment=`precision highp sampler3D;uniform sampler3D uData;uniform vec2 uWindow;uniform float uOpacity;in vec3 vTex;out vec4 fragColor;
void main(){if(any(lessThan(vTex,vec3(0.0)))||any(greaterThan(vTex,vec3(1.0))))discard;
float gray=clamp((texture(uData,vTex).r-uWindow.x)/max(uWindow.y-uWindow.x,.00001),0.0,1.0);fragColor=vec4(vec3(gray),uOpacity);}`;

// Fixed world-axis textured planes, separate from the rotated volume proxy.
export class ReslicePlanes {
  constructor(view){this.view=view;this.root=new THREE.Group();view.scene.add(this.root);this.planes=[];this.edges=[];this.fallbacks=[];}
  clear(){this.root.traverse(o=>{o.geometry?.dispose();o.material?.map?.dispose();o.material?.dispose();});this.root.clear();this.planes=[];this.edges=[];this.fallbacks=[];this.root.visible=false;this.info=null;this.coordinates=null;this.view.resliceActive=false;}
  source(info){
    this.clear();this.info=info;
    for(let axis=0;axis<3;axis++){
      const plane=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({side:THREE.DoubleSide,transparent:true,depthWrite:false}));
      plane.matrixAutoUpdate=false;plane.frustumCulled=false;plane.visible=false;
      const edge=new THREE.LineLoop(new THREE.BufferGeometry().setAttribute('position',new THREE.BufferAttribute(new Float32Array(12),3)),new THREE.LineBasicMaterial({color:this.view.theme.axes[axis],depthTest:false}));
      edge.frustumCulled=false;edge.renderOrder=3;this.root.add(plane,edge);this.planes.push(plane);this.edges.push(edge);
      if(this.view.volume){
        const volume=this.view.volume;
        const material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,side:THREE.DoubleSide,transparent:true,depthWrite:false,
          uniforms:{uData:volume.common.uData,uWindow:volume.common.uWindow,uOpacity:volume.common.uOpacity,uWorldToVolume:{value:new THREE.Matrix4()}},vertexShader:previewVertex,fragmentShader:previewFragment});
        const fallback=new THREE.Mesh(new THREE.PlaneGeometry(1,1),material);fallback.matrixAutoUpdate=false;fallback.frustumCulled=false;fallback.visible=false;
        this.fallbacks[axis]=fallback;this.root.add(fallback);
      }
    }
  }
  setActive(active){this.root.visible=active;this.view.resliceActive=active;this.view.dirty=true;}
  setTheme(theme){this.edges.forEach((edge,i)=>edge.material.color.set(theme.axes[i]));}
  position(coords){
    if(!this.info)return;const info=this.info,center=this.view.bounds.getCenter(new THREE.Vector3()).toArray(),scale=this.view.group.scale.x;
    for(let axis=0;axis<3;axis++){
      const plane=this.planes[axis],[u,v]=[[1,2],[0,2],[0,1]][axis],width=info.shape_xyz[u]*info.spacing[u],height=info.shape_xyz[v]*info.spacing[v];
      const origin=coords.slice();origin[u]=info.origin[u]+(info.shape_xyz[u]-1)*info.spacing[u]/2;origin[v]=info.origin[v]+(info.shape_xyz[v]-1)*info.spacing[v]/2;
      const e=new THREE.Vector3(),f=new THREE.Vector3(),n=new THREE.Vector3();e.setComponent(u,width*scale);f.setComponent(v,height*scale);n.setComponent(axis,1);
      plane.matrix.makeBasis(e,f,n).setPosition(new THREE.Vector3(...origin.map((x,i)=>(x-center[i])*scale)));
      if(this.coordinates?.[axis]!==coords[axis])plane.visible=false;
      const fallback=this.fallbacks[axis];
      if(fallback){
        this.view.group.updateMatrixWorld(true);fallback.matrix.copy(plane.matrix);
        fallback.material.uniforms.uWorldToVolume.value.copy(this.view.volume.mesh.matrixWorld).invert();
        fallback.visible=!plane.visible;
      }
      const positions=this.edges[axis].geometry.attributes.position;
      [[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]].forEach(([x,y],i)=>positions.setXYZ(i,...new THREE.Vector3(x,y,0).applyMatrix4(plane.matrix).toArray()));
      positions.needsUpdate=true;
    }
    this.coordinates=coords.slice();this.view.dirty=true;
  }
  image(axis,canvas){
    const plane=this.planes[axis];if(!plane||Math.max(canvas.width,canvas.height)>this.view.renderer.capabilities.maxTextureSize)return false;
    let texture=plane.material.map;
    if(!texture){texture=new THREE.CanvasTexture(canvas);texture.minFilter=texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;texture.colorSpace=THREE.SRGBColorSpace;plane.material.map=texture;plane.material.needsUpdate=true;}
    texture.image=canvas;texture.needsUpdate=true;plane.visible=true;if(this.fallbacks[axis])this.fallbacks[axis].visible=false;this.view.dirty=true;return true;
  }
}
