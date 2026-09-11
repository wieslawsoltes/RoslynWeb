import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { importNupkg, NuGetResolver, parseNuspec, normalizeVersion, compareVersions, parseVersionRange, satisfiesVersion, selectFramework, readZip, MemoryPackageCache } from '../src/packages/index.js';
import { crc32 } from '../src/packages/zip.js';
const encoder = new TextEncoder();
const inflateRaw = data=>inflateRawSync(data);
function zip(entries, { compressed = true, descriptor = false } = {}) {
  const local = [], central = []; let offset = 0;
  for (const [path,value] of Object.entries(entries)) {
    const name = encoder.encode(path), bytes = typeof value === 'string' ? encoder.encode(value) : value;
    const payload = compressed ? deflateRawSync(bytes) : bytes, method = compressed ? 8 : 0;
    const header = new Uint8Array(30+name.length), view = new DataView(header.buffer); view.setUint32(0,0x04034b50,true); view.setUint16(4,20,true);view.setUint16(6,descriptor ? 8 : 0,true);view.setUint16(8,method,true);
    if (!descriptor) {view.setUint32(14,crc32(bytes),true); view.setUint32(18,payload.length,true);view.setUint32(22,bytes.length,true);} view.setUint16(26,name.length,true);header.set(name,30);
    const cent = new Uint8Array(46+name.length), cv = new DataView(cent.buffer);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,descriptor ? 8 : 0,true);cv.setUint16(10,method,true);cv.setUint32(16,crc32(bytes),true);cv.setUint32(20,payload.length,true);cv.setUint32(24,bytes.length,true);cv.setUint16(28,name.length,true);cv.setUint32(42,offset,true);cent.set(name,46);
    local.push(header,payload);offset += header.length+payload.length;central.push(cent);
    if (descriptor) {const tail = new Uint8Array(16),tv = new DataView(tail.buffer);tv.setUint32(0,0x08074b50,true);tv.setUint32(4,crc32(bytes),true);tv.setUint32(8,payload.length,true);tv.setUint32(12,bytes.length,true);local.push(tail);offset += tail.length;}
  }
  const size = central.reduce((n,b)=>n+b.length,0), end = new Uint8Array(22), ev = new DataView(end.buffer);ev.setUint32(0,0x06054b50,true);ev.setUint16(8,central.length,true);ev.setUint16(10,central.length,true);ev.setUint32(12,size,true);ev.setUint32(16,offset,true);
  const result = new Uint8Array(offset+size+22); let p=0; for (const bytes of [...local,...central,end]) {result.set(bytes,p);p+=bytes.length;}return result;
}
function pkg(id,version,dependencies='',assets = {[`lib/net8.0/${id}.dll`]:new Uint8Array([77,90,1])}) {
  return zip({[`${id}.nuspec`]:`<?xml version="1.0"?><package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd"><metadata><id>${id}</id><version>${version}</version><authors>A &amp; B</authors><description><![CDATA[Hello <world>]]></description><dependencies>${dependencies}</dependencies></metadata></package>`,...assets});
}
function mockFeed(specs) {
  const calls = [], map = new Map();
  map.set('https://feed.test/v3/index.json',JSON.stringify({resources:[{'@type':'PackageBaseAddress/3.0.0','@id':'https://feed.test/flat/'}]}));
  const byId = new Map();
  for (const spec of specs) {const id=spec.id.toLowerCase(),version=normalizeVersion(spec.version);if(!byId.has(id))byId.set(id,[]);byId.get(id).push(version);map.set(`https://feed.test/flat/${id}/${version}/${id}.${version}.nupkg`,pkg(spec.id,version,spec.dependencies,spec.assets));}
  for (const [id,versions] of byId) map.set(`https://feed.test/flat/${id}/index.json`,JSON.stringify({versions}));
  return {calls,fetch:async url=>{calls.push(url);return new Response(map.get(url),{status:map.has(url)?200:404});}};
}
const resolverFor = feed=>new NuGetResolver({feeds:['https://feed.test/v3/index.json'],fetch:feed.fetch,inflateRaw});
test('NuGet four-segment normalization and case-insensitive prerelease ordering',()=>{
  assert.equal(normalizeVersion('01.02.003.0+sha'),'1.2.3');assert.equal(normalizeVersion('1.2.3.4-Beta.2'),'1.2.3.4-beta.2');
  assert.equal(compareVersions('1','1.0.0.0'),0);assert.equal(compareVersions('1.0-Alpha','1.0-alpha'),0);
  assert.ok(compareVersions('1.0-rc.10','1.0-rc.2')>0);assert.ok(compareVersions('1.0','1.0-rc')>0);assert.ok(compareVersions('1.0-2','1.0-a')<0);
});
test('NuGet minimum, exact, bounded, floating and prerelease ranges',()=>{
  assert.ok(satisfiesVersion('2.0','1.0'));assert.ok(!satisfiesVersion('2.0','[1.0]'));assert.ok(satisfiesVersion('1.5','[1,2)'));assert.ok(!satisfiesVersion('2','[1,2)'));
  assert.ok(satisfiesVersion('2','(1,)'));assert.ok(satisfiesVersion('0.9','(,1]'));assert.ok(satisfiesVersion('3.2.1','3.*'));assert.ok(!satisfiesVersion('4.0','3.*'));
  assert.ok(!satisfiesVersion('1.2-beta','*',{includePrerelease:false}));assert.ok(satisfiesVersion('1.2-beta','*-*',{includePrerelease:false}));
  assert.throws(()=>parseVersionRange('(1.0)'),/Invalid/);assert.throws(()=>parseVersionRange('[2,1)'),/Empty/);
});
test('Nearest compatible browser target and nuspec framework aliases',()=>{
  assert.equal(selectFramework(['netstandard2.0','net8.0','net9.0','net11.0'],'net10.0'),'net9.0');
  assert.equal(selectFramework(['.NETStandard2.0','.NETFramework4.8'],'net8.0'),'.NETStandard2.0');
  assert.equal(selectFramework(['net8.0-windows','net48'],'net10.0'),null);
  assert.equal(selectFramework(['net8.0','net8.0-browser'],'net8.0'),'net8.0-browser');
  assert.equal(selectFramework(['netstandard2.0','netstandard2.1'],'netstandard2.0'),'netstandard2.0');
});
test('Nuspec parser handles namespaces, entities, CDATA, dependency groups',()=>{
  const parsed=parseNuspec('<p:package xmlns:p="urn:n"><p:metadata><p:id>Alpha</p:id><p:version>1</p:version><p:description>A &amp; B &#x3C; C</p:description><p:dependencies><p:group targetFramework="net8.0"><p:dependency id="Beta" version="[1,2)" /></p:group></p:dependencies></p:metadata></p:package>');
  assert.equal(parsed.description,'A & B < C');assert.equal(parsed.version,'1.0.0');assert.equal(parsed.dependencyGroups[0].dependencies[0].id,'Beta');
  assert.throws(()=>parseNuspec('<!DOCTYPE p [<!ENTITY x "z">]><package/>'),/DTD/);assert.throws(()=>parseNuspec('<package><metadata></package>'),/Mismatched/);
});
test('Deflated nupkg selects compile refs and browser runtime replacements independently',async()=>{
  const data=pkg('Alpha','1','<group targetFramework="netstandard2.0"><dependency id="Old" version="1" /></group><group targetFramework="net8.0"><dependency id="New" version="[2]" /></group>',{'ref/net8.0/Alpha.dll':new Uint8Array([1]),'lib/net8.0/Alpha.dll':new Uint8Array([2]),'runtimes/browser-wasm/lib/net8.0/Alpha.dll':new Uint8Array([3]),'lib/net48/Alpha.dll':new Uint8Array([4])});
  const result=await importNupkg(data,{inflateRaw});assert.equal(result.id,'Alpha');assert.equal(result.authors,'A & B');assert.deepEqual(result.compileAssets[0].bytes,new Uint8Array([1]));assert.deepEqual(result.runtimeAssets[0].bytes,new Uint8Array([3]));assert.equal(result.dependencies[0].id,'New');
});
test('Stored ZIP, data descriptors, CRC and traversal protection',async()=>{
  const content='hello';assert.equal(new TextDecoder().decode((await readZip(zip({'x.txt':content},{compressed:false}))).get('x.txt')),content);
  assert.equal(new TextDecoder().decode((await readZip(zip({'x.txt':content},{descriptor:true}),{inflateRaw})).get('x.txt')),content);
  const corrupt=zip({'x.txt':content},{compressed:false});corrupt[35]^=1;await assert.rejects(()=>readZip(corrupt),/CRC/);
  await assert.rejects(()=>readZip(zip({'../x':content})),/Unsafe/);await assert.rejects(()=>readZip(zip({'a':content}),{maxUncompressedBytes:2}),/size limit/);
});
test('Incompatible frameworks and native packages fail explicitly',async()=>{
  await assert.rejects(()=>importNupkg(pkg('Old','1','',{'lib/net48/Old.dll':new Uint8Array([1])}),{inflateRaw}),e=>e.code==='INCOMPATIBLE_FRAMEWORK');
  const native=pkg('Native','1','',{'lib/net8.0/Native.dll':new Uint8Array([1]),'runtimes/win-x64/native/n.dll':new Uint8Array([2])});
  await assert.rejects(()=>importNupkg(native,{inflateRaw}),e=>e.code==='NATIVE_ASSETS_REQUIRE_HOST');assert.ok((await importNupkg(native,{inflateRaw,allowNativeAssets:true})).warnings.length);
});
test('Empty selected dependency group suppresses fallback group dependencies',async()=>{
  const result=await importNupkg(pkg('NoDeps','1','<group targetFramework="netstandard2.0"><dependency id="Old" version="1" /></group><group targetFramework="net8.0"/>'),{inflateRaw});assert.deepEqual(result.dependencies,[]);
});
test('Transitive solver intersects cousin constraints, resolves cycles and caches downloads',async()=>{
  const feed=mockFeed([{id:'A',version:'1',dependencies:'<dependency id="Shared" version="[1,3)"/>'},{id:'B',version:'1',dependencies:'<dependency id="Shared" version="[2,4)"/>'},{id:'Shared',version:'1'},{id:'Shared',version:'2',dependencies:'<dependency id="A" version="[1]"/>'},{id:'Shared',version:'3'}]);
  const resolver=resolverFor(feed);const result=await resolver.resolve([{id:'A',version:'[1]'},{id:'B',version:'[1]'}]);assert.equal(result.packages.find(p=>p.id==='Shared').version,'2.0.0');assert.equal(result.compileAssets.length,3);
  const count=feed.calls.length;await resolver.resolve([{id:'A',version:'[1]'},{id:'B',version:'[1]'}]);assert.equal(feed.calls.length,count);
});
test('Solver backtracks parent versions when transitive constraints are incompatible',async()=>{
  const feed=mockFeed([{id:'A',version:'1',dependencies:'<dependency id="C" version="[1]"/>'},{id:'A',version:'2',dependencies:'<dependency id="C" version="[2]"/>'},{id:'B',version:'1',dependencies:'<dependency id="C" version="[2]"/>'},{id:'C',version:'1'},{id:'C',version:'2'}]);
  const result=await resolverFor(feed).resolve([{id:'A',version:'1'},{id:'B',version:'[1]'}]);assert.equal(result.packages.find(p=>p.id==='A').version,'2.0.0');assert.equal(result.packages.find(p=>p.id==='C').version,'2.0.0');
});
test('Conflicts contain all sources and exact pins do not silently downgrade',async()=>{
  const feed=mockFeed([{id:'A',version:'1',dependencies:'<dependency id="C" version="[2]"/>'},{id:'C',version:'1'},{id:'C',version:'2'}]);
  await assert.rejects(()=>resolverFor(feed).resolve([{id:'A',version:'[1]'},{id:'C',version:'[1]'}]),e=>e.code==='DEPENDENCY_CONFLICT'&&e.details.constraints.length===2&&e.message.includes('A 1.0.0'));
});
test('Floating versions choose highest stable; explicit prerelease range permits prerelease',async()=>{
  const feed=mockFeed([{id:'A',version:'1.1'},{id:'A',version:'1.2'},{id:'A',version:'1.3-beta'},{id:'A',version:'2'}]);const resolver=resolverFor(feed);
  assert.equal((await resolver.resolve([{id:'A',version:'1.*'}])).packages[0].version,'1.2.0');assert.equal((await resolver.resolve([{id:'A',version:'[1.3.0-beta]'}])).packages[0].version,'1.3.0-beta');
});
test('Duplicate assembly names with distinct bytes are rejected',async()=>{
  const feed=mockFeed([{id:'A',version:'1',assets:{'lib/net8.0/Same.dll':new Uint8Array([1])}},{id:'B',version:'1',assets:{'lib/net8.0/Same.dll':new Uint8Array([2])}}]);
  await assert.rejects(()=>resolverFor(feed).resolve([{id:'A',version:'[1]'},{id:'B',version:'[1]'}]),e=>e.code==='ASSEMBLY_CONFLICT');
});
test('Abort signals stop cached restore and invalid IDs cannot alter feed paths',async()=>{
  const feed=mockFeed([{id:'A',version:'1'}]);const resolver=resolverFor(feed);const controller=new AbortController();controller.abort();
  await assert.rejects(()=>resolver.resolve([{id:'A',version:'[1]'}],{signal:controller.signal}),e=>e.name==='AbortError');
  await assert.rejects(()=>resolver.resolve([{id:'../secret',version:'1'}]),e=>e.code==='INVALID_PACKAGE_ID');
});
test('Native Web Streams raw-DEFLATE path imports a real ZIP archive',async()=>{
  const result=await importNupkg(pkg('Streaming','1.0.0','',{'lib/net8.0/Streaming.dll':new Uint8Array([77,90,1,2,3])}));
  assert.equal(result.id,'Streaming');assert.deepEqual([...result.runtimeAssets[0].bytes],[77,90,1,2,3]);
});
test('Identical satellite names in separate culture directories remain distinct',async()=>{
  const feed=mockFeed([{id:'A',version:'1',assets:{'lib/net8.0/de/Texts.resources.dll':new Uint8Array([1])}},{id:'B',version:'1',assets:{'lib/net8.0/fr/Texts.resources.dll':new Uint8Array([2])}}]);
  const result=await resolverFor(feed).resolve([{id:'A',version:'[1]'},{id:'B',version:'[1]'}]);assert.equal(result.runtimeAssets.length,2);
});
test('Legacy framework assembly requirements do not contaminate modern target groups',async()=>{
  const manifest='<package><metadata><id>Modern</id><version>1</version><frameworkAssemblies><frameworkAssembly assemblyName="System.Web" targetFramework="net40,net45"/></frameworkAssemblies></metadata></package>';
  const result=await importNupkg(zip({'Modern.nuspec':manifest,'lib/net8.0/Modern.dll':new Uint8Array([77,90])}),{inflateRaw});assert.equal(result.compileAssets.length,1);
  await assert.rejects(()=>importNupkg(zip({'Modern.nuspec':manifest.replace(' targetFramework="net40,net45"',''),'lib/net8.0/Modern.dll':new Uint8Array([77,90])}),{inflateRaw}),e=>e.code==='FRAMEWORK_ASSEMBLIES_UNSUPPORTED');
});

test('Compiler tooling selects C# and nearest Roslyn-specific assemblies including dependency DLLs',async()=>{
 const result=await importNupkg(pkg('Tools','1','',{'analyzers/dotnet/cs/Tool.dll':new Uint8Array([1]),'analyzers/dotnet/roslyn4.0/cs/Tool.dll':new Uint8Array([4]),'analyzers/dotnet/roslyn5.0/cs/Tool.dll':new Uint8Array([5]),'analyzers/dotnet/roslyn6.0/cs/Tool.dll':new Uint8Array([6]),'analyzers/dotnet/roslyn5.0/cs/Dependency.dll':new Uint8Array([8]),'analyzers/dotnet/vb/VisualBasic.dll':new Uint8Array([9])}),{inflateRaw,roslynVersion:'5.0'});
 assert.deepEqual(result.analyzerAssets.map(a=>a.name),['Dependency.dll','Tool.dll']);assert.deepEqual(result.analyzerAssets.find(a=>a.name==='Tool.dll').bytes,new Uint8Array([5]));assert.equal(result.unsupportedAssets.length,0);assert.match(result.warnings.join(' '),/import alone does not execute/);
});

test('Build tooling selects common and nearest framework props/targets and C# content',async()=>{
 const result=await importNupkg(pkg('Build','1','',{'build/Build.props':'<Project/>','build/net8.0/Build.targets':'<Project/>','build/net9.0/Build.targets':'<Project/>','build/net48/Build.targets':'<Project/>','buildTransitive/Transitive.targets':'<Project/>','contentFiles/cs/net8.0/Source.cs':'class A{}','contentFiles/vb/net8.0/Source.vb':'bad','contentFiles/cs/net48/Source.cs':'bad'}),{inflateRaw});
 assert.deepEqual(result.buildAssets.map(a=>a.path),['build/Build.props','build/net9.0/Build.targets','buildTransitive/Transitive.targets']);assert.equal(result.contentAssets.length,1);assert.equal(result.contentAssets[0].relativePath,'Source.cs');
});

test('Resolver applies root and dependency include/exclude asset flags and transitive build rules',async()=>{
 const assets=id=>({[`lib/net8.0/${id}.dll`]:new Uint8Array([id.charCodeAt(0)]),[`analyzers/dotnet/cs/${id}.Analyzer.dll`]:new Uint8Array([7]),[`build/${id}.targets`]:'<Project/>',[`buildTransitive/${id}.targets`]:'<Project/>'});
 const feed=mockFeed([{id:'A',version:'1',dependencies:'<dependency id="B" version="[1]" exclude="analyzers"/>',assets:assets('A')},{id:'B',version:'1',assets:assets('B')}]);
 const result=await resolverFor(feed).resolve([{id:'A',version:'[1]',excludeAssets:'runtime'}]);
 assert.equal(result.runtimeAssets.length,0);assert.equal(result.compileAssets.length,2);assert.deepEqual(result.analyzerAssets.map(a=>a.packageId),['A']);assert.deepEqual(result.buildAssets.map(a=>[a.packageId,a.kind]),[['A','build'],['A','buildTransitive'],['B','buildTransitive']]);assert.equal(result.lock.packages.find(p=>p.id==='A').dependencies[0].exclude,'analyzers');
});

test('Nuspec contentFiles rules preserve build actions and copy metadata',()=>{
 const result=parseNuspec('<package><metadata><id>A</id><version>1</version><contentFiles><files include="cs/**" exclude="**/old.cs" buildAction="Compile" copyToOutput="true" flatten="false"/></contentFiles></metadata></package>');
 assert.deepEqual(result.contentFiles,[{include:'cs/**',exclude:'**/old.cs',buildAction:'Compile',copyToOutput:'true',flatten:'false'}]);
});

test('native requirements are enforced after graph asset exclusions and browser RID selection',async()=>{
 const feed=mockFeed([{id:'NativeBrowser',version:'1',assets:{'lib/net8.0/NativeBrowser.dll':new Uint8Array([1]),'runtimes/browser-wasm/native/module.wasm':new Uint8Array([2])}},{id:'Portable',version:'1',assets:{'lib/net8.0/Portable.dll':new Uint8Array([3]),'runtimes/win-x64/native/unused.dll':new Uint8Array([4])}}]);
 const resolver=resolverFor(feed);
 await assert.rejects(()=>resolver.resolve([{id:'NativeBrowser',version:'[1]'}]),error=>error.code==='NATIVE_ASSETS_REQUIRE_HOST');
 const excluded=await resolver.resolve([{id:'NativeBrowser',version:'[1]',excludeAssets:'native'}]);assert.equal(excluded.nativeAssets.length,0);assert.equal(excluded.runtimeAssets.length,1);
 const allowed=await resolver.resolve([{id:'NativeBrowser',version:'[1]'}],{allowNativeAssets:true});assert.equal(allowed.nativeAssets.length,1);
 const portable=await resolver.resolve([{id:'Portable',version:'[1]'}]);assert.equal(portable.runtimeAssets.length,1);assert.equal(portable.nativeAssets.length,0);
});
