// Row-major orthogonal transforms in source units; source/export buffers never change.
export const IDENTITY = Object.freeze([[1,0,0],[0,1,0],[0,0,1]].map(Object.freeze));
export const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const subtract=(a,b)=>a.map((x,i)=>x-b[i]);
const unit=a=>{const n=Math.hypot(...a);if(!n||!Number.isFinite(n))throw new Error('参考方向长度无效');return a.map(x=>x/n);};
const transpose=m=>m[0].map((_,i)=>m.map(r=>r[i]));
const multiply=(a,b)=>a.map(row=>transpose(b).map(col=>dot(row,col)));
export const mirrorSigns=mirror=>[0,1,2].map(i=>mirror?.[i]?-1:1);
export const originalPose=pivot=>({enabled:false,rotation:IDENTITY.map(row=>row.slice()),pivot:pivot.slice(),mirror:[false,false,false]});

export function poseMatrix(pose){
  const signs=mirrorSigns(pose?.enabled?pose.mirror:null);
  const r=pose?.enabled?pose.rotation.map((row,i)=>row.map(x=>x*signs[i])):IDENTITY,p=pose?.pivot||[0,0,0];
  return [...r.map((row,i)=>[...row,p[i]-dot(row,p)]),[0,0,0,1]];
}
export function transformPoint(matrix,p){return matrix.slice(0,3).map(row=>dot(row.slice(0,3),p)+row[3]);}
export function sourcePoint(matrix,p){return transpose(matrix.slice(0,3).map(r=>r.slice(0,3))).map(row=>dot(row,p.map((x,i)=>x-matrix[i][3])));}
export function sourcePlane(matrix,normal,constant){
  return {normal:[0,1,2].map(i=>dot(normal,matrix.slice(0,3).map(row=>row[i]))),constant:constant+dot(normal,matrix.slice(0,3).map(row=>row[3]))};
}
// Fixed axes, X then Y then Z: Rz * Ry * Rx.
export function rotationFromAngles(angles){
  const [x,y,z]=angles.map(a=>a*Math.PI/180),[cx,cy,cz]=[x,y,z].map(Math.cos),[sx,sy,sz]=[x,y,z].map(Math.sin);
  return [[cz*cy,cz*sy*sx-sz*cx,cz*sy*cx+sz*sx],[sz*cy,sz*sy*sx+cz*cx,sz*sy*cx-cz*sx],[-sy,cy*sx,cy*cx]];
}
export function anglesFromRotation(r){
  const y=Math.asin(Math.max(-1,Math.min(1,-r[2][0]))),locked=Math.abs(Math.cos(y))<1e-8;
  return [locked?0:Math.atan2(r[2][1],r[2][2]),y,locked?Math.atan2(-r[0][1],r[1][1]):Math.atan2(r[1][0],r[0][0])].map(x=>x*180/Math.PI);
}
export function faceRotation(normal,axis,direction=1){
  const a=unit(normal),b=[0,0,0];b[axis]=direction;
  const c=dot(a,b);
  if(c>1-1e-14)return IDENTITY.map(r=>r.slice());
  if(c<-1+1e-14){const helper=[0,0,0];helper[(axis+1)%3]=1;const n=unit(cross(a,helper));return n.map((x,i)=>n.map((y,j)=>2*x*y-(i===j?1:0)));}
  const v=cross(a,b),k=[[0,-v[2],v[1]],[v[2],0,-v[0]],[-v[1],v[0],0]],kk=multiply(k,k);
  return k.map((row,i)=>row.map((x,j)=>(i===j?1:0)+x+kk[i][j]/(1+c)));
}
export function faceAlignedRotation(pose,normal,axis){
  const current=pose.enabled?pose.rotation:IDENTITY;
  const delta=faceRotation(current.map(row=>dot(row,normal)),axis,mirrorSigns(pose.mirror)[axis]);
  return multiply(delta,current);
}
export function pointsRotation(points,axis,mirror=null){
  if(points.length!==3||points.some(p=>p.length!==3||p.some(x=>!Number.isFinite(x))))throw new Error('请选择三个有效参考点');
  const a=subtract(points[1],points[0]),b=subtract(points[2],points[0]),size=Math.max(Math.hypot(...a),Math.hypot(...b));
  if(size===0||Math.min(Math.hypot(...a),Math.hypot(...b),Math.hypot(...subtract(points[2],points[1])))<size*1e-8)throw new Error('参考点重合，请重新选择');
  const u=unit(a),n=cross(u,unit(b));if(Math.hypot(...n)<1e-6)throw new Error('三个参考点接近共线，请重新选择');
  const normal=unit(n),v=cross(normal,u);
  const targetNormal=[0,0,0],targetU=[0,0,0];targetNormal[axis]=1;targetU[axis===0?1:0]=1;
  const signs=mirrorSigns(mirror),parity=signs.reduce((a,b)=>a*b,1);
  // A reflected ordered point triple reverses winding. Undo that parity only
  // in the reference frame, keeping rotation proper and mirror flags separate.
  const target=[targetU,cross(targetNormal,targetU),targetNormal].map((row,i)=>row.map((x,j)=>x*signs[j]*(i===2?parity:1)));
  return multiply(transpose(target),[u,v,normal]);
}
