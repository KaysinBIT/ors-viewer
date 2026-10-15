// Exact triangle/plane intersections, shared by the worker and numerical tests.
export function sectionSegments(positions, indices, normal, constant, center, scale, epsilon) {
  const lines=[];
  for(let i=0;i<indices.length;i+=3){
    const hit=[];
    for(let j=0;j<3;j++){
      const a=indices[i+j]*3,b=indices[i+(j+1)%3]*3;
      const da=normal[0]*positions[a]+normal[1]*positions[a+1]+normal[2]*positions[a+2]+constant;
      const db=normal[0]*positions[b]+normal[1]*positions[b+1]+normal[2]*positions[b+2]+constant;
      if(Math.abs(da)<=epsilon)hit.push([positions[a],positions[a+1],positions[a+2]]);
      else if((da<0&&db>epsilon)||(da>0&&db<-epsilon)){
        const t=da/(da-db);
        hit.push([positions[a]+t*(positions[b]-positions[a]),positions[a+1]+t*(positions[b+1]-positions[a+1]),positions[a+2]+t*(positions[b+2]-positions[a+2])]);
      }
    }
    if(hit.length===2&&Math.hypot(hit[0][0]-hit[1][0],hit[0][1]-hit[1][1],hit[0][2]-hit[1][2])>epsilon){
      for(const h of hit)lines.push((h[0]-center[0])*scale,(h[1]-center[1])*scale,(h[2]-center[2])*scale);
    }
  }
  return new Float32Array(lines);
}
