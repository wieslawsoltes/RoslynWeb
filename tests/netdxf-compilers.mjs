// Actual pinned netDxf source -> Roslyn .NET WASM -> PE -> both compiler backends.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {createNetDxfKernel,netDxfKernelMethods} from '../src/dxf/kernel.js';
import {loadWasm} from '../src/wasm/index.js';

const root=new URL('../',import.meta.url),checks=[];
const provenance=JSON.parse(await readFile(new URL('vendor/netDxf/provenance.json',root)));
const report={testedAt:new Date().toISOString(),upstream:{repository:provenance.repository,commit:provenance.commit},
  runtime:'Actual Roslyn and .NET WebAssembly in Node worker_threads; emitted JavaScript and direct native WebAssembly execute outside that worker.',
  sourceCount:provenance.sourceCount,fullLibrarySupport:{},checks};
let compiler;
const requireSuccess=result=>{assert.equal(result.success,true,JSON.stringify(result.error??result.diagnostics));return result;};
async function check(name,action){const start=performance.now();try{const evidence=await action();checks.push({name,passed:true,milliseconds:performance.now()-start,evidence});console.log('PASS',name);return evidence;}catch(error){checks.push({name,passed:false,milliseconds:performance.now()-start,error:{message:error.message,stack:error.stack}});throw error;}}
async function emitVerified(assembly,backend,options={}) {
 const artifact=await compiler[backend==='javascript'?'emitJavaScript':'emitWasm'](assembly,{...options,strict:true});
 assert.equal(artifact.analysis?.supported,true,`${backend}: assembly preflight must succeed`);
 assert.deepEqual(artifact.analysis.diagnostics,[],`${backend}: emission must have zero diagnostics`);
 const compiledMethods=artifact.analysis.methodCount??artifact.analysis.methods;
 assert(Number.isInteger(compiledMethods)&&compiledMethods>0,`${backend}: emitted method count must be recorded`);
 return {artifact,evidence:{supported:true,emitted:true,executed:false,diagnosticCount:0,compiledMethods}};
}
const ioSource=`using System; using System.IO; using System.Linq; using System.Text; using netDxf; using netDxf.Entities;
public static class NetDxfIoProbe {
 public static int RoundTrip(bool binary) {
  Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
  var document = new DxfDocument();
  document.Entities.Add(new Line(new Vector3(0,0,0),new Vector3(3,4,0)));
  document.Entities.Add(new Circle(new Vector3(2,2,0),1));
  using(var output = new MemoryStream()) {
   if(!document.Save(output,binary)) throw new Exception("netDxf.Save failed");
   using(var input = new MemoryStream(output.ToArray())) {
    var loaded=DxfDocument.Load(input);
    if(loaded==null) throw new Exception("netDxf.Load failed");
    return loaded.Entities.Lines.Count()*100+loaded.Entities.Circles.Count();
   }
  }
 }
}`;
try{
 compiler=await createRoslyn({startupTimeoutMs:90000,timeoutMs:300000});report.compiler=compiler.info;
 let assembly;
 await check('All 272 unchanged pinned netDxf C# sources compile in Roslyn WebAssembly without diagnostics',async()=>{
  const sources=await Promise.all(provenance.sources.map(async item=>{const bytes=await readFile(new URL('vendor/netDxf/source/'+item.path,root));assert.equal(createHash('sha256').update(bytes).digest('hex'),item.sha256,item.path);return {path:'netDxf/'+item.path,text:bytes.toString('utf8')};}));
  assert.equal(sources.length,272);
  assembly=requireSuccess(await compiler.compile(sources,{assemblyName:'netDxf.netstandard',outputKind:'library',defines:['NETSTANDARD','TRACE'],nullable:'disable',optimization:'release',emitPdb:false,compilerExtensions:[],enableGenerators:false,enableAnalyzers:false}));
  assert.deepEqual(assembly.diagnostics,[]);
  await compiler.addDll('netDxf.netstandard.dll',assembly.pe);
  return {sources:sources.length,diagnostics:assembly.diagnostics.length,peBytes:assembly.pe.length,sha256:createHash('sha256').update(assembly.pe).digest('hex')};
 });
 await check('Full-library default JavaScript and native Wasm emission require zero diagnostics',async()=>{
  for(const [key,backend]of [['javascript','javascript'],['nativeWasm','native-wasm']]){
   const {evidence}=await emitVerified(assembly,backend);
   report.fullLibrarySupport[key]={...evidence,selection:backend==='javascript'?'Complete inspected library method set.':'Default native exports: public closed static methods plus their reachable method closure.'};
  }
  return report.fullLibrarySupport;
 });
 const source=await readFile(new URL('src/dxf/NetDxfKernel.cs',root),'utf8');
 const cases=[['Distance2',[0,0,3,4]],['Distance3',[0,0,0,2,3,6]],['RotateX',[1,0,Math.PI/2]],['RotateY',[1,0,Math.PI/2]],['CrossZ',[2,0,0,4]],['NormalizeAngle',[-30]],['CubicBezierCoordinate',[0,10,10,0,0.5]],['LineLength',[0,0,0,2,3,6]],['CircleArea',[5]],['ArcSweep',[-30,45]],['TrueColorArgb',[12,34,56]]];
 let state=0x17adfb4;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};const value=()=>(random()-.5)*2000;
 for(let i=0;i<24;i++){
  cases.push(['Distance2',[value(),value(),value(),value()]],['Distance3',[value(),value(),value(),value(),value(),value()]],
   ['RotateX',[value(),value(),value()]],['RotateY',[value(),value(),value()]],['CrossZ',[value(),value(),value(),value()]],
   ['NormalizeAngle',[value()]],['CubicBezierCoordinate',[value(),value(),value(),value(),random()]],
   ['LineLength',[value(),value(),value(),value(),value(),value()]],['CircleArea',[random()*100+0.01]],['ArcSweep',[value(),value()]],['TrueColorArgb',[Math.floor(random()*256),Math.floor(random()*256),Math.floor(random()*256)]]);
 }
 cases.push(['CubicBezierCoordinate',[2,3,9,20,0]],['CubicBezierCoordinate',[2,3,9,20,1]],['Distance2',[-1e100,1e100,1e100,-1e100]],['NormalizeAngle',[-720]]);
 const programs={};
 try{
  await check('Public kernel API compiles eleven real netDxf geometry, entity and color exports on all three backends',async()=>{
   for(const backend of ['wasm','javascript','native-wasm']){programs[backend]=await createNetDxfKernel({compiler,backend,source});assert.equal(programs[backend].info.diagnostics,0);assert.deepEqual(programs[backend].info.methods,netDxfKernelMethods);}
   return Object.fromEntries(Object.entries(programs).map(([backend,program])=>[backend,program.info]));
  });
  await check('279 deterministic geometry, entity and color cases match the .NET WebAssembly oracle on both generated backends',async()=>{
   const results=[];
   for(const [method,args] of cases){const expected=await programs.wasm.invoke(method,args);const actual={};for(const backend of ['javascript','native-wasm']){actual[backend]=await programs[backend].invoke(method,args);assert(Math.abs(actual[backend]-expected)<=Math.max(1,Math.abs(expected))*2e-13,`${backend} ${method}(${args}): ${actual[backend]} != ${expected}`);}results.push({method,args,expected,...actual});}
   return {caseCount:cases.length,cases:results};
  });
  await check('Real Bezier parameter validation throws ArgumentOutOfRangeException across all backends',async()=>{
   for(const backend of ['wasm','javascript','native-wasm'])for(const t of [-0.01,1.01])await assert.rejects(async()=>await programs[backend].invoke('CubicBezierCoordinate',[0,10,10,0,t]),error=>[error.$type,error.managedType,error.type].includes('System.ArgumentOutOfRangeException'));
   return {parameters:[-0.01,1.01],exception:'System.ArgumentOutOfRangeException'};
  });
 }finally{for(const program of Object.values(programs))program.dispose();}
 await check('Entity construction and RGB validation preserve ArgumentOutOfRangeException on all backends',async()=>{
  const invalid=[['CircleArea',[-1]],['CircleArea',[0]],['TrueColorArgb',[-1,0,0]],['TrueColorArgb',[0,256,0]],['TrueColorArgb',[0,0,256]]];
  const programs=[];
  try{for(const backend of ['wasm','javascript','native-wasm']){const kernel=await createNetDxfKernel({compiler,backend,source});programs.push(kernel);for(const [method,args] of invalid)await assert.rejects(async()=>await kernel.invoke(method,args),error=>[error.$type,error.managedType,error.type].includes('System.ArgumentOutOfRangeException'));}}
  finally{for(const kernel of programs)kernel.dispose();}
  return {caseCount:invalid.length,backends:3,exception:'System.ArgumentOutOfRangeException'};
 });
 await check('Managed, generated JavaScript and native Wasm execute ASCII and binary DXF round-trips',async()=>{
  const io=requireSuccess(await compiler.compile(ioSource,{assemblyName:'NetDxfIoProbe',outputKind:'library',optimization:'release',emitPdb:false}));
  const common={formats:['ASCII','binary'],entities:['LINE','CIRCLE'],expectedResult:101};
  report.documentIo={managed:{...common,supported:false,executed:false,roundTrips:[]}};
  for(const binary of [false,true]){
   const result=requireSuccess(await compiler.invoke(io.assemblyId,'NetDxfIoProbe','RoundTrip',[binary])).result;
   assert.equal(result,101,`managed ${binary?'binary':'ASCII'} RoundTrip`);
   report.documentIo.managed.roundTrips.push({format:binary?'binary':'ASCII',result});
  }
  Object.assign(report.documentIo.managed,{supported:true,executed:true});
  for(const [key,backend]of [['javascript','javascript'],['nativeWasm','native-wasm']]){
   const {artifact,evidence}=await emitVerified(io,backend,{exports:['NetDxfIoProbe.RoundTrip'],optimize:true,runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href});
   const entry=report.documentIo[key]={...common,...evidence,supported:false,roundTrips:[]};
   const program=backend==='javascript'
    ? (await import('data:text/javascript;base64,'+Buffer.from(artifact.source).toString('base64'))).createAssembly()
    : await loadWasm(artifact.bytes);
   try{
    for(const binary of [false,true]){
     const started=performance.now(),result=program.invoke('NetDxfIoProbe::RoundTrip',[binary]);
     assert.equal(result,101,`${backend} ${binary?'binary':'ASCII'} RoundTrip`);
     entry.roundTrips.push({format:binary?'binary':'ASCII',result,milliseconds:performance.now()-started});
    }
    Object.assign(entry,{supported:true,executed:true});
   }finally{program.dispose?.();}
  }
  return report.documentIo;
 });
}catch(error){console.error(error.message);process.exitCode=1;}finally{await compiler?.close();report.passed=process.exitCode!==1&&checks.every(item=>item.passed);report.note='Full-library support entries require strict zero-diagnostic emission for each stated method selection; they do not assert execution of every method. Document I/O entries require actual LINE/CIRCLE Save/Load execution in both ASCII and binary formats on each backend, with RoundTrip=101. Broader document fidelity is verified separately by netdxf-document-verification.json.';await writeFile(new URL('docs/netdxf-backends-verification.json',root),JSON.stringify(report,null,2)+'\n');console.log(`${checks.filter(item=>item.passed).length}/${checks.length} netDxf backend checks passed.`);}
