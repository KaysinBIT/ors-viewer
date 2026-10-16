import {meshSections} from './mesh-sections-math.js';
import {contourFill} from './contour-fill.js';
import {buildSectionIndex,querySectionIndex,queryPlaneIndex} from './mesh-section-index.js';
import {sectionContours} from './section-math.js';
import {sourcePlane} from './alignment-math.js';
let positions,indices,index,cache,serial=0,fillTimer;
const pending=()=>({status:'pending',message:'填充后台更新中',positions:new Float32Array(),indices:new Uint32Array(),offsets:new Uint32Array(),boundary:new Float32Array(),loops:0,holes:0});
function snapshot(data,phase){
  return {type:'sections',phase,revision:data.revision,poseKey:data.poseKey,coordinates:data.coordinates.slice(),lines:cache.lines,counts:cache.counts,coplanar:cache.coplanar,
    fills:cache.fills.map((f,axis)=>f?.coordinate===data.coordinates[axis]?f.result:pending())};
}
self.onmessage=({data})=>{
  if(data.type==='mesh'){
    ++serial;clearTimeout(fillTimer);positions=data.positions;indices=data.indices;
    index=buildSectionIndex(positions,indices,data.bounds);cache={coordinates:[NaN,NaN,NaN],lines:[],counts:[],coplanar:[],flags:[],fills:[null,null,null]};
    self.postMessage({type:'ready'});return;
  }
  if(data.type!=='sections'||!positions)return;
  const job=++serial;clearTimeout(fillTimer);
  try{
    const changed=data.coordinates.map((x,i)=>x!==cache.coordinates[i]||data.poseKey!==cache.poseKey);
    let result;
    if(data.transform){
      result={lines:[],counts:[],coplanar:[],coplanarFlags:[]};
      for(let axis=0;axis<3;axis++)if(changed[axis]){
        const normal=[0,0,0];normal[axis]=1;const p=sourcePlane(data.transform,normal,-data.coordinates[axis]);
        const cut=sectionContours(positions,indices,p.normal,p.constant,data.center,data.scale,data.epsilon,data.transform,queryPlaneIndex(index,p.normal,p.constant,data.epsilon),2000000);
        result.lines[axis]=cut.lines;result.counts[axis]=cut.lines.length/6;result.coplanarFlags[axis]=cut.coplanarFlags;result.coplanar[axis]=cut.coplanarFlags.some(Boolean);
      }
    }else result=meshSections(positions,indices,data.coordinates,data.center,data.scale,data.epsilon,2000000,querySectionIndex(index,data.coordinates,data.epsilon,changed));
    cache.poseKey=data.poseKey;
    for(let axis=0;axis<3;axis++)if(changed[axis]){
      cache.lines[axis]=result.lines[axis];cache.counts[axis]=result.counts[axis];cache.coplanar[axis]=result.coplanar[axis];cache.flags[axis]=result.coplanarFlags[axis];cache.fills[axis]=null;
    }
    cache.coordinates=data.coordinates.slice();
    self.postMessage(snapshot(data,'lines'));
    // Contours are published immediately; fill validation runs between inputs.
    fillTimer=setTimeout(async()=>{
      try{
        for(let axis=0;axis<3;axis++){
          if(job!==serial)return;
          if(!cache.fills[axis])cache.fills[axis]={coordinate:data.coordinates[axis],result:contourFill(cache.lines[axis],axis,cache.flags[axis])};
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        if(job===serial)self.postMessage(snapshot(data,'fill'));
      }catch(error){if(job===serial)self.postMessage({type:'fill-error',revision:data.revision,message:error.message});}
    },cache.counts.reduce((sum,n)=>sum+n,0)<5000?0:35);
  }catch(error){self.postMessage({type:'error',revision:data.revision,message:error.message});}
};
