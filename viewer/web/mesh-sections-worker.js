import {meshSections} from './mesh-sections-math.js';
let positions,indices;
self.onmessage=({data})=>{
  if(data.type==='mesh'){positions=data.positions;indices=data.indices;self.postMessage({type:'ready'});return;}
  if(data.type!=='sections'||!positions)return;
  try{
    const result=meshSections(positions,indices,data.coordinates,data.center,data.scale,data.epsilon);
    self.postMessage({type:'sections',revision:data.revision,coordinates:data.coordinates,...result},result.lines.map(a=>a.buffer));
  }catch(error){self.postMessage({type:'error',revision:data.revision,message:error.message});}
};
