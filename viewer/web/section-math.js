// Exact triangle/plane intersections, shared by the worker and numerical tests.
export function sectionSegments(positions, indices, normal, constant, center, scale, epsilon) {
  return intersections(positions,indices,normal,constant,center,scale,epsilon,false).lines;
}

// Fill validation also needs the edges of triangles lying on the cutting plane.
export function sectionContours(positions, indices, normal, constant, center, scale, epsilon, transform=null, groups=null, maximumSegments=Infinity) {
  return intersections(positions,indices,normal,constant,center,scale,epsilon,true,transform,groups,maximumSegments);
}

function intersections(positions, indices, normal, constant, center, scale, epsilon, includeCoplanar, transform=null, groups=null, maximumSegments=Infinity) {
  const lines=[],flags=[];
  const emit=(a,b,flat=0)=>{
    if(Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])<=epsilon)return;
    if(lines.length/6>=maximumSegments)throw new Error('截线数量超出显示内存限制，未截断或自动简化；请调整切面或手动降低网格保留比例');
    for(const p of [a,b])for(let axis=0;axis<3;axis++){
      const r=transform?.[axis],value=r?r[0]*p[0]+r[1]*p[1]+r[2]*p[2]+r[3]:p[axis];
      lines.push((value-center[axis])*scale);
    }
    if(includeCoplanar)flags.push(flat);
  };
  // A group contains original face indices, never simplified/reconstructed faces.
  for(const group of groups||[null])for(let cursor=0;cursor<(group?group.length:indices.length/3);cursor++){
    const i=3*(group?group[cursor]:cursor);
    const a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3;
    const da=normal[0]*positions[a]+normal[1]*positions[a+1]+normal[2]*positions[a+2]+constant;
    const db=normal[0]*positions[b]+normal[1]*positions[b+1]+normal[2]*positions[b+2]+constant;
    const dc=normal[0]*positions[c]+normal[1]*positions[c+1]+normal[2]*positions[c+2]+constant;
    if((da>epsilon&&db>epsilon&&dc>epsilon)||(da<-epsilon&&db<-epsilon&&dc<-epsilon))continue;
    const ids=[a,b,c],distances=[da,db,dc];
    const hit=[];
    if(includeCoplanar&&distances.every(distance=>Math.abs(distance)<=epsilon)){
      const points=ids.map(id=>[positions[id],positions[id+1],positions[id+2]]);
      for(let j=0;j<3;j++)emit(points[j],points[(j+1)%3],1);
      continue;
    }
    for(let j=0;j<3;j++){
      const a=ids[j],b=ids[(j+1)%3],da=distances[j],db=distances[(j+1)%3];
      if(Math.abs(da)<=epsilon)hit.push([positions[a],positions[a+1],positions[a+2]]);
      else if((da<0&&db>epsilon)||(da>0&&db<-epsilon)){
        const t=da/(da-db);
        hit.push([positions[a]+t*(positions[b]-positions[a]),positions[a+1]+t*(positions[b+1]-positions[a+1]),positions[a+2]+t*(positions[b+2]-positions[a+2])]);
      }
    }
    if(hit.length===2)emit(hit[0],hit[1]);
  }
  return {lines:new Float32Array(lines),coplanarFlags:new Uint8Array(flags)};
}
