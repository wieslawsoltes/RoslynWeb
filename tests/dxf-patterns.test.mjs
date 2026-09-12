import test from 'node:test';
import assert from 'node:assert/strict';
import { tessellateDxfPattern } from '../src/dxf/hatch.js';
import { tessellateDxfScene } from '../src/dxf/geometry.js';

const ring = (x0,y0,x1,y1) => [[x0,y0,0],[x1,y0,0],[x1,y1,0],[x0,y1,0]];
const line = (extra={}) => ({ origin:[0,0,0], direction:[1,0,0], offset:[0,1,0], ...extra });
const pattern = (...lines) => ({lines});
const near = (a,b) => assert.ok(Math.abs(a-b)<1e-8, `${a} != ${b}`);
const ranges = (result,y) => result.lines.filter((p,i) => i%2===0 && Math.abs(p[1]-y)<1e-8).map(p => { const index=result.lines.indexOf(p); return [p[0],result.lines[index+1][0]]; });
const length = result => result.lines.reduce((sum,p,i,all) => i%2 ? sum+Math.hypot(...p.map((v,j)=>v-all[i-1][j])):sum,0);

test('continuous hatch lines clip to both sides of a hole and remain unfilled', () => {
  const result=tessellateDxfPattern([ring(0,0,10,10),ring(3,3,7,7)],pattern(line({origin:[0,0.5,0]})));
  assert.deepEqual(ranges(result,4.5),[[0,3],[7,10]]); assert.deepEqual(ranges(result,1.5),[[0,10]]);
  assert.equal(result.lines.length,28); assert.equal(result.triangles.length,0); near(length(result),84);
});
for(const [style,expected] of [['Normal',[[0,2],[4,6],[8,10]]],['Outer',[[0,2],[8,10]]],['Ignore',[[0,10]]]]) test(`pattern ${style} island style matches filled topology`,()=>{
  const loops=[ring(4,4,6,6).reverse(),ring(0,0,10,10).reverse(),ring(2,2,8,8)];
  assert.deepEqual(ranges(tessellateDxfPattern(loops,pattern(line()),{style}),5),expected);
});
test('negative coordinate dash phase repeats from the absolute line origin',()=>{
  const result=tessellateDxfPattern([ring(-10,-0.5,10,0.5)],pattern(line({dashes:[2,-1]})));
  assert.deepEqual(ranges(result,0),[[-9,-7],[-6,-4],[-3,-1],[0,2],[3,5],[6,8],[9,10]]);
});
test('along-line offsets stagger dash phase for positive and negative family indices',()=>{
  const result=tessellateDxfPattern([ring(-5,-1.5,5,1.5)],pattern(line({offset:[0.5,1,0],dashes:[1,-1]})));
  assert.deepEqual(ranges(result,-1),[[-4.5,-3.5],[-2.5,-1.5],[-0.5,0.5],[1.5,2.5],[3.5,4.5]]);
  assert.deepEqual(ranges(result,1),[[-5,-4.5],[-3.5,-2.5],[-1.5,-0.5],[0.5,1.5],[2.5,3.5],[4.5,5]]);
});
test('dash cycles retain phase across separate components and hole intervals',()=>{
  const result=tessellateDxfPattern([ring(-8,-0.5,-2,0.5),ring(2,-0.5,8,0.5)],pattern(line({dashes:[2,-1]})));
  assert.deepEqual(ranges(result,0),[[-8,-7],[-6,-4],[-3,-2],[3,5],[6,8]]);
});
test('a reversed perpendicular family offset produces the same geometric coverage',()=>{
  const loops=[ring(-3,-3,3,3)];
  const a=tessellateDxfPattern(loops,pattern(line({offset:[0.5,1,0],dashes:[1,-1]})));
  const b=tessellateDxfPattern(loops,pattern(line({offset:[-0.5,-1,0],dashes:[1,-1]})));
  const sorted=value=>value.lines.map(p=>p.map(v=>+v.toFixed(8))).sort((p,q)=>p[1]-q[1]||p[0]-q[0]);
  assert.deepEqual(sorted(a),sorted(b));
});
test('affine world line families preserve tilted planes, shear, reflection and nonuniform scale',()=>{
  const transform=([x,y,z])=>[1e9+2*x+y,100-3*y,7+4*x+2*y+z];
  const direction=[2,0,4], offset=[1,-3,2];
  const result=tessellateDxfPattern([ring(0,0,10,10).map(transform),ring(3,3,7,7).map(transform)],pattern(line({origin:transform([0,0.5,0]),direction,offset,perpendicular:offset})));
  assert.equal(result.lines.length,28);
  for(const p of result.lines) {const y=(100-p[1])/3,x=(p[0]-1e9-y)/2; near(p[2],7+4*x+2*y); assert.ok(x>=-1e-7&&x<=10+1e-7);}
  near(length(result),84*Math.sqrt(20));
});
test('two line families independently clip diagonal and horizontal hatching',()=>{
  const result=tessellateDxfPattern([ring(-2,-2,2,2)],pattern(line(),line({direction:[1,1,0],offset:[-1,1,0]})));
  assert.ok(result.lines.some((p,i)=>i%2===0&&result.lines[i+1][1]!==p[1]));
  for(const p of result.lines)assert.ok(p[0]>=-2-1e-12&&p[0]<=2+1e-12&&p[1]>=-2-1e-12&&p[1]<=2+1e-12);
});
test('zero-length dashes produce visible square dots clipped against holes and the outer boundary',()=>{
  const result=tessellateDxfPattern([ring(0,0,4,4),ring(1.5,1.5,2.5,2.5)],pattern(line({dashes:[0,-1]})),{hatchDotSize:0.2});
  assert.equal(result.lines.length,0);assert.ok(result.triangles.length>0);
  for(const p of result.triangles) {assert.ok(p[0]>=-1e-12&&p[0]<=4+1e-12&&p[1]>=-1e-12&&p[1]<=4+1e-12);assert.ok(!(p[0]>1.5+1e-12&&p[0]<2.5-1e-12&&p[1]>1.5+1e-12&&p[1]<2.5-1e-12));}
  let area=0;for(let i=0;i<result.triangles.length;i+=3){const[a,b,c]=result.triangles.slice(i,i+3);area+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;}
  near(area,0.6);
});
test('all-gap dash cycles produce no drawing',()=>{
  const result=tessellateDxfPattern([ring(-2,-2,2,2)],pattern(line({dashes:[-1,-2]})));
  assert.deepEqual(result,{lines:[],triangles:[]});
});
for(const [name,definition] of [['zero spacing',line({offset:[1,0,0]})],['zero direction',line({direction:[0,0,0]})],['all dots without a period',line({dashes:[0,0]})],['nonfinite dash',line({dashes:[Infinity]})],['noncoplanar origin',line({origin:[0,0,1]})],['noncoplanar distant origin',line({origin:[1e12,0,1]})],['noncoplanar direction',line({direction:[1,0,1]})]])test(`invalid pattern: ${name}`,()=>{
  assert.throws(()=>tessellateDxfPattern([ring(0,0,10,10)],pattern(definition)),{code:'DXF_INVALID_HATCH_PATTERN'});
});
test('resource budgets bound dense line families, tiny dashes and dot clipping',()=>{
  const loops=[ring(0,0,10,10)];
  assert.throws(()=>tessellateDxfPattern(loops,pattern(line({offset:[0,1e-8,0]}))),{code:'DXF_HATCH_LINE_LIMIT'});
  assert.throws(()=>tessellateDxfPattern(loops,pattern(line({dashes:[1e-10,-1e-10]}))),{code:'DXF_HATCH_WORK_LIMIT'});
  assert.throws(()=>tessellateDxfPattern(loops,pattern(line()),{maxVertices:2}),{code:'DXF_VERTEX_LIMIT'});
  assert.throws(()=>tessellateDxfPattern(loops,pattern(line({dashes:[0,-0.1]})),{maxHatchWork:500}),{code:'DXF_HATCH_WORK_LIMIT'});
});
test('scene pattern budgets are shared across entities and remain hard in nonstrict mode',()=>{
  const entity={type:'HATCH',loops:[ring(0,0,10,10)],pattern:pattern(line())};
  assert.throws(()=>tessellateDxfScene({version:1,entities:[entity,entity]},{maxHatchLines:15}),{code:'DXF_HATCH_LINE_LIMIT'});
  const geometry=tessellateDxfScene({version:1,entities:[{...entity,pattern:pattern(line({offset:[0,0,0]}))},{type:'LINE',start:[0,0],end:[1,1]}]});
  assert.equal(geometry.issues[0].code,'DXF_INVALID_HATCH_PATTERN');assert.equal(geometry.counts.lineSegments,1);
});
test('pattern line/dot geometry uses inherited visibility and source draw order',()=>{
  const geometry=tessellateDxfScene({version:1,entities:[{type:'HATCH',layer:'Fill',visibilityLayers:['Insert','Fill'],loops:[ring(0,0,4,4)],pattern:pattern(line({dashes:[1,-1,0,-1]}))}]},{strict:true});
  assert.ok(geometry.counts.lineSegments>0);assert.ok(geometry.counts.triangles>0);
  assert.deepEqual(geometry.layers[0].visibilityLayers,['Fill','Insert']);
  assert.equal(geometry.draws.length,2);
});
