import {contourFill,DEFAULT_FILL_LIMITS} from './contour-fill.js';

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];

export function planeBasis(normal) {
  const length=Math.hypot(...normal);
  if(!Number.isFinite(length)||length===0)throw new Error('剖面法线无效');
  const n=normal.map(value=>value/length);
  const horizontal=cross(Math.abs(n[2])<.9?[0,0,1]:[0,1,0],n);
  const scale=Math.hypot(...horizontal),u=horizontal.map(value=>value/scale);
  return {u,v:cross(n,u),normal:n};
}

// Project only the contour, not the original mesh. Reuse the validated hole-aware fill.
export function obliqueSectionFill(lines, normal, point, coplanarFlags, limits) {
  const {u,v}=planeBasis(normal);
  if(lines.length/6>(limits?.maxSegments??DEFAULT_FILL_LIMITS.maxSegments))return contourFill(lines,2,coplanarFlags,limits);
  const projected=new Float32Array(lines.length);
  for(let i=0;i<lines.length;i+=3){
    const relative=[lines[i]-point[0],lines[i+1]-point[1],lines[i+2]-point[2]];
    projected[i]=dot(relative,u);projected[i+1]=dot(relative,v);
  }
  const fill=contourFill(projected,2,coplanarFlags,limits);
  if(fill.status!=='filled')return fill;
  const restore=values=>{
    const output=new Float32Array(values.length);
    for(let i=0;i<values.length;i+=3)for(let d=0;d<3;d++)output[i+d]=point[d]+values[i]*u[d]+values[i+1]*v[d];
    return output;
  };
  return {...fill,positions:restore(fill.positions),boundary:restore(fill.boundary)};
}
