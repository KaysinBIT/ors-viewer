/** Spatial buckets retain every face; queries only prune disjoint bounding boxes. */
export function buildSectionIndex(positions,indices,bounds,resolution=0){
  const count=indices.length/3;if(!resolution&&count<4096)return null;
  const r=resolution||Math.min(64,Math.max(4,2**Math.ceil(Math.log2(Math.cbrt(count/64)))));
  const cells=r*r*r,counts=new Uint32Array(cells),bins=new Uint32Array(count),boxes=new Float64Array(cells*6);
  boxes.fill(Infinity);for(let i=0;i<cells;i++)for(let d=3;d<6;d++)boxes[i*6+d]=-Infinity;
  const inverse=bounds[0].map((lo,d)=>bounds[1][d]>lo?r/(bounds[1][d]-lo):0);
  for(let face=0;face<count;face++){
    const i=face*3,a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3;
    const x=Math.max(0,Math.min(r-1,Math.floor(((positions[a]+positions[b]+positions[c])/3-bounds[0][0])*inverse[0])));
    const y=Math.max(0,Math.min(r-1,Math.floor(((positions[a+1]+positions[b+1]+positions[c+1])/3-bounds[0][1])*inverse[1])));
    const z=Math.max(0,Math.min(r-1,Math.floor(((positions[a+2]+positions[b+2]+positions[c+2])/3-bounds[0][2])*inverse[2])));
    const bin=(x*r+y)*r+z,offset=bin*6;bins[face]=bin;counts[bin]++;
    for(let d=0;d<3;d++){boxes[offset+d]=Math.min(boxes[offset+d],positions[a+d],positions[b+d],positions[c+d]);boxes[offset+3+d]=Math.max(boxes[offset+3+d],positions[a+d],positions[b+d],positions[c+d]);}
  }
  const offsets=new Uint32Array(cells+1),occupied=[];
  for(let i=0;i<cells;i++){offsets[i+1]=offsets[i]+counts[i];if(counts[i])occupied.push(i);}
  const cursors=offsets.slice(0,-1),faces=new Uint32Array(count);
  for(let i=0;i<count;i++)faces[cursors[bins[i]]++]=i;
  return {boxes,offsets,faces,occupied:new Uint32Array(occupied)};
}
export function queryPlaneIndex(index,normal,constant,epsilon){
  if(!index)return null;const groups=[];
  for(const cell of index.occupied){
    const offset=cell*6;let low=constant,high=constant;
    for(let axis=0;axis<3;axis++){
      const a=normal[axis]*index.boxes[offset+axis],b=normal[axis]*index.boxes[offset+3+axis];low+=Math.min(a,b);high+=Math.max(a,b);
    }
    if(low<=epsilon&&high>=-epsilon)groups.push(index.faces.subarray(index.offsets[cell],index.offsets[cell+1]));
  }
  return groups;
}
export function querySectionIndex(index,coordinates,epsilon,selected=[true,true,true]){
  if(!index)return selected.map(on=>on?null:[]);
  return selected.map((on,axis)=>{
    const groups=[];if(!on)return groups;const cut=coordinates[axis];
    for(const cell of index.occupied){const offset=cell*6;if(cut>=index.boxes[offset+axis]-epsilon&&cut<=index.boxes[offset+3+axis]+epsilon)groups.push(index.faces.subarray(index.offsets[cell],index.offsets[cell+1]));}
    return groups;
  });
}
