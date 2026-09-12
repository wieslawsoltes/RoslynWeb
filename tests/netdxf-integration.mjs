// Real complete netDxf source compilation and execution in the .NET WASM host.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRoslyn } from '../src/node/index.js';
import { createNetDxf } from '../src/dxf/index.js';
import { tessellateDxfScene } from '../src/dxf/geometry.js';

const root = new URL('../', import.meta.url);
const checks = [];
let compiler, session, sourceSession;
const hash = value => createHash('sha256').update(value).digest('hex');
const success = value => { assert.equal(value.success, true, JSON.stringify(value.error || value.diagnostics)); return value; };
const check = async (name, run) => {
  const start = performance.now();
  const evidence = await run();
  checks.push({ name, passed: true, milliseconds: performance.now() - start, evidence });
  console.log('PASS', name);
};
const timeout = setTimeout(() => { compiler?.dispose(); console.error('netDxf integration exceeded 240 seconds'); process.exitCode = 1; }, 240000);
try {
  await check('All 272 vendored C# files and both upstream DXF fixtures match the pinned source hashes', async () => {
    const provenance = JSON.parse(await readFile(new URL('vendor/netDxf/provenance.json', root)));
    assert.equal(provenance.sourceCount, 272);
    assert.equal(provenance.commit, '5b562312f683fc635405c149537ca488e4ec4d39');
    for (const file of provenance.sources) {
      const value = await readFile(new URL('vendor/netDxf/source/' + file.path, root));
      assert.equal(value.length, file.bytes, file.path);
      assert.equal(hash(value), file.sha256, file.path);
    }
    for (const file of provenance.fixtures) assert.equal(hash(await readFile(new URL('vendor/netDxf/' + file.path, root))), file.sha256, file.path);
    return { commit: provenance.commit, sourceFiles: provenance.sourceCount, sourceBytes: provenance.sourceBytes, fixtureCount: provenance.fixtures.length };
  });
  await check('The public Node host loads the complete netDxf assembly into managed WebAssembly', async () => {
    compiler = await createRoslyn({ timeoutMs: 180000, startupTimeoutMs: 90000 });
    const progress = [];
    session = await createNetDxf({ compiler, onProgress: event => progress.push(event.stage) });
    assert.equal(session.info.backend, 'wasm');
    assert.equal(session.info.mode, 'prebuilt');
    assert.equal(session.info.sourceCount, 272);
    assert.equal(session.info.compilation.signed, false);
    assert.deepEqual(session.info.compilation.defines, ['NETSTANDARD', 'TRACE']);
    assert(progress.includes('ready'));
    return { library: session.info.library, runtime: compiler.info, progress };
  });
  let sample, text, binary;
  await check('The sample exercises layers, blocks, bulges, circles, arcs, ellipses and solids', async () => {
    sample = await session.createSample();
    assert.equal(sample.stats.entityCount, 18);
    assert.equal(sample.stats.layerCount, 7);
    assert.equal(sample.stats.renderedEntities, 30);
    assert.deepEqual(sample.issues.map(issue => issue.code), ['DXF_WIPEOUT_SOURCE_ORDER']);
    const types = [...new Set(sample.scene.entities.map(entity => entity.type))];
    for (const type of ['LWPOLYLINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'SOLID', 'LINE', 'SEGMENTS', 'HATCH', 'TEXT', 'MTEXT', 'ATTRIB', 'WIPEOUT']) assert(types.includes(type), type);
    assert.equal(sample.scene.layers.length, 7);
    assert.deepEqual(await sample.refresh(), sample.scene);
    return { stats: sample.stats, types };
  });
  await check('Real text and binary DXF exports reload with the same modelspace geometry', async () => {
    const evidence = [];
    for (const isBinary of [false, true]) {
      const data = await sample.export({ binary: isBinary });
      if (isBinary) { binary = data; assert.equal(new TextDecoder().decode(data.subarray(0, 18)), 'AutoCAD Binary DXF'); }
      else { text = data; assert(new TextDecoder().decode(data).includes('SECTION')); }
      const loaded = await session.load(data);
      assert.equal(loaded.stats.entityCount, sample.stats.entityCount);
      assert.equal(loaded.stats.renderedEntities, sample.stats.renderedEntities);
      assert.equal(loaded.stats.layerCount, sample.stats.layerCount);
      assert.deepEqual(loaded.issues.map(issue => issue.code), sample.issues.map(issue => issue.code));
      assert.deepEqual(loaded.scene.entities.map(entity => entity.type), sample.scene.entities.map(entity => entity.type));
      evidence.push({ binary: isBinary, bytes: data.length, stats: loaded.stats });
      await loaded.dispose();
    }
    return evidence;
  });
  await check('The original complex upstream text and binary drawings preserve all 58 modelspace entities across both export formats', async () => {
    const evidence = [];
    for (const name of ['sample.dxf', 'sample-binary.dxf']) {
      const loaded = await session.load(await readFile(new URL('vendor/netDxf/fixtures/' + name, root)));
      assert.equal(loaded.stats.entityCount, 58);
      assert.equal(loaded.stats.layerCount, 7);
      assert(loaded.stats.renderedEntities > 100);
      assert(loaded.issues.some(issue => issue.code === 'DXF_ENTITY_NOT_RENDERED'));
      assert(loaded.issues.some(issue => issue.code === 'DXF_HATCH_PATTERN_NOT_RENDERED'));
      assert(!loaded.issues.some(issue => issue.code === 'DXF_GEOMETRY_ERROR'), JSON.stringify(loaded.issues));
      const roundtrips = [];
      for (const binary of [false, true]) {
        const data = await loaded.export({ binary });
        const reloaded = await session.load(data);
        assert.equal(reloaded.stats.entityCount, loaded.stats.entityCount);
        assert.equal(reloaded.stats.layerCount, loaded.stats.layerCount);
        assert.equal(reloaded.stats.blocks, loaded.stats.blocks);
        assert.equal(reloaded.stats.unsupportedEntities, loaded.stats.unsupportedEntities);
        assert.equal(reloaded.stats.renderedEntities, loaded.stats.renderedEntities);
        assert.deepEqual(reloaded.issues.map(issue => [issue.code, issue.entityType]), loaded.issues.map(issue => [issue.code, issue.entityType]));
        roundtrips.push({ binary, bytes: data.length, stats: reloaded.stats });
        await reloaded.dispose();
      }
      evidence.push({ fixture: name, stats: loaded.stats, issues: loaded.issues, roundtrips });
      await loaded.dispose();
    }
    return evidence;
  });
  await check('Nested nonuniform block transforms preserve origins, layer zero and ByBlock color inheritance', async () => {
    const assembly = success(await compiler.compile(`using System; using System.IO; using netDxf; using netDxf.Entities; using netDxf.Blocks; using netDxf.Tables;
public static class AffineDxfFixture {
 public static string Create() {
  var inner = new Block("inner") { Origin = new Vector3(1,2,0) };
  inner.Entities.Add(new Line(new Vector3(1,2,0), new Vector3(4,5,0)) { Color=AciColor.ByBlock });
  var outer = new Block("outer");
  outer.Entities.Add(new Insert(inner,new Vector3(3,4,0)) { Scale=new Vector3(2,1,1), Rotation=30, Color=AciColor.ByBlock });
  var doc = new DxfDocument();
  doc.Entities.Add(new Insert(outer,new Vector3(10,20,0)) { Scale=new Vector3(1,3,1), Rotation=45, Layer=new Layer("visible") { Color=new AciColor((short)1) }, Color=AciColor.ByLayer });
  using var stream=new MemoryStream(); if (!doc.Save(stream,false)) throw new Exception("Save failed"); return Convert.ToBase64String(stream.ToArray());
 }
}`, { assemblyName: 'NetDxfAffineFixture', outputKind: 'library', emitPdb: false }));
    const encoded = success(await compiler.invoke(assembly.assemblyId, 'AffineDxfFixture', 'Create', [])).result;
    const doc = await session.load(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)));
    assert.deepEqual(doc.issues, []);
    assert.equal(doc.scene.entities.length, 1);
    const line = doc.scene.entities[0];
    assert.equal(line.layer, 'visible');
    assert.deepEqual(line.color, [1, 0, 0, 1]);
    const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
    near(line.start.x, 3.6360389693210724); near(line.start.y, 30.606601717798213);
    near(line.end.x, -5.62569954022506); near(line.end.y, 45.09548911213424);
    await doc.dispose();
    return line;
  });
  await check('Managed text, attributes and hatch islands preserve transforms and document round-trip values', async () => {
    const assembly = success(await compiler.compile(`using System; using System.IO; using netDxf; using netDxf.Entities; using netDxf.Blocks; using netDxf.Tables;
public static class TextFillFixture {
 public static string Create() {
  var font=new TextStyle("Unicode", "sans-serif", FontStyle.Regular);
  var inner=new Block("text") { Origin=new Vector3(1,2,0) };
  inner.Entities.Add(new Text("Ω ± Ø",new Vector3(1,2,0),2,font) { Rotation=90, Color=AciColor.ByBlock });
  inner.Entities.Add(new MText("One\\\\PTwo",new Vector2(3,4),3,12,font) { AttachmentPoint=MTextAttachmentPoint.MiddleCenter });
  inner.AttributeDefinitions.Add(new AttributeDefinition("TAG",2,font) { Position=new Vector3(1,2,0),Value="部品",Color=AciColor.ByBlock });
  inner.AttributeDefinitions.Add(new AttributeDefinition("HIDDEN",2,font) { Value="hidden",Flags=AttributeFlags.Hidden });
  var insert=new Insert(inner,new Vector3(10,20,0)) { Scale=new Vector3(2,3,1),Rotation=90,Layer=new Layer("Labels") { Color=new AciColor((short)1) } };
  insert.TransformAttributes(); var doc=new DxfDocument(); doc.Entities.Add(insert);
  doc.Entities.Add(new Hatch(HatchPattern.Solid,new[] {
    new HatchBoundaryPath(new EntityObject[] { new Polyline2D(new[]{new Vector2(0,0),new Vector2(10,0),new Vector2(10,10),new Vector2(0,10)},true) }),
    new HatchBoundaryPath(new EntityObject[] { new Polyline2D(new[]{new Vector2(2,2),new Vector2(8,2),new Vector2(8,8),new Vector2(2,8)},true) }),
    new HatchBoundaryPath(new EntityObject[] { new Polyline2D(new[]{new Vector2(4,4),new Vector2(6,4),new Vector2(6,6),new Vector2(4,6)},true) })
  },false) { Elevation=7 });
  using var stream=new MemoryStream(); if(!doc.Save(stream,false))throw new Exception("Save failed"); return Convert.ToBase64String(stream.ToArray());
 }
}`, { assemblyName: 'TextFillFixture', outputKind: 'library', emitPdb: false }));
    const encoded = success(await compiler.invoke(assembly.assemblyId, 'TextFillFixture', 'Create', [])).result;
    const document = await session.load(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)));
    assert.deepEqual(document.issues, []);
    const textEntity = document.scene.entities.find(entity => entity.type === 'TEXT');
    const attribute = document.scene.entities.find(entity => entity.type === 'ATTRIB');
    const hatch = document.scene.entities.find(entity => entity.type === 'HATCH');
    const near = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);
    assert.equal(textEntity.text, 'Ω ± Ø'); assert.equal(attribute.text, '部品');
    near(textEntity.position.x, 10); near(textEntity.position.y, 20);
    near(textEntity.axisX.x, -6); near(textEntity.axisX.y, 0); near(textEntity.axisY.x, 0); near(textEntity.axisY.y, -4);
    near(attribute.position.x, 10); near(attribute.position.y, 20); near(attribute.axisX.x, 0);
    // netDxf stores nonuniform ATTRIB scale in Height and WidthFactor; the
    // bridge's axes carry Height once and the GPU layout applies WidthFactor.
    near(attribute.axisX.y * attribute.widthFactor, 4); near(Math.hypot(attribute.axisY.x, attribute.axisY.y), 6);
    assert.deepEqual(attribute.color, [1, 0, 0, 1]);
    assert(!document.scene.entities.some(entity => entity.text === 'hidden'));
    assert.equal(hatch.loops.length, 3); assert(hatch.loops.every(loop => loop.every(p => p.z === 7)));
    const geometry = tessellateDxfScene(document.scene);
    assert.deepEqual(geometry.issues, []); assert.equal(geometry.texts.length, 3);
    const positions = geometry.triangles.positions; let area = 0;
    for (let i=0; i<positions.length; i+=9) area += Math.abs((positions[i+3]-positions[i])*(positions[i+7]-positions[i+1])-(positions[i+4]-positions[i+1])*(positions[i+6]-positions[i]))/2;
    near(area, 68);
    for (const binary of [false, true]) {
      const reloaded = await session.load(await document.export({ binary }));
      assert.deepEqual(reloaded.scene.entities.filter(e => e.text).map(e => e.text), document.scene.entities.filter(e => e.text).map(e => e.text));
      assert.equal(reloaded.scene.entities.find(e => e.type === 'HATCH').loops.length, 3); await reloaded.dispose();
    }
    await document.dispose();
    return { text: textEntity.text, attribute: attribute.text, hatchArea: area, textQuads: geometry.texts.length };
  });
  await check('Queued loads snapshot caller bytes; corruption, size limits and disposal produce explicit errors', async () => {
    const input = text.slice();
    const loading = session.load(input);
    input.fill(0);
    const doc = await loading;
    assert.equal(doc.stats.entityCount, 18);
    await doc.dispose();
    await doc.dispose();
    assert.equal(doc.disposed, true);
    assert.throws(() => doc.export(), { code: 'NETDXF_DISPOSED' });
    await assert.rejects(session.load('not a DXF'), { code: 'NETDXF_MANAGED' });
    const bounded = await createNetDxf({ compiler, maxInputBytes: 8 });
    assert.throws(() => bounded.load(text), { code: 'NETDXF_INPUT_LIMIT' });
    await bounded.dispose();
    assert.equal(compiler.disposed, false);
    return { snapshottedInput: true, invalidDxfRejected: true, inputLimit: 8, compilerRemainsUsable: true };
  });
  await check('Initially hidden layers retain geometry and nested inserts preserve ancestor layer visibility', async () => {
    const assembly = success(await compiler.compile(`using System; using System.IO; using netDxf; using netDxf.Entities; using netDxf.Blocks; using netDxf.Tables;
public static class HiddenLayerDxfFixture {
 public static string Create() {
  var hidden = new Layer("Hidden") { IsVisible=false }; var frozen = new Layer("Frozen") { IsFrozen=true }; var child = new Layer("Child");
  var block = new Block("block"); block.Entities.Add(new Line(new Vector2(0,0),new Vector2(5,0)) { Layer=child });
  var doc = new DxfDocument(); doc.Entities.Add(new Line(new Vector2(0,1),new Vector2(5,1)) { Layer=hidden });
  doc.Entities.Add(new Line(new Vector2(0,3),new Vector2(5,3)) { Layer=frozen });
  doc.Entities.Add(new Insert(block,new Vector2(10,0)) { Layer=hidden });
  doc.Entities.Add(new Line(new Vector2(0,2),new Vector2(5,2)) { IsVisible=false });
  using var stream=new MemoryStream(); if (!doc.Save(stream,false)) throw new Exception("Save failed"); return Convert.ToBase64String(stream.ToArray());
 }
}`, { assemblyName: 'NetDxfHiddenLayerFixture', outputKind: 'library', emitPdb: false }));
    const encoded = success(await compiler.invoke(assembly.assemblyId, 'HiddenLayerDxfFixture', 'Create', [])).result;
    const doc = await session.load(Uint8Array.from(atob(encoded), character => character.charCodeAt(0)));
    assert.equal(doc.scene.entities.length, 3);
    assert.equal(doc.scene.layers.find(layer => layer.name === 'Hidden').visible, false);
    assert.equal(doc.scene.layers.find(layer => layer.name === 'Child').visible, true);
    assert.equal(doc.scene.layers.find(layer => layer.name === 'Frozen').visible, false);
    for (const entity of doc.scene.entities) assert(entity.visibilityLayers.includes(entity.layer === 'Frozen' ? 'Frozen' : 'Hidden'));
    const child = doc.scene.entities.find(entity => entity.layer === 'Child');
    assert(child.visibilityLayers.includes('Child'));
    await doc.dispose();
    return { retainedGeometry: 3, ancestorVisibilityLayers: child.visibilityLayers };
  });
  await check('Asset integrity validation rejects mismatched generated assemblies before registration', async () => {
    await assert.rejects(createNetDxf({ compiler, loadAsset: async url => {
      const data = new Uint8Array(await readFile(url));
      if (url.pathname.endsWith('netDxf.netstandard.dll')) data[100] ^= 1;
      return data;
    } }), { code: 'NETDXF_INTEGRITY' });
    return { corruptedAssemblyRejected: true };
  });
  await check('Failed scene serialization does not retain an unreachable managed document', async () => {
    const assembly = success(await compiler.compile(`using System; using System.IO; using System.Collections; using System.Reflection;
using netDxf; using netDxf.Entities;
public static class InvalidCoordinateFixture {
 public static int Count() => ((IDictionary)typeof(NetDxfBridge).GetField("Documents",BindingFlags.NonPublic|BindingFlags.Static).GetValue(null)).Count;
 public static string Create() {
  var doc=new DxfDocument(); doc.Entities.Add(new Line(new Vector3(double.NaN,0,0),new Vector3(1,1,0)));
  using var stream=new MemoryStream(); if(!doc.Save(stream,false))throw new Exception("Save failed");
  return Convert.ToBase64String(stream.ToArray());
 }
}`, { assemblyName: 'InvalidCoordinateFixture', outputKind: 'library', emitPdb: false }));
    const invoke = async method => success(await compiler.invoke(assembly.assemblyId, 'InvalidCoordinateFixture', method, [])).result;
    const before = await invoke('Count');
    const data = Uint8Array.from(atob(await invoke('Create')), character => character.charCodeAt(0));
    await assert.rejects(session.load(data), { code: 'NETDXF_MANAGED' });
    assert.equal(await invoke('Count'), before);
    assert((await sample.export()).length > 0);
    return { countBefore: before, countAfter: await invoke('Count'), existingDocumentUsable: true };
  });
  await check('Source mode compiles every pinned netDxf C# file using real Roslyn WebAssembly and runs its output', async () => {
    const events = [];
    sourceSession = await createNetDxf({ compiler, compile: true, onProgress: event => events.push(event) });
    assert.equal(sourceSession.info.mode, 'source');
    assert.equal(sourceSession.compilation.library.success, true);
    assert.equal(hash(sourceSession.compilation.library.pe), sourceSession.info.library.sha256);
    assert.equal(hash(sourceSession.compilation.bridge.pe), sourceSession.info.bridge.sha256);
    assert(events.some(event => event.stage === 'compile-library' && event.sourceCount === 272));
    const doc = await sourceSession.load(binary);
    assert.equal(doc.stats.entityCount, 18);
    await doc.dispose();
    return { sourceCount: 272, deterministicLibraryHash: hash(sourceSession.compilation.library.pe), performance: sourceSession.compilation.library.performance, events };
  });
  await check('Session disposal releases all owned documents and leaves the shared compiler usable', async () => {
    const pending = session.createSample();
    const closing = session.dispose();
    const document = await pending;
    await closing;
    await session.dispose();
    assert.equal(sample.disposed, true);
    assert.equal(document.disposed, true);
    await assert.rejects(session.createSample(), { code: 'NETDXF_DISPOSED' });
    assert.equal(success(await compiler.evaluate('6 * 7', { returnType: 'int' })).result, 42);
    return { documentsReleased: true, compilerStillUsable: true };
  });
} catch (error) {
  console.error(error);
  checks.push({ name: 'Failure', passed: false, error: { message: error.message, stack: error.stack, code: error.code, details: error.details } });
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  await Promise.allSettled([session?.dispose(), sourceSession?.dispose()]);
  await compiler?.close();
  await writeFile(new URL('docs/netdxf-verification.json', root), JSON.stringify({ testedAt: new Date().toISOString(), node: process.version, passed: checks.every(check => check.passed), checks }, null, 2) + '\n');
  console.log(`${checks.filter(check => check.passed).length} netDxf integration checks passed`);
}
