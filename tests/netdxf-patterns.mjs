// Compile fixtures and the production bridge with real Roslyn in managed WASM,
// then verify actual ASCII/binary DXF extraction and pattern clipping.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRoslyn } from '../src/node/index.js';
import { createNetDxf } from '../src/dxf/index.js';
import { tessellateDxfScene } from '../src/dxf/geometry.js';

const root = new URL('../', import.meta.url);
const ok = result => { assert.equal(result.success,true,JSON.stringify(result.error??result.diagnostics));return result; };
const near=(a,b,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);
const p=value=>[value.x,value.y,value.z];
const points=geometry=>Array.from({length:geometry.lines.positions.length/3},(_,i)=>Array.from({length:3},(_,j)=>geometry.lines.positions[i*3+j]+geometry.origin[j]));
const fixture=`using System; using System.IO; using netDxf; using netDxf.Entities; using netDxf.Blocks;
public static class HatchPatternsFixture {
 static HatchBoundaryPath Ring(double a,double b,double c,double d) => new HatchBoundaryPath(new EntityObject[]{new Polyline2D(new[]{new Vector2(a,b),new Vector2(c,b),new Vector2(c,d),new Vector2(a,d)},true)});
 public static string Create(int kind,bool binary) {
  var pattern=new HatchPattern("BROWSER_LINES");var line=new HatchPatternLineDefinition{Origin=new Vector2(0,0.5),Delta=new Vector2(0,1)};pattern.LineDefinitions.Add(line);
  var loops=new[]{Ring(0,0,10,10),Ring(2,2,8,8),Ring(4,4,6,6)};
  if(kind<=2)typeof(HatchPattern).GetProperty("Style").SetValue(pattern,(HatchStyle)kind);
  if(kind==3){line.Origin=Vector2.Zero;line.Delta=new Vector2(0.5,1);line.DashPattern.AddRange(new[]{2.0,-1.0});loops=new[]{Ring(-10,-2,10,2)};}
  if(kind==4){pattern.Origin=new Vector2(3,-2);pattern.Angle=30;pattern.Scale=2;line.Origin=new Vector2(1,-2);line.Angle=15;line.Delta=new Vector2(1,2);line.DashPattern.AddRange(new[]{1.0,-0.5});loops=new[]{Ring(-10,-10,10,10),Ring(-2,-2,2,2)};}
  if(kind==5){pattern=HatchPattern.Dots;pattern.Scale=16;loops=new[]{Ring(0,0,4,4),Ring(1.5,1.5,2.5,2.5)};}
  if(kind==6){pattern=HatchPattern.Net;pattern.Scale=16;loops=new[]{Ring(0,0,10,10)};}
  if(kind==7){line.Delta=Vector2.Zero;}
  var hatch=new Hatch(pattern,loops,false);var doc=new DxfDocument();
  if(kind==4){hatch.Normal=new Vector3(0,1,0);hatch.Elevation=7;var block=new Block("PatternBlock");block.Entities.Add(hatch);doc.Entities.Add(new Insert(block,new Vector3(10,20,30)){Scale=new Vector3(2,3,4),Rotation=90});}
  else doc.Entities.Add(hatch);
  using var stream=new MemoryStream();if(!doc.Save(stream,binary))throw new Exception("Save failed");return Convert.ToBase64String(stream.ToArray());
 }
}`;
let compiler,session;
const checks=[];
try {
 compiler=await createRoslyn({timeoutMs:180000,startupTimeoutMs:90000});
 const manifest=JSON.parse(await readFile(new URL('dist/netdxf/manifest.json',root)));
 await compiler.addDll(manifest.library.file,await readFile(new URL('dist/netdxf/'+manifest.library.file,root)));
 const bridge=ok(await compiler.compile(await readFile(new URL('src/dxf/NetDxfBridge.cs',root),'utf8'),{assemblyName:'RoslynWeb.NetDxfBridge',outputKind:'library',optimization:'release',emitPdb:false}));
 session=await createNetDxf({compiler,verify:false,loadAsset:url=>url.pathname.endsWith('/'+manifest.bridge.file)?bridge.pe:readFile(url)});
 const assembly=ok(await compiler.compile(fixture,{assemblyName:'HatchPatternsFixture',outputKind:'library',optimization:'release',emitPdb:false}));
 const names=['Normal islands','Outer islands','Ignore islands','negative-coordinate staggered dashes','rotated/scaled/origin/OCS/nonuniform INSERT','predefined dots','predefined crossed grid','degenerate family rejection'];
 for(let kind=0;kind<names.length;kind++)for(const binary of [false,true]) {
  const encoded=ok(await compiler.invoke(assembly.assemblyId,'HatchPatternsFixture','Create',[kind,binary])).result;
  const document=await session.load(Uint8Array.from(atob(encoded),v=>v.charCodeAt(0)));
  try {
   assert.deepEqual(document.issues,[]);assert.equal(document.scene.entities.length,1);
   const hatch=document.scene.entities[0];assert.equal(hatch.type,'HATCH');assert.ok(hatch.pattern.lines.length);
   if(kind===7){assert.throws(()=>tessellateDxfScene(document.scene,{strict:true}),{code:'DXF_INVALID_HATCH_PATTERN'});checks.push({name:names[kind],binary,passed:true});continue;}
   const geometry=tessellateDxfScene(document.scene,{strict:true,hatchDotSize:0.1});assert.deepEqual(geometry.issues,[]);
   const vertices=points(geometry);
   if(kind<=2) {
    const y=5.5,range=[];for(let i=0;i<vertices.length;i+=2)if(Math.abs(vertices[i][1]-y)<1e-7)range.push([vertices[i][0],vertices[i+1][0]]);
    assert.deepEqual(range,kind===0?[[0,2],[4,6],[8,10]]:kind===1?[[0,2],[8,10]]:[[0,10]]);
   } else if(kind===3){assert.ok(geometry.counts.lineSegments>20);const ranges=[];for(let i=0;i<vertices.length;i+=2)if(Math.abs(vertices[i][1])<1e-7)ranges.push([vertices[i][0],vertices[i+1][0]]);assert.deepEqual(ranges,[[-9,-7],[-6,-4],[-3,-1],[0,2],[3,5],[6,8],[9,10]]);}
   else if(kind===4){
    const definition=hatch.pattern.lines[0],cos=Math.cos(Math.PI/6),sin=Math.sin(Math.PI/6);
    const origin=[-11,20-2*(3+2*(cos+2*sin)),30+4*(-2+2*(sin-2*cos))];
    p(definition.origin).forEach((v,i)=>near(v,origin[i]));
    p(definition.direction).forEach((v,i)=>near(v,[0,-Math.SQRT2,2*Math.SQRT2][i]));
    p(definition.offset).forEach((v,i)=>near(v,[0,2*Math.SQRT2,12*Math.SQRT2][i]));
    assert.deepEqual(definition.dashes,[2,-1]);assert.ok(geometry.counts.lineSegments>20);
    for(let i=0;i<vertices.length;i+=2){const a=vertices[i],b=vertices[i+1];near(a[0],-11);near(b[0],-11);const x=(20-(a[1]+b[1])/2)/2,y=((a[2]+b[2])/2-30)/4;assert.ok(x>=-10-1e-6&&x<=10+1e-6&&y>=-10-1e-6&&y<=10+1e-6);assert.ok(!(x>-2+1e-6&&x<2-1e-6&&y>-2+1e-6&&y<2-1e-6));}
   }else if(kind===5){assert.equal(geometry.counts.lineSegments,0);assert.ok(geometry.counts.triangles>20);}
   else if(kind===6){assert.equal(hatch.pattern.lines.length,2);assert.ok(geometry.counts.lineSegments>=10);}
   const reloaded=await session.load(await document.export({binary:!binary}));
   try{assert.deepEqual(reloaded.issues,[]);const again=tessellateDxfScene(reloaded.scene,{strict:true,hatchDotSize:0.1});assert.equal(again.counts.lineSegments,geometry.counts.lineSegments);assert.equal(again.counts.triangles,geometry.counts.triangles);const actual=points(again);actual.forEach((point,i)=>point.forEach((v,j)=>near(v,vertices[i][j],2e-5)));}finally{await reloaded.dispose();}
   checks.push({name:names[kind],binary,passed:true,lineSegments:geometry.counts.lineSegments,triangles:geometry.counts.triangles});
  }finally{await document.dispose();}
  console.log('PASS',names[kind],binary?'binary':'ASCII');
 }
 for(const name of ['sample.dxf','sample-binary.dxf']) {
  const document=await session.load(await readFile(new URL('vendor/netDxf/fixtures/'+name,root)));
  try{
   const hatches=document.scene.entities.filter(entity=>entity.pattern);assert.ok(hatches.length>0);
   const geometry=tessellateDxfScene({version:1,entities:hatches},{strict:true});assert.ok(geometry.counts.lineSegments>0);assert.deepEqual(geometry.issues,[]);
   checks.push({name:'Pinned upstream '+name,passed:true,hatches:hatches.length,lineSegments:geometry.counts.lineSegments,triangles:geometry.counts.triangles});console.log('PASS','Pinned upstream',name);
  }finally{await document.dispose();}
 }
 await writeFile(new URL('docs/netdxf-pattern-verification.json',root),JSON.stringify({testedAt:new Date().toISOString(),managedWebAssembly:true,checks,passed:checks.length},null,2)+'\n');
}finally{await session?.dispose();await compiler?.close();console.log(`${checks.length}/18 actual managed pattern checks passed.`);}
