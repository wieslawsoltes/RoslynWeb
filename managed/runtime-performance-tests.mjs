import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {dotnet} from '../dist/_framework/dotnet.js';
const runtime=await dotnet.withDiagnosticTracing(false).create();
const bridge=(await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName)).RoslynBrowser.CompilerBridge;
const tests=[];
async function test(name,fn){const start=performance.now();try{await fn();tests.push({name,status:'passed',ms:Math.round(performance.now()-start)});console.log('PASS',name);}catch(error){tests.push({name,status:'failed',message:error.message,stack:error.stack});console.error('FAIL',name,error.stack);}}
const compile=async(source,options={})=>JSON.parse(await bridge.CompileAsync(JSON.stringify({source,outputKind:'library',emitPdb:false,compilerExtensions:[],...options})));
const success=r=>assert.equal(r.success,true,JSON.stringify(r));
const invoke=async(r,type='CacheProgram')=>{const v=JSON.parse(await bridge.Invoke(r.assemblyId,type,'Value','[]'));success(v);return v.result;};
const source='public static class CacheProgram { public static int Value() => 42; }';
let first,second;
await test('Unchanged source reuses Roslyn parsing and binding inputs with fresh emitted assembly identity',async()=>{
 first=await compile(source);second=await compile(source);success(first);success(second);assert.equal(second.performance.cache.syntaxHits,1);assert.equal(second.performance.cache.compilationReused,true);assert.notEqual(first.assemblyName,second.assemblyName);assert.notEqual(first.assemblyId,second.assemblyId);assert.equal(await invoke(second),42);
});
await test('Incremental source edit changes real WASM execution and retains semantic error checking',async()=>{
 const edit=await compile(source.replace('42','43'));success(edit);assert.equal(edit.performance.cache.incrementalParses,1);assert.equal(edit.performance.cache.compilationReused,true);assert.equal(await invoke(edit),43);
 const broken=await compile(source.replace('42','missingName'));assert.equal(broken.success,false);assert(broken.diagnostics.some(d=>d.id==='CS0103'));
});
await test('Explicit uncached compilation supplies a genuine full-parse baseline',async()=>{
 const r=await compile(source,{useCompilationCache:false});success(r);assert.equal(r.performance.cache.enabled,false);assert.equal(r.performance.cache.syntaxMisses,1);assert.equal(r.performance.cache.compilationReused,false);assert.equal(await invoke(r),42);
});
await test('Parse options and editorconfig changes alter compilation semantics',async()=>{
 const conditional='public static class CacheProgram { public static int Value() {\n#if FEATURE\nreturn 1;\n#else\nreturn 2;\n#endif\n} }';
 const a=await compile(conditional,{defines:['FEATURE']}),b=await compile(conditional,{defines:[]});assert.equal(await invoke(a),1);assert.equal(await invoke(b),2);
 const warning='public class CacheWarnings { void M() { int unused = 0; } }';success(await compile(warning));const r=await compile(warning,{analyzerConfigFiles:[{path:'/.editorconfig',text:'root = true\n[*.cs]\ndotnet_diagnostic.CS0219.severity = error\n'}]});assert.equal(r.success,false);assert.equal(r.performance.cache.compilationReused,false);
});
await test('Reference replacement invalidates the same-identity DLL binding and assembly-ID inspection succeeds',async()=>{
 const dep=async value=>{const r=await compile(`public static class CacheDependency { public const int Number = ${value}; }`,{assemblyName:'WasmCompilationCacheDependency'});success(r);success(JSON.parse(bridge.AddReference('WasmCompilationCacheDependency.dll',r.peBase64)));};
 const consumer=source.replace('42','CacheDependency.Number');await dep(10);const a=await compile(consumer);success(a);assert.equal(await invoke(a),10);await dep(20);const b=await compile(consumer);success(b);assert.equal(b.performance.cache.compilationReused,false);assert.equal(await invoke(b),20);assert(Array.isArray(JSON.parse(bridge.InspectAssembly(b.assemblyId)).types));
 const omitted=await compile(consumer,{referenceNames:[]});assert.equal(omitted.success,false);assert(omitted.diagnostics.some(d=>d.id==='CS0103'));
});
await test('Manifest-resource changes are emitted despite syntax/compilation reuse',async()=>{
 const source='public static class CacheProgram { public static int Value() => int.Parse(new System.IO.StreamReader(System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("Value.txt")!).ReadToEnd()); }';
 const a=await compile(source,{resources:[{name:'Value.txt',base64:'MQ=='}]}),b=await compile(source,{resources:[{name:'Value.txt',base64:'Mg=='}]});success(a);success(b);assert.equal(b.performance.cache.compilationReused,true);assert.equal(await invoke(a),1);assert.equal(await invoke(b),2);
});
await test('Repeated cached source compilation reruns genuine stateful source generators',async()=>{
 for(const name of ['Microsoft.CodeAnalysis','Microsoft.CodeAnalysis.CSharp']){const bytes=await readFile(new URL(`../dist/compiler-references/${name}.dll`,import.meta.url));success(JSON.parse(bridge.AddReference(name+'.dll',bytes.toString('base64'))));}
 const generator=await compile(`using System.Text; using Microsoft.CodeAnalysis; using Microsoft.CodeAnalysis.Text;
 [Generator] public sealed class CacheFreshGenerator : ISourceGenerator {
 private static int calls; public void Initialize(GeneratorInitializationContext c) {}
 public void Execute(GeneratorExecutionContext c) => c.AddSource("CacheGenerated.g.cs", SourceText.From("public static class CacheGenerated { public static int Value() => " + (++calls) + "; }", Encoding.UTF8)); }`);success(generator);
 success(JSON.parse(bridge.AddCompilerExtension('cache-freshness',generator.peBase64)));
 const options={compilerExtensions:['cache-freshness']};const a=await compile('public class CacheInput {}',options),b=await compile('public class CacheInput {}',options);success(a);success(b);assert.equal(b.performance.cache.compilationReused,true);assert.equal(await invoke(a,'CacheGenerated'),1);assert.equal(await invoke(b,'CacheGenerated'),2);
});
await test('Duplicate input paths retain separate trees and Roslyn duplicate-declaration diagnostics',async()=>{
 const sources=[{path:'/duplicate/Same.cs',text:'public class DuplicateCacheType {}'},{path:'/duplicate/Same.cs',text:'public class DuplicateCacheType {}'}];const r=await compile(undefined,{sources});assert.equal(r.success,false);assert(r.diagnostics.some(d=>d.id==='CS0101'));
});
await test('Compiler cache source retention obeys published LRU bounds',async()=>{
 const sources=Array.from({length:70},(_,i)=>({path:`/many/C${i}.cs`,text:`internal class Many${i} {}`}));
 const r=await compile(undefined,{sources});success(r);assert(r.performance.cache.retainedTrees<=64);assert(r.performance.cache.retainedSourceBytes<=16777216);
});
const benchmark={description:'Real Roslyn C# → emitted MSIL in .NET browser-wasm; no result caching, fresh default assembly identity; informational timing, no flaky speed threshold',rounds:5,sourceFileCount:12,methodsPerFile:80,results:{}};
await test('Measure uncached, warm and edited real Roslyn compilation latency',async()=>{
 const sources=Array.from({length:benchmark.sourceFileCount},(_,file)=>({path:`/benchmark/Unit${file}.cs`,text:`public static class Bench${file} {\n${Array.from({length:benchmark.methodsPerFile},(_,i)=>`public static int M${i}(int x) => x * ${i+1} + ${file};`).join('\n')}\n}`}));
 const request={sources};
 success(await compile(undefined,request));
 const sample=async options=>{const started=performance.now(),r=await compile(undefined,options);success(r);return{wallMs:performance.now()-started,elapsedMs:r.elapsedMs,...r.performance};};
 for(const mode of ['uncached','warm','edited']){
  const samples=[];
  for(let i=0;i<benchmark.rounds;i++){
   const updated=mode==='edited'?sources.map((f,j)=>j===0?{...f,text:f.text.replace('x * 1 + 0','x * 1 + '+(i+1))}:f):sources;
   samples.push(await sample({sources:updated,useCompilationCache:mode!=='uncached'}));
  }
  const median=key=>samples.map(s=>s[key]).sort((a,b)=>a-b)[Math.floor(samples.length/2)];
  benchmark.results[mode]={medianWallMs:median('wallMs'),medianParseMs:median('parseMs'),medianCompilationMs:median('compilationMs'),medianEmitMs:median('emitMs'),samples};
 }
 benchmark.warmSpeedup=benchmark.results.uncached.medianWallMs/benchmark.results.warm.medianWallMs;
 benchmark.editedSpeedup=benchmark.results.uncached.medianWallMs/benchmark.results.edited.medianWallMs;
 assert(benchmark.results.warm.samples.every(s=>s.cache.syntaxHits===12&&s.cache.compilationReused));
 assert(benchmark.results.edited.samples.every(s=>s.cache.syntaxHits===11&&s.cache.incrementalParses===1&&s.cache.compilationReused));
 console.log(`Real WASM Roslyn median: uncached ${benchmark.results.uncached.medianWallMs.toFixed(1)} ms, warm ${benchmark.results.warm.medianWallMs.toFixed(1)} ms, edit ${benchmark.results.edited.medianWallMs.toFixed(1)} ms`);
});
const report={testedAt:new Date().toISOString(),environment:'Actual .NET 10 browser-wasm runtime hosted by Node',runtime:JSON.parse(bridge.Version()),passed:tests.filter(t=>t.status==='passed').length,failed:tests.filter(t=>t.status==='failed').length,tests,benchmark};
await writeFile(new URL('../docs/wasm-compilation-performance.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(`${report.passed} passed; ${report.failed} failed`);process.exit(report.failed?1:0);
