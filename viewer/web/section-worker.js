import { sectionSegments } from './section-math.js';
let positions,indices;
self.onmessage=({data})=>{
  if(data.type==='mesh'){positions=data.positions;indices=data.indices;self.postMessage({type:'ready'});return;}
  if(data.type!=='section'||!positions)return;
  const lines=sectionSegments(positions,indices,data.normal,data.constant,data.center,data.scale,data.epsilon);
  self.postMessage({type:'section',revision:data.revision,lines},[lines.buffer]);
};
