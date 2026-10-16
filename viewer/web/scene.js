import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import {DEFAULT_THEME} from './themes.js';

export function parsePacket(buffer) {
  const view = new DataView(buffer), length = view.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
  const base = 4 + Math.ceil(length / 4) * 4, arrays = {};
  for (const [key, info] of Object.entries(meta.arrays)) {
    const dtype = info.dtype.replace(/[<>=|]/g, '');
    const Type = { f4: Float32Array, u4: Uint32Array, u1: Uint8Array }[dtype];
    if (!Type) throw new Error(`不支持的显示数组类型：${dtype}`);
    arrays[key] = new Type(buffer, base + info.offset, info.bytes / Type.BYTES_PER_ELEMENT);
  }
  return { meta, arrays };
}

export function labelColor(id) {
  const hue = (Number(id) * 137.508 + 18) % 360;
  return new THREE.Color().setHSL(hue / 360, .57, .61);
}
export function ramp(t) {
  const colors = [0x315ba6, 0x2cb6c7, 0x9cdfa5, 0xf0b269].map(c => new THREE.Color(c));
  const v = Math.max(0, Math.min(1, t)) * 3, i = Math.min(2, Math.floor(v));
  return colors[i].clone().lerp(colors[i + 1], v - i);
}

const volumeVertex = `
uniform bool uOrthographic;
uniform vec3 uCameraDirection;
out vec3 vOrigin;
out vec3 vDirection;
void main() {
  vOrigin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
  vDirection = position - vOrigin;
  if(uOrthographic){vDirection=(inverse(modelMatrix)*vec4(uCameraDirection,0.0)).xyz;vOrigin=position-normalize(vDirection)*4.0;}
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const volumeFragment = `
precision highp sampler3D;
uniform sampler3D uData;
uniform vec2 uWindow;
uniform vec3 uTextureSize;
uniform float uOpacity;
uniform float uIso;
uniform vec3 uTint;
uniform int uMode;
uniform int uSteps;
uniform bool uClipEnabled;
uniform vec4 uClipPlane;
in vec3 vOrigin;
in vec3 vDirection;
out vec4 fragColor;
float valueAt(vec3 p) {
  return clamp((texture(uData, p).r - uWindow.x) / max(uWindow.y - uWindow.x, .00001), 0.0, 1.0);
}
vec3 gradient(vec3 p) {
  vec3 d = 1.0 / uTextureSize;
  return normalize(vec3(
    texture(uData,p+vec3(d.x,0,0)).r-texture(uData,p-vec3(d.x,0,0)).r,
    texture(uData,p+vec3(0,d.y,0)).r-texture(uData,p-vec3(0,d.y,0)).r,
    texture(uData,p+vec3(0,0,d.z)).r-texture(uData,p-vec3(0,0,d.z)).r) + vec3(.000001));
}
void main() {
  vec3 ray = normalize(vDirection);
  vec3 inv = 1.0 / ray;
  vec3 a = (-.5 - vOrigin) * inv;
  vec3 b = (.5 - vOrigin) * inv;
  vec3 low = min(a,b), high = max(a,b);
  float nearT = max(max(low.x,low.y),max(low.z,0.0));
  float farT = min(min(high.x,high.y),high.z);
  if (nearT >= farT) discard;
  float stepT = (farT-nearT)/float(uSteps);
  float maximum = 0.0;
  for(int i=0;i<240;i++) {
    if(i >= uSteps) break;
    vec3 p = vOrigin + ray * (nearT + (float(i)+.5)*stepT) + .5;
    if(uClipEnabled && dot(uClipPlane.xyz,p-.5)+uClipPlane.w < 0.0) continue;
    float v = valueAt(p);
    if(uMode == 1 && v >= uIso) {
      vec3 n = gradient(p);
      float light = .25 + .55*abs(dot(n,normalize(vec3(.5,-.7,1.0)))) + .2*abs(dot(n,-ray));
      fragColor = vec4(uTint*light, uOpacity);
      return;
    }
    maximum = max(maximum,v);
  }
  if(uMode == 1 || maximum < .025) discard;
  vec3 color = uTint*pow(maximum,.72);
  fragColor = vec4(color, pow(maximum,.55)*uOpacity);
}`;
const sliceVertex = `
uniform int uAxis;
uniform float uSlice;
out vec3 vTex;
void main() {
  vec3 p = position;
  if(uAxis == 0) p = vec3(uSlice-.5,position.x,position.y);
  else if(uAxis == 1) p = vec3(position.x,uSlice-.5,position.y);
  else p = vec3(position.x,position.y,uSlice-.5);
  vTex = p+.5;
  gl_Position = projectionMatrix*modelViewMatrix*vec4(p,1.0);
}`;
const sliceFragment = `
precision highp sampler3D;
uniform sampler3D uData;
uniform sampler2D uSliceData;
uniform bool uExactSlice;
uniform int uAxis;
uniform vec2 uWindow;
uniform float uOpacity;
uniform bool uClipEnabled;
uniform vec4 uClipPlane;
in vec3 vTex;
out vec4 fragColor;
void main() {
  if(uClipEnabled && dot(uClipPlane.xyz,vTex-.5)+uClipPlane.w < 0.0) discard;
  float v=clamp((texture(uData,vTex).r-uWindow.x)/max(uWindow.y-uWindow.x,.00001),0.0,1.0);
  if(uExactSlice){vec2 uv=uAxis==0?vTex.yz:(uAxis==1?vTex.xz:vTex.xy);v=texture(uSliceData,uv).r;}
  fragColor=vec4(vec3(v),uOpacity);
}`;

export class SceneView {
  constructor(canvas, onError) {
    this.canvas = canvas;
    this.theme=DEFAULT_THEME;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.setClearColor(0, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, .01, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(3.4, -4.5, 2.7);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .1;
    this.controls.minDistance = .15;
    this.controls.maxDistance = 25;
    this.controls.minPolarAngle = .008;
    this.controls.maxPolarAngle = Math.PI - .008;
    this.controls.autoRotateSpeed = 1;
    this.controls.addEventListener('change', () => this.dirty = true);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 3.2); key.position.set(3, -3, 5);this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 1.1);fill.position.set(-3, 2, 1);this.scene.add(fill);
    this.group = new THREE.Group();this.scene.add(this.group);
    this.grid = new THREE.GridHelper(5, 20, 0x395565, 0x233d4e);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;this.grid.material.opacity = .45;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(.6);this.axes.position.set(-1.35, -1.3, -1.1);this.scene.add(this.axes);
    this.box = null;this.dirty = true;this.materials = [];this.volume = null;this.mesh = null;
    this.renderer.debug.onShaderError = (_, __, ___, vertexShader, fragmentShader) => {
      onError('三维着色器无法在当前浏览器运行，请尝试更新浏览器或使用其他显示方式。');
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.renderer.setSize(rect.width, rect.height, false);
      this.camera.aspect = rect.width / rect.height;
      if(this.camera.isOrthographicCamera){this.camera.left=-this.camera.top*this.camera.aspect;this.camera.right=this.camera.top*this.camera.aspect;}
      this.camera.updateProjectionMatrix();
      if(this.bounds&&!this.camera.isOrthographicCamera)this.fit(true);this.dirty = true;
    };
    new ResizeObserver(resize).observe(canvas.parentElement);resize();
    const animate = () => {
      requestAnimationFrame(animate);
      const changed = this.controls.update();
      if (changed || this.dirty || this.controls.autoRotate) {
        if(this.volume){this.volume.material.uniforms.uOrthographic.value=!!this.camera.isOrthographicCamera;this.camera.getWorldDirection(this.volume.material.uniforms.uCameraDirection.value);}
        this.renderer.render(this.scene, this.camera);this.dirty = false;
        if(this.volume)this.canvas.dataset.renderedSlices=this.volume.indices.join(',');
        if(this.meshPlaneCoordinates)this.canvas.dataset.renderedMeshPlanes=this.meshPlaneCoordinates.join(',');
        this.canvas.dataset.renderedTheme=this.theme.name;
        if(this.sectionRevision!==undefined){this.canvas.dataset.renderedSectionRevision=String(this.sectionRevision);this.canvas.dataset.renderedSectionDistance=String(this.sectionDistance);}
      }
    };animate();
  }

  clear() {
    const geometry = new Set(), materials = new Set(), textures = new Set();
    this.group.traverse(o => {
      if (o.geometry) geometry.add(o.geometry);
      const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      ms.forEach(m => {materials.add(m);if(m.uniforms?.uData) textures.add(m.uniforms.uData.value);if(m.uniforms?.uSliceData)textures.add(m.uniforms.uSliceData.value);});
    });
    geometry.forEach(g => g.dispose());materials.forEach(m => m.dispose());textures.forEach(t => t.dispose());
    this.group.clear();this.group.position.set(0, 0, 0);this.group.scale.setScalar(1);
    if(this.box){this.scene.remove(this.box);this.box.geometry.dispose();this.box.material.dispose();this.box=null;}
    this.materials=[];this.mesh=null;this.volume=null;this.labelMaterials = new Map();this.dirty=true;
    this.meshPlaneCoordinates=null;delete this.canvas.dataset.renderedMeshPlanes;
  }

  load(packet) {
    this.clear();this.packet = packet;
    const { meta, arrays } = packet;
    let bounds;
    if (meta.kind === 'volume') {
      bounds = this.addVolume(meta, arrays);
    } else {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
      if(arrays.normals)geometry.setAttribute('normal',new THREE.BufferAttribute(arrays.normals,3));
      else geometry.computeVertexNormals();
      if(meta.kind === 'labels') {
        const materials = meta.groups.map((g, i) => {
          const m = new THREE.MeshStandardMaterial({ color: labelColor(g.id), roughness: .6, metalness: .03, side: THREE.DoubleSide });
          geometry.addGroup(g.start, g.count, i);this.labelMaterials.set(g.id,m);return m;
        });
        this.materials = materials;
        this.mesh = new THREE.Mesh(geometry, materials);
      } else {
        const material = new THREE.MeshStandardMaterial({ color: 0xc4a273, roughness: .5, metalness: .14, side: THREE.DoubleSide });
        this.materials = [material];this.mesh = new THREE.Mesh(geometry, material);
      }
      this.group.add(this.mesh);
      geometry.computeBoundingBox();bounds=geometry.boundingBox.clone();
      if(meta.bounds)bounds.set(new THREE.Vector3(...meta.bounds[0]),new THREE.Vector3(...meta.bounds[1]));
      if(bounds.isEmpty()) bounds.set(new THREE.Vector3(-.5,-.5,-.5),new THREE.Vector3(.5,.5,.5));
    }
    this.sourceBounds = bounds.clone();this.alignment=new THREE.Matrix4();
    this.bounds = bounds;
    const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());
    const scale=2/Math.max(size.x,size.y,size.z,1e-10);
    this.group.scale.setScalar(scale);this.group.position.copy(center).multiplyScalar(-scale);
    const normalized = bounds.clone();normalized.min.sub(center).multiplyScalar(scale);normalized.max.sub(center).multiplyScalar(scale);
    this.box = new THREE.Box3Helper(normalized, 0x719caf);this.box.visible = false;
    this.box.material.transparent = true;this.box.material.opacity=.5;this.scene.add(this.box);
    this.grid.position.z=normalized.min.z-.06;this.axes.position.z=normalized.min.z-.03;
    this.setTheme(this.theme);this.fit();this.dirty=true;
  }

  setAlignment(rows){
    if(!this.sourceBounds)return;
    this.alignment.set(...rows.flat());
    if(this.mesh){this.mesh.matrixAutoUpdate=false;this.mesh.matrix.copy(this.alignment);}
    if(this.volume){
      const matrix=this.alignment.clone().multiply(new THREE.Matrix4().set(...this.volume.meta.matrix.flat()));
      for(const object of [this.volume.mesh,...this.volume.planes,...this.volume.outlines]){object.matrixAutoUpdate=false;object.matrix.copy(matrix);}
    }
    this.bounds=this.sourceBounds.clone().applyMatrix4(this.alignment);
    const center=this.bounds.getCenter(new THREE.Vector3()),size=this.bounds.getSize(new THREE.Vector3()),scale=2/Math.max(size.x,size.y,size.z,1e-10);
    this.group.scale.setScalar(scale);this.group.position.copy(center).multiplyScalar(-scale);this.group.updateMatrixWorld(true);
    const normalized=this.bounds.clone();normalized.min.sub(center).multiplyScalar(scale);normalized.max.sub(center).multiplyScalar(scale);
    if(this.box){this.box.box.copy(normalized);this.box.updateMatrixWorld(true);}
    this.grid.position.z=normalized.min.z-.06;this.axes.position.z=normalized.min.z-.03;this.dirty=true;
  }

  pickSource(event){
    // A volume proxy box is not a CT surface. CT reference points come from MPR.
    if(!this.mesh||!this.mesh.visible)return null;
    const rect=this.canvas.getBoundingClientRect(),mouse=new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
    this.scene.updateMatrixWorld(true);const ray=new THREE.Raycaster();ray.setFromCamera(mouse,this.camera);
    const hits=ray.intersectObject(this.mesh,false);
    for(const hit of hits){
      const material=Array.isArray(this.mesh.material)?this.mesh.material[hit.face.materialIndex]:this.mesh.material;
      if(!material?.visible||material.clippingPlanes?.some(p=>p.distanceToPoint(hit.point)<0))continue;
      return {point:hit.point.clone().applyMatrix4(this.mesh.matrixWorld.clone().invert()).toArray(),normal:hit.face.normal.toArray()};
    }
    return null;
  }

  addVolume(meta, arrays) {
    const [nz,ny,nx] = meta.sample_shape_zyx;
    const texture = new THREE.Data3DTexture(arrays.volume,nx,ny,nz);
    texture.format=THREE.RedFormat;texture.type=THREE.UnsignedByteType;
    texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;
    texture.unpackAlignment=1;texture.needsUpdate=true;
    const common = {uData:{value:texture},uWindow:{value:new THREE.Vector2(0,1)},uOpacity:{value:1},uClipEnabled:{value:false},uClipPlane:{value:new THREE.Vector4()}};
    const material = new THREE.ShaderMaterial({ glslVersion:THREE.GLSL3,side:THREE.BackSide,transparent:true,
      uniforms:{...common,uTextureSize:{value:new THREE.Vector3(nx,ny,nz)},uMode:{value:0},uTint:{value:new THREE.Color(this.theme.mesh)},uIso:{value:.5},uSteps:{value:200},uOrthographic:{value:false},uCameraDirection:{value:new THREE.Vector3(0,0,-1)}},
      vertexShader:volumeVertex,fragmentShader:volumeFragment,depthWrite:false });
    const matrix=new THREE.Matrix4().set(...meta.matrix.flat());
    const volume=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),material);
    volume.matrixAutoUpdate=false;volume.matrix.copy(matrix);this.group.add(volume);
    const planes = [], outlines=[];
    for(let axis=0;axis<3;axis++) {
      const blank=new THREE.DataTexture(new Uint8Array([0,0,0,255]),1,1);blank.needsUpdate=true;
      const mat=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,side:THREE.DoubleSide,transparent:true,
        uniforms:{...common,uAxis:{value:axis},uSlice:{value:.5},uSliceData:{value:blank},uExactSlice:{value:false}},vertexShader:sliceVertex,fragmentShader:sliceFragment});
      const plane=new THREE.Mesh(new THREE.PlaneGeometry(1,1),mat);plane.matrixAutoUpdate=false;
      plane.matrix.copy(matrix);plane.frustumCulled=false;plane.visible=false;this.group.add(plane);planes.push(plane);
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(12),3));
      const line=new THREE.LineLoop(geometry,new THREE.LineBasicMaterial({color:[0xff4545,0x31e65f,0x4585ff][axis],depthTest:false}));
      line.matrixAutoUpdate=false;line.matrix.copy(matrix);line.frustumCulled=false;line.visible=false;line.renderOrder=3;this.group.add(line);outlines.push(line);
    }
    this.volume={mesh:volume,planes,outlines,material,common,meta,indices:[-1,-1,-1]};
    this.setWindow(...meta.window);
    return new THREE.Box3(new THREE.Vector3(-.5,-.5,-.5),new THREE.Vector3(.5,.5,.5)).applyMatrix4(matrix);
  }

  fit(preserveDirection=false) {
    const size=this.bounds?.getSize(new THREE.Vector3())||new THREE.Vector3(1,1,1);
    const largest=Math.max(size.x,size.y,size.z,1e-10),radius=size.length()/largest;
    const vfov=THREE.MathUtils.degToRad(this.camera.fov||38),hfov=2*Math.atan(Math.tan(vfov/2)*this.camera.aspect);
    const distance=radius/Math.sin(Math.min(vfov,hfov)/2)*1.1;
    const direction=preserveDirection?this.camera.position.clone().sub(this.controls.target):new THREE.Vector3(3.25,-4.1,2.5);
    this.controls.target.set(0,0,0);this.camera.position.copy(direction.normalize().multiplyScalar(distance));
    if(this.camera.isOrthographicCamera){const half=radius*1.15/Math.min(1,this.camera.aspect);this.camera.top=half;this.camera.bottom=-half;this.camera.left=-half*this.camera.aspect;this.camera.right=half*this.camera.aspect;this.camera.zoom=1;this.camera.updateProjectionMatrix();}
    this.controls.update();this.dirty=true;
  }
  view(direction) {
    const distance=Math.max(3.5,this.camera.position.distanceTo(this.controls.target));
    const views={front:[0,-distance,.0001],top:[0,-.001,distance],side:[distance,0,.0001]};
    this.controls.target.set(0,0,0);this.camera.position.set(...views[direction]);this.controls.update();this.dirty=true;
  }
  opacity(value) {
    this.materials.forEach(m=>{m.opacity=value;m.transparent=value<1;m.depthWrite=value>=1;m.needsUpdate=true;});
    if(this.volume)this.volume.common.uOpacity.value=value;this.dirty=true;
  }
  wireframe(value){this.materials.forEach(m=>m.wireframe=value);this.dirty=true;}
  showGrid(value){this.grid.visible=value;this.axes.visible=value;this.dirty=true;}
  showBox(value){if(this.box)this.box.visible=value;this.dirty=true;}
  rotate(value){this.controls.autoRotate=value;this.dirty=true;}
  label(id){this.labelMaterials.forEach((m,key)=>m.visible=id===0||key===id);this.dirty=true;}
  colorScalar(key) {
    if(!this.mesh || this.packet.meta.kind!=='mesh')return;
    const geometry=this.mesh.geometry,material=this.materials[0];
    if(key==='solid') {material.vertexColors=false;material.color.set(this.theme.mesh);geometry.deleteAttribute('color');}
    else {
      const info=this.packet.meta.scalars.find(s=>s.key===key),values=this.packet.arrays[key];if(!info||!values)return;
      const colors=new Float32Array(values.length*3);
      for(let i=0;i<values.length;i++) {
        const c=Number.isFinite(values[i])?ramp((values[i]-info.min)/Math.max(info.max-info.min,1e-20)):new THREE.Color(0x777777);
        c.toArray(colors,i*3);
      }
      geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));material.vertexColors=true;material.color.setHex(0xffffff);
    }
    material.needsUpdate=true;this.dirty=true;
  }
  volumeMode(mode){if(!this.volume)return;this.volume.mode=mode;this.volume.mesh.visible=mode!=='slices';this.volume.planes.forEach(p=>p.visible=mode==='slices'&&!this.resliceActive);this.volume.outlines.forEach(p=>p.visible=mode==='slices'&&!this.resliceActive);this.volume.material.uniforms.uMode.value=mode==='iso'?1:0;this.dirty=true;}
  sectionView(normal,point,reset=false){
    const up=Math.abs(normal.z)>.98?new THREE.Vector3(0,1,0):new THREE.Vector3(0,0,1);
    if(this.camera.isOrthographicCamera&&!reset){
      const distance=this.camera.position.distanceTo(this.controls.target),changedUp=!this.camera.up.equals(up);
      this.camera.position.copy(point).addScaledVector(normal,distance);this.camera.up.copy(up);
      if(changedUp)this.replaceCamera(this.camera,point);
      else{this.controls.target.copy(point);this.controls.update();this.dirty=true;}
      return;
    }
    const aspect=this.camera.aspect, radius=this.bounds.getSize(new THREE.Vector3()).length()*this.group.scale.x/2;
    const half=radius*1.1/Math.min(1,aspect),camera=new THREE.OrthographicCamera(-half*aspect,half*aspect,half,-half,.01,100);
    camera.aspect=aspect;camera.up.copy(up);
    camera.position.copy(point).addScaledVector(normal,6);this.replaceCamera(camera,point);
  }
  perspective(){const camera=new THREE.PerspectiveCamera(38,this.camera.aspect,.01,100);camera.up.set(0,0,1);camera.position.copy(this.camera.position);this.replaceCamera(camera,this.controls.target.clone());this.fit(true);}
  replaceCamera(camera,target){
    this.controls.dispose();this.camera=camera;this.controls=new OrbitControls(camera,this.canvas);
    this.controls.enableDamping=true;this.controls.dampingFactor=.1;this.controls.minDistance=.15;this.controls.maxDistance=25;
    this.controls.addEventListener('change',()=>this.dirty=true);this.controls.target.copy(target);this.controls.update();this.dirty=true;
  }
  setWindow(low,high){if(!this.volume)return;const [min,max]=this.volume.meta.range;this.volume.common.uWindow.value.set((low-min)/Math.max(max-min,1e-20),(high-min)/Math.max(max-min,1e-20));this.dirty=true;}
  iso(value){if(this.volume)this.volume.material.uniforms.uIso.value=value;this.dirty=true;}
  slice(axis,index){
    if(!this.volume)return;const v=this.volume,n=v.meta.original_shape_tzyx[3-axis],fraction=(index+.5)/n;
    if(v.indices[axis]!==index)v.planes[axis].material.uniforms.uExactSlice.value=false;
    v.indices[axis]=index;v.planes[axis].material.uniforms.uSlice.value=fraction;
    const [u,w]=[[1,2],[0,2],[0,1]][axis],positions=v.outlines[axis].geometry.attributes.position;
    [[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]].forEach((corner,i)=>{const point=[0,0,0];point[axis]=fraction-.5;point[u]=corner[0];point[w]=corner[1];positions.setXYZ(i,...point);});
    positions.needsUpdate=true;this.dirty=true;
  }
  exactSlice(axis,canvas){
    if(!this.volume||Math.max(canvas.width,canvas.height)>this.renderer.capabilities.maxTextureSize)return;
    const uniforms=this.volume.planes[axis].material.uniforms;let texture=uniforms.uSliceData.value;
    if(!texture.isCanvasTexture){texture.dispose();texture=new THREE.CanvasTexture(canvas);texture.minFilter=texture.magFilter=THREE.NearestFilter;texture.generateMipmaps=false;uniforms.uSliceData.value=texture;}
    texture.image=canvas;texture.needsUpdate=true;uniforms.uExactSlice.value=true;this.dirty=true;
  }
  setTheme(theme){
    this.theme=theme;this.renderer.setClearColor(theme.canvas,1);
    if(this.mesh&&this.packet?.meta.kind==='mesh'&&!this.materials[0].vertexColors)this.materials[0].color.set(theme.mesh);
    const colors=this.grid.geometry.attributes.color,c=new THREE.Color(theme.grid);
    for(let i=0;i<colors.count;i++)colors.setXYZ(i,c.r,c.g,c.b);colors.needsUpdate=true;
    this.axes.setColors(...theme.axes);if(this.box)this.box.material.color.set(theme.grid);
    if(this.volume){this.volume.material.uniforms.uTint.value.set(theme.mesh);this.volume.outlines.forEach((p,i)=>p.material.color.set(theme.axes[i]));}
    this.dirty=true;
  }
  screenshot(){this.renderer.render(this.scene,this.camera);return this.canvas.toDataURL('image/png');}
}
