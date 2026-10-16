import { sectionContours } from './section-math.js';
import { obliqueSectionFill } from './section-fill.js';
let positions,indices,serial=0,fillTimer;
self.onmessage=({data})=>{
  if(data.type==='mesh'){++serial;clearTimeout(fillTimer);positions=data.positions;indices=data.indices;self.postMessage({type:'ready'});return;}
  if(data.type!=='section'||!positions)return;
  const job=++serial;clearTimeout(fillTimer);
  const {lines,coplanarFlags}=sectionContours(positions,indices,data.normal,data.constant,data.center,data.scale,data.epsilon);
  self.postMessage({type:'section',revision:data.revision,lines,fillPending:true});
  // Publish the contour first. Superseded fill jobs must never cover a newer plane.
  fillTimer=setTimeout(()=>{
    if(job!==serial)return;
    try{
      const fill=obliqueSectionFill(lines,data.normal,data.point,coplanarFlags);
      if(job===serial)self.postMessage({type:'fill',revision:data.revision,fill},[fill.positions.buffer,fill.indices.buffer,fill.offsets.buffer,fill.boundary.buffer]);
    }catch(error){if(job===serial)self.postMessage({type:'fill-error',revision:data.revision,message:error.message});}
  },lines.length<30000?0:35);
};
