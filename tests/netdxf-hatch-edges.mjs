// Curved hatch boundaries created by the actual pinned netDxf library, saved as
// DXF, and extracted by the current bridge compiled in the .NET WASM runtime.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRoslyn } from '../src/node/index.js';
import { createNetDxf } from '../src/dxf/index.js';
import { tessellateDxfScene } from '../src/dxf/geometry.js';
import { triangulateDxfLoops } from '../src/dxf/polygon.js';

const root = new URL('../', import.meta.url);
const success = result => { assert.equal(result.success, true, JSON.stringify(result.error ?? result.diagnostics)); return result; };
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
const point = value => [value.x, value.y, value.z];
const area = vertices => {
  let result = 0;
  for (let i = 0; i < vertices.length; i += 3) {
    const [a, b, c] = vertices.slice(i, i + 3), u = b.map((v, j) => v - a[j]), v = c.map((x, j) => x - a[j]);
    result += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return result;
};
const contains = (vertices, [x, y], project = p => p) => {
  for (let i = 0; i < vertices.length; i += 3) {
    const p = vertices.slice(i, i + 3).map(project);
    const signs = p.map((a, j) => {
      const b = p[(j + 1) % 3], first = (b[0] - a[0]) * (y - a[1]), second = (b[1] - a[1]) * (x - a[0]);
      return { value: first - second, tolerance: 32 * Number.EPSILON * (Math.abs(first) + Math.abs(second)) };
    });
    if (signs.every(v => v.value >= -v.tolerance) || signs.every(v => v.value <= v.tolerance)) return true;
  }
  return false;
};
const radians = angle => angle * Math.PI / 180;
const segmentArea = (a, b, start, end, count) => {
  const parameter = angle => Math.atan2(Math.sin(radians(angle)) / b, Math.cos(radians(angle)) / a);
  let sweep = parameter(end) - parameter(start); if (sweep < 0) sweep += Math.PI * 2;
  return a * b / 2 * (count * Math.sin(sweep / count) - Math.sin(sweep));
};
const circleArea = (radius, count) => count * Math.sin(2 * Math.PI / count) * radius * radius / 2;
const fixtureSource = `using System; using System.IO; using netDxf; using netDxf.Entities; using netDxf.Blocks;
public static class HatchEdgesFixture {
 static Vector2 At(double a,double b,double angle,double rotation=0) {
  double t=angle*Math.PI/180, r=a*b/Math.Sqrt(b*b*Math.Cos(t)*Math.Cos(t)+a*a*Math.Sin(t)*Math.Sin(t));
  double x=r*Math.Cos(t),y=r*Math.Sin(t),q=rotation*Math.PI/180;
  return new Vector2(100+x*Math.Cos(q)-y*Math.Sin(q),200+x*Math.Sin(q)+y*Math.Cos(q));
 }
 static HatchBoundaryPath Square() { return new HatchBoundaryPath(new EntityObject[] { new Polyline2D(new[]{new Vector2(80,180),new Vector2(120,180),new Vector2(120,220),new Vector2(80,220)},true) }); }
 static HatchBoundaryPath Segment(bool ellipse,bool ccw) {
  double start=ccw?350:20,end=ccw?80:130;
  double a=ellipse?7:5,b=ellipse?3:5,rotation=ellipse?37:0;
  var first=At(a,b,ccw?start:-start,rotation); var last=At(a,b,ccw?end:-end,rotation);
  HatchBoundaryPath.Edge curve=ellipse ? (HatchBoundaryPath.Edge)new HatchBoundaryPath.Ellipse {Center=new Vector2(100,200),EndMajorAxis=new Vector2(a*Math.Cos(rotation*Math.PI/180),a*Math.Sin(rotation*Math.PI/180)),MinorRatio=b/a,StartAngle=start,EndAngle=end,IsCounterclockwise=ccw}
   : new HatchBoundaryPath.Arc {Center=new Vector2(100,200),Radius=a,StartAngle=start,EndAngle=end,IsCounterclockwise=ccw};
  // Put the chord first and reverse its orientation; extraction must join by
  // endpoints, independently of edge order or each converted entity's winding.
  return new HatchBoundaryPath(new HatchBoundaryPath.Edge[]{new HatchBoundaryPath.Line {Start=first,End=last},curve});
 }
 public static string Create(int kind,bool binary) {
  Hatch hatch;
  if(kind<=1) {
   EntityObject hole=kind==0?(EntityObject)new Circle(new Vector2(100,200),8):new Ellipse(new Vector3(100,200,0),14,6){Rotation=37};
   hatch=new Hatch(HatchPattern.Solid,new[]{Square(),new HatchBoundaryPath(new[]{hole})},false);
  } else if(kind<=5) hatch=new Hatch(HatchPattern.Solid,new[]{Segment(kind>=4,kind%2==0)},false);
  else if(kind<=7) {
   double bulge=kind==6?1:-1;
   var hole=new Polyline2D(new[]{new Polyline2DVertex(95,200,bulge),new Polyline2DVertex(105,200,bulge)},true);
   hatch=new Hatch(HatchPattern.Solid,new[]{Square(),new HatchBoundaryPath(new EntityObject[]{hole})},false);
  } else {
   hatch=new Hatch(HatchPattern.Solid,new[]{Square(),new HatchBoundaryPath(new EntityObject[]{new Circle(new Vector2(100,200),8)})},false){Normal=new Vector3(0,1,0),Elevation=7};
  }
  var doc=new DxfDocument();
  if(kind==8) {var block=new Block("tilted");block.Entities.Add(hatch);doc.Entities.Add(new Insert(block,new Vector3(10,20,30)){Scale=new Vector3(2,3,4),Rotation=90});}
  else doc.Entities.Add(hatch);
  using var stream=new MemoryStream();if(!doc.Save(stream,binary))throw new Exception("Save failed");return Convert.ToBase64String(stream.ToArray());
 }
}`;

let compiler, session;
let checks = 0;
try {
  compiler = await createRoslyn({ timeoutMs: 180000, startupTimeoutMs: 90000 });
  const manifest = JSON.parse(await readFile(new URL('dist/netdxf/manifest.json', root)));
  await compiler.addDll(manifest.library.file, await readFile(new URL('dist/netdxf/' + manifest.library.file, root)));
  const bridge = success(await compiler.compile(await readFile(new URL('src/dxf/NetDxfBridge.cs', root), 'utf8'), { assemblyName: 'RoslynWeb.NetDxfBridge', outputKind: 'library', optimization: 'release', emitPdb: false }));
  session = await createNetDxf({ compiler, verify: false, loadAsset: url => url.pathname.endsWith('/' + manifest.bridge.file) ? bridge.pe : readFile(url) });
  const fixture = success(await compiler.compile(fixtureSource, { assemblyName: 'HatchEdgesFixture', outputKind: 'library', optimization: 'release', emitPdb: false }));
  const names = ['circular hole', 'rotated ellipse hole', 'CCW circular segment', 'CW circular segment', 'CCW rotated ellipse segment', 'CW rotated ellipse segment', 'positive bulge hole', 'negative bulge hole', 'tilted hatch in nonuniform rotated block'];
  for (let kind = 0; kind < names.length; kind++) for (const binary of [false, true]) {
    const encoded = success(await compiler.invoke(fixture.assemblyId, 'HatchEdgesFixture', 'Create', [kind, binary])).result;
    const document = await session.load(Uint8Array.from(atob(encoded), value => value.charCodeAt(0)));
    try {
      assert.deepEqual(document.issues, [], `${names[kind]}: ${JSON.stringify(document.issues)}`);
      assert.equal(document.scene.entities.length, 1);
      const hatch = document.scene.entities[0]; assert.equal(hatch.type, 'HATCH');
      const loops = hatch.loops.map(loop => loop.map(point));
      const vertices = triangulateDxfLoops(loops);
      const precision = document.stats.curvePrecision;
      let expected;
      if (kind === 0 || kind === 8) expected = (1600 - circleArea(8, precision)) * (kind === 8 ? 8 : 1);
      else if (kind === 1) expected = 1600 - circleArea(1, precision) * 21;
      else if (kind <= 5) expected = segmentArea(kind >= 4 ? 7 : 5, kind >= 4 ? 3 : 5, kind % 2 === 0 ? 350 : 230, kind % 2 === 0 ? 80 : 340, precision - 1);
      else expected = 1600 - circleArea(5, 2 * (Math.floor(precision / 2) + 1));
      near(area(vertices), expected, 2e-6);
      if (kind <= 1 || kind >= 6) {
        const project = kind === 8 ? p => [(20 - p[1]) / 2, (p[2] - 30) / 4] : p => p;
        assert.equal(contains(vertices, [100, 200], project), false, 'curved hole remains empty');
        assert.equal(contains(vertices, [82, 182], project), true, 'outer region remains filled');
      }
      if (kind === 8) for (const p of vertices) near(p[0], -11, 1e-8);
      const geometry = tessellateDxfScene(document.scene, { strict: true });
      assert.equal(geometry.issues.length, 0); assert.ok(geometry.counts.triangles > 0);
      const reloaded = await session.load(await document.export({ binary: !binary }));
      try { assert.deepEqual(reloaded.issues, []); near(area(triangulateDxfLoops(reloaded.scene.entities[0].loops.map(loop => loop.map(point)))), expected, 2e-6); }
      finally { await reloaded.dispose(); }
      checks++; console.log(`PASS ${names[kind]} (${binary ? 'binary' : 'ASCII'} and opposite-format round trip)`);
    } finally { await document.dispose(); }
  }
} finally {
  await session?.dispose(); await compiler?.close();
  console.log(`${checks}/18 actual managed curved-hatch checks passed.`);
}
