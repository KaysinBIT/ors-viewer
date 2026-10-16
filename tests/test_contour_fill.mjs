import test from 'node:test';
import assert from 'node:assert/strict';
import {contourFill} from '../viewer/web/contour-fill.js';
import {meshSections} from '../viewer/web/mesh-sections-math.js';

const square=(lo,hi)=>[[lo,lo],[hi,lo],[hi,hi],[lo,hi]];
function segments(rings,axis=2){const [u,v]=[[1,2],[0,2],[0,1]][axis],output=[];for(const ring of rings)for(let i=0;i<ring.length;i++)for(const p of [ring[i],ring[(i+1)%ring.length]]){const point=[0,0,0];point[axis]=.25;point[u]=p[0];point[v]=p[1];output.push(...point);}return new Float32Array(output);}
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-5,`${a} != ${b}`);
function triangleCovers(fill,x,y,axis=2){
  const [u,v]=[[1,2],[0,2],[0,1]][axis],cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  for(let i=0;i<fill.indices.length;i+=3){const p=Array.from(fill.indices.slice(i,i+3),j=>[fill.positions[j*3+u],fill.positions[j*3+v]]),d=p.map((a,j)=>cross(a,p[(j+1)%3],[x,y]));if(d.every(n=>n>=-1e-8)||d.every(n=>n<=1e-8))return true;}return false;
}
test('closed square fills all axes and preserves plane coordinate',()=>{
  for(let axis=0;axis<3;axis++){const f=contourFill(segments([square(-1,1)],axis),axis);assert.equal(f.status,'filled');near(f.area,4);assert.equal(f.indices.length,6);for(let i=axis;i<f.positions.length;i+=3)assert.equal(f.positions[i],.25);}
});
test('nested hole is not filled regardless of ring orientation',()=>{
  for(const reverse of [false,true])for(const reverseOuter of [false,true]){const inner=square(-.5,.5),outer=square(-1,1);if(reverse)inner.reverse();if(reverseOuter)outer.reverse();const f=contourFill(segments([outer,inner]),2);assert.equal(f.status,'filled');assert.equal(f.holes,1);near(f.area,3);assert.equal(triangleCovers(f,0,0),false);assert.equal(triangleCovers(f,.8,.2),true);}
});
test('disjoint islands and a nested island inside a hole retain even-odd interiors',()=>{
  const distant=square(4,5),f=contourFill(segments([square(-2,2),square(-1,1),square(-.25,.25),distant]),2);
  assert.equal(f.status,'filled');assert.equal(f.loops,4);assert.equal(f.holes,1);near(f.area,13.25);assert.equal(triangleCovers(f,0,0),true);assert.equal(triangleCovers(f,.5,.5),false);assert.equal(triangleCovers(f,4.5,4.5),true);
});
test('duplicate regular segments do not erase the boundary',()=>{
  const lines=segments([square(-1,1)]),doubled=new Float32Array([...lines,...lines]);const before=doubled.slice();
  const f=contourFill(doubled,2);assert.equal(f.status,'filled');near(f.area,4);assert.deepEqual(doubled,before);
});
test('open boundaries and branched contours remain unfilled',()=>{
  const closed=segments([square(-1,1)]),open=closed.slice(0,-6);assert.equal(contourFill(open,2).status,'open');
  const branch=new Float32Array([...closed,-1,-1,.25,0,0,.25]);assert.equal(contourFill(branch,2).status,'open');
});
test('an open possible hole prevents unsafe filling of an otherwise closed outer ring',()=>{
  const lines=new Float32Array([...segments([square(-2,2)]),...segments([square(-1,1)]).slice(0,-6)]);const f=contourFill(lines,2);assert.equal(f.status,'open');assert.equal(f.indices.length,0);
});
test('self-intersections, overlapping rings and tangent rings remain unfilled',()=>{
  for(const rings of [[[[0,0],[1,1],[0,1],[1,0]]],[square(-1,1),square(0,2)],[square(-1,0),square(0,1)]])assert.notEqual(contourFill(segments(rings),2).status,'filled');
});
test('coplanar triangulated patches fill the outer boundary without the shared diagonal',()=>{
  const vertices=new Float32Array([0,0,0,1,0,0,1,1,0,0,1,0]),faces=new Uint32Array([0,1,2,0,2,3]);
  const section=meshSections(vertices,faces,[.5,.5,0],[0,0,0],1,1e-10),f=contourFill(section.lines[2],2,section.coplanarFlags[2]);
  assert.equal(f.status,'filled');near(f.area,1);assert.equal(f.boundary.length,24);assert.equal(f.indices.length,6);
});
test('coplanar boundary plus side-face intersections does not duplicate the filled area',()=>{
  const vertices=new Float32Array([0,0,0,1,0,0,0,1,0,0,0,1]),faces=new Uint32Array([0,2,1,0,1,3,1,2,3,2,0,3]);
  const section=meshSections(vertices,faces,[0,0,0],[0,0,0],1,1e-10);
  for(let axis=0;axis<3;axis++){const f=contourFill(section.lines[axis],axis,section.coplanarFlags[axis]);assert.equal(f.status,'filled');near(f.area,.5);}
});
test('bounded topology work falls back to intact lines rather than partial fill',()=>{
  const lines=segments([square(-1,1)]),before=lines.slice();
  assert.equal(contourFill(lines,2,new Uint8Array(),{maxSegments:2}).status,'complex');assert.equal(contourFill(lines,2,new Uint8Array(),{maxWork:1}).status,'complex');assert.deepEqual(lines,before);
});
test('empty and zero-area contours do not create caps',()=>{
  assert.equal(contourFill(new Float32Array(),2).status,'empty');assert.notEqual(contourFill(segments([[[0,0],[1,0],[2,0]]]),2).status,'filled');
});
