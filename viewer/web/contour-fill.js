import {ShapeUtils,Vector2} from './vendor/three.core.js';

const axes=[[1,2],[0,2],[0,1]];
const empty=(status,message)=>({status,message,positions:new Float32Array(),indices:new Uint32Array(),offsets:new Uint32Array(),boundary:new Float32Array(),area:0,loops:0,holes:0});
const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function contains(point,ring,points){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const a=points[ring[i]],b=points[ring[j]];
    if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
function intersects(a,b,c,d,tol){
  const ab=Math.hypot(b[0]-a[0],b[1]-a[1]),cd=Math.hypot(d[0]-c[0],d[1]-c[1]);
  const x=cross(a,b,c),y=cross(a,b,d),z=cross(c,d,a),w=cross(c,d,b);
  if(((x>tol*ab&&y<-tol*ab)||(x<-tol*ab&&y>tol*ab))&&((z>tol*cd&&w<-tol*cd)||(z<-tol*cd&&w>tol*cd)))return true;
  const on=(p,u,v,area,length)=>Math.abs(area)<=tol*length&&p[0]>=Math.min(u[0],v[0])-tol&&p[0]<=Math.max(u[0],v[0])+tol&&p[1]>=Math.min(u[1],v[1])-tol&&p[1]<=Math.max(u[1],v[1])+tol;
  return on(c,a,b,x,ab)||on(d,a,b,y,ab)||on(a,c,d,z,cd)||on(b,c,d,w,cd);
}

/** Validate local section contours; never invent edges across an open boundary. */
export function contourFill(lines,axis,coplanarFlags=new Uint8Array(),limits={}){
  if(!lines.length)return empty('empty','此处无截线');
  const maxSegments=limits.maxSegments??200000,maxWork=limits.maxWork??2000000;
  if(lines.length/6>maxSegments)return empty('complex','轮廓过于复杂，保留完整截线');
  const [u,v]=axes[axis];let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(let i=0;i<lines.length;i+=3){const x=lines[i+u],y=lines[i+v];if(!Number.isFinite(x)||!Number.isFinite(y))return empty('invalid','轮廓坐标无效');minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
  const span=Math.max(maxX-minX,maxY-minY,1e-12),tol=Math.max(1e-7,span*1e-7);
  const points=[],buckets=new Map(),edgeMap=new Map();
  const vertex=(x,y)=>{
    const ix=Math.floor((x-minX)/tol),iy=Math.floor((y-minY)/tol);let best=-1,bestDistance=Infinity;
    for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const id of buckets.get(`${ix+dx},${iy+dy}`)||[]){
      const p=points[id],distance=(p[0]-x)**2+(p[1]-y)**2;if(distance<=tol*tol&&distance<bestDistance){best=id;bestDistance=distance;}
    }
    if(best>=0)return best;const id=points.length;points.push([x,y]);const key=`${ix},${iy}`;
    if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(id);return id;
  };
  for(let i=0;i<lines.length;i+=6){
    const a=vertex(lines[i+u],lines[i+v]),b=vertex(lines[i+3+u],lines[i+3+v]);if(a===b)continue;
    const key=a<b?`${a},${b}`:`${b},${a}`;let edge=edgeMap.get(key);
    if(!edge){edge={a,b,flat:0,regular:0};edgeMap.set(key,edge);}if(coplanarFlags[i/6])edge.flat++;else edge.regular++;
  }
  const edges=[],adj=points.map(()=>[]);
  for(const edge of edgeMap.values()){
    if(edge.flat>2||(edge.flat===2&&edge.regular))return empty('ambiguous','共面轮廓重叠，保留截线');
    if(edge.flat===2)continue; // Shared interior edge of a coplanar triangle patch.
    const id=edges.length;edges.push(edge);adj[edge.a].push(id);adj[edge.b].push(id);
  }
  if(!edges.length)return empty('degenerate','轮廓退化，保留截线');
  if(adj.some(a=>a.length&&a.length!==2))return empty('open','轮廓未闭合或分叉，保留截线');
  // A closed graph can still self-intersect. Validate spatially overlapping edges.
  const grid=new Map(),resolution=Math.max(8,Math.min(512,Math.ceil(Math.sqrt(edges.length)))),cell=span/resolution;
  let work=0,references=0;
  for(let i=0;i<edges.length;i++){
    const e=edges[i],a=points[e.a],b=points[e.b],seen=new Set();
    const x0=Math.floor((Math.min(a[0],b[0])-minX-tol)/cell),x1=Math.floor((Math.max(a[0],b[0])-minX+tol)/cell);
    const y0=Math.floor((Math.min(a[1],b[1])-minY-tol)/cell),y1=Math.floor((Math.max(a[1],b[1])-minY+tol)/cell);
    for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){
      if(++references>maxWork)return empty('complex','轮廓验证超出计算限额，保留截线');
      const key=`${x},${y}`,list=grid.get(key)||[];
      for(const j of list){
        if(seen.has(j))continue;seen.add(j);if(++work>maxWork)return empty('complex','轮廓验证超出计算限额，保留截线');
        const f=edges[j],c=points[f.a],d=points[f.b];
        const shared=e.a===f.a||e.a===f.b?e.a:e.b===f.a||e.b===f.b?e.b:-1;
        if(shared>=0){
          const p=points[shared],q=points[e.a===shared?e.b:e.a],r=points[f.a===shared?f.b:f.a];
          if(Math.abs(cross(p,q,r))<=tol*Math.hypot(q[0]-p[0],q[1]-p[1])&&(q[0]-p[0])*(r[0]-p[0])+(q[1]-p[1])*(r[1]-p[1])>0)return empty('intersecting','轮廓重叠，保留截线');
        }else if(intersects(a,b,c,d,tol))return empty('intersecting','轮廓交叉或相切，保留截线');
      }
      list.push(i);grid.set(key,list);
    }
  }
  const visited=new Uint8Array(edges.length),rings=[];
  for(let start=0;start<edges.length;start++){
    if(visited[start])continue;const ids=[];let current=edges[start].a,edgeId=start;
    while(!visited[edgeId]){visited[edgeId]=1;ids.push(current);const e=edges[edgeId];current=e.a===current?e.b:e.a;edgeId=adj[current].find(id=>!visited[id])??edgeId;}
    if(current!==ids[0]||ids.length<3)return empty('open','轮廓未闭合，保留截线');
    let area=0,loX=Infinity,loY=Infinity,hiX=-Infinity,hiY=-Infinity;
    for(let i=0;i<ids.length;i++){const p=points[ids[i]],q=points[ids[(i+1)%ids.length]];area+=p[0]*q[1]-q[0]*p[1];loX=Math.min(loX,p[0]);hiX=Math.max(hiX,p[0]);loY=Math.min(loY,p[1]);hiY=Math.max(hiY,p[1]);}
    area=Math.abs(area/2);if(area<=tol*tol)return empty('degenerate','轮廓面积退化，保留截线');
    rings.push({ids,area,box:[loX,loY,hiX,hiY],parent:-1,depth:0});
  }
  rings.sort((a,b)=>b.area-a.area);let containmentWork=0;
  for(let i=0;i<rings.length;i++){
    const r=rings[i],p=points[r.ids[0]];
    for(let j=i-1;j>=0;j--){const candidate=rings[j],b=candidate.box;
      if(++containmentWork>maxWork)return empty('complex','轮廓嵌套验证超出计算限额，保留截线');
      if(p[0]<b[0]||p[0]>b[2]||p[1]<b[1]||p[1]>b[3])continue;
      containmentWork+=candidate.ids.length;if(containmentWork>maxWork)return empty('complex','轮廓嵌套验证超出计算限额，保留截线');
      if(contains(p,candidate.ids,points)){r.parent=j;r.depth=candidate.depth+1;break;}
    }
  }
  const offsets=new Uint32Array(rings.length+1);rings.forEach((r,i)=>offsets[i+1]=offsets[i]+r.ids.length);
  const positions=new Float32Array(offsets.at(-1)*3),boundary=new Float32Array(offsets.at(-1)*6),triangles=[];
  rings.forEach((r,i)=>r.ids.forEach((id,j)=>{const at=(offsets[i]+j)*3;positions[at+axis]=lines[axis];positions[at+u]=points[id][0];positions[at+v]=points[id][1];}));
  let expectedArea=0,actualArea=0;
  try{
    for(let i=0;i<rings.length;i++){
      const r=rings[i];expectedArea+=r.area*(r.depth%2?-1:1);if(r.depth%2)continue;
      const holes=rings.map((h,j)=>h.parent===i?j:-1).filter(j=>j>=0),order=[i,...holes],mapping=order.flatMap(j=>rings[j].ids.map((_,k)=>offsets[j]+k));
      const polygon=j=>rings[j].ids.map(id=>new Vector2(...points[id]));
      for(const face of ShapeUtils.triangulateShape(polygon(i),holes.map(polygon)))triangles.push(...face.map(k=>mapping[k]));
    }
    for(let i=0;i<triangles.length;i+=3){const p=triangles.slice(i,i+3).map(k=>[positions[k*3+u],positions[k*3+v]]);actualArea+=Math.abs(cross(...p))/2;}
  }catch{return empty('invalid','轮廓三角化失败，保留截线');}
  if(!triangles.length||Math.abs(actualArea-expectedArea)>Math.max(expectedArea*1e-5,tol*tol*positions.length))return empty('invalid','填充面积校验不一致，保留截线');
  let cursor=0;
  rings.forEach((r,i)=>r.ids.forEach((_,j)=>{for(const k of [offsets[i]+j,offsets[i]+(j+1)%r.ids.length])for(let d=0;d<3;d++)boundary[cursor++]=positions[k*3+d];}));
  return {status:'filled',message:'闭合轮廓已填充',positions,indices:new Uint32Array(triangles),offsets,boundary,area:expectedArea,loops:rings.length,holes:rings.filter(r=>r.depth%2).length};
}
