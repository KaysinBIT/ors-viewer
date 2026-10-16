// Axis-aligned intersections of the displayed triangle array, without decimation.
export function meshSections(positions,indices,coordinates,center,scale,epsilon,maxSegments=2000000,candidates=null){
  const chunks=[[],[],[]],current=[new Float32Array(65532),new Float32Array(65532),new Float32Array(65532)];
  const flagChunks=[[],[],[]],flags=[new Uint8Array(10922),new Uint8Array(10922),new Uint8Array(10922)];
  const used=[0,0,0],counts=[0,0,0],coplanar=[0,0,0];
  const emit=(axis,a,b,flat=0)=>{
    if(Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])<=epsilon)return;
    if(++counts[axis]>maxSegments)throw new Error('单切面截线超过 200 万段，未截断或自动简化。请移动切面，或手动调整三角面保留比例。');
    if(used[axis]+6>current[axis].length){chunks[axis].push(current[axis]);flagChunks[axis].push(flags[axis]);current[axis]=new Float32Array(65532);flags[axis]=new Uint8Array(10922);used[axis]=0;}
    flags[axis][used[axis]/6]=flat;
    for(const p of [a,b])for(let d=0;d<3;d++)current[axis][used[axis]++]=((d===axis?coordinates[axis]:p[d])-center[d])*scale;
  };
  for(let axis=0;axis<3;axis++){
    for(const group of candidates?.[axis]??[null])for(let face=0;face<(group?group.length:indices.length/3);face++){
      const i=(group?group[face]:face)*3,a=indices[i]*3,b=indices[i+1]*3,c=indices[i+2]*3;
      const cut=coordinates[axis],da=positions[a+axis]-cut,db=positions[b+axis]-cut,dc=positions[c+axis]-cut;
      if((da>epsilon&&db>epsilon&&dc>epsilon)||(da<-epsilon&&db<-epsilon&&dc<-epsilon))continue;
      const ids=[a,b,c],dist=[da,db,dc],on=dist.map(d=>Math.abs(d)<=epsilon);
      const point=id=>[positions[id],positions[id+1],positions[id+2]];
      if(on.every(Boolean)){coplanar[axis]++;emit(axis,point(a),point(b),1);emit(axis,point(b),point(c),1);emit(axis,point(c),point(a),1);continue;}
      const hits=[];
      for(let j=0;j<3;j++){
        const k=(j+1)%3;
        if(on[j])hits.push(point(ids[j]));
        else if(!on[k]&&((dist[j]<0)!==(dist[k]<0))){
          const t=dist[j]/(dist[j]-dist[k]),p=point(ids[j]),q=point(ids[k]);hits.push(p.map((v,d)=>v+t*(q[d]-v)));
        }
      }
      if(hits.length===2)emit(axis,hits[0],hits[1]);
    }
  }
  const lines=counts.map((count,axis)=>{
    const output=new Float32Array(count*6);let offset=0;
    for(const chunk of chunks[axis]){output.set(chunk,offset);offset+=chunk.length;}
    output.set(current[axis].subarray(0,used[axis]),offset);return output;
  });
  const coplanarFlags=counts.map((count,axis)=>{const output=new Uint8Array(count);let offset=0;for(const chunk of flagChunks[axis]){output.set(chunk,offset);offset+=chunk.length;}output.set(flags[axis].subarray(0,used[axis]/6),offset);return output;});
  return {lines,counts,coplanar,coplanarFlags};
}

export function meshPlaneTransform(bounds,axis,width,height){
  const [u,v]=[[1,2],[0,2],[0,1]][axis],size=bounds[0].map((x,i)=>bounds[1][i]-x),span=Math.max(...size,1e-12);
  const su=size[u]||span*.05,sv=size[v]||span*.05;
  const loU=(bounds[0][u]+bounds[1][u]-su)/2,hiV=(bounds[0][v]+bounds[1][v]+sv)/2;
  const scale=Math.min(Math.max(1,width-32)/su,Math.max(1,height-32)/sv);
  return {u,v,scale,loU,hiV,left:(width-su*scale)/2,top:(height-sv*scale)/2,width:su*scale,height:sv*scale};
}
export function meshToScreen(t,u,v){return [t.left+(u-t.loU)*t.scale,t.top+(t.hiV-v)*t.scale];}
export function screenToMesh(t,x,y){
  if(x<t.left||x>t.left+t.width||y<t.top||y>t.top+t.height)return null;
  return [(x-t.left)/t.scale+t.loU,t.hiV-(y-t.top)/t.scale];
}
