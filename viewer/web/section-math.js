// Exact triangle/plane intersections, shared by the worker and numerical tests.
export function sectionSegments(positions, indices, normal, constant, center, scale, epsilon) {
  return intersections(positions,indices,normal,constant,center,scale,epsilon,false).lines;
}

// Fill validation also needs the edges of triangles lying on the cutting plane.
export function sectionContours(positions, indices, normal, constant, center, scale, epsilon) {
  return intersections(positions,indices,normal,constant,center,scale,epsilon,true);
}

function intersections(positions, indices, normal, constant, center, scale, epsilon, includeCoplanar) {
  const lines=[],flags=[];
  const emit=(a,b,flat=0)=>{
    if(Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])<=epsilon)return;
    for(const p of [a,b])lines.push((p[0]-center[0])*scale,(p[1]-center[1])*scale,(p[2]-center[2])*scale);
    if(includeCoplanar)flags.push(flat);
  };
  for(let i=0;i<indices.length;i+=3){
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
