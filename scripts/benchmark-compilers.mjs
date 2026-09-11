// Reproducible compiler-phase and execution measurements; no machine-independent claims.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import {compileWasm, loadWasm} from '../src/wasm/index.js';
import {compileJavaScriptModule, generateModule} from '../src/il/compiler.mjs';
import {createRoslyn} from '../src/browser.js';

const source = `public static class CompilerBenchmark {
  public static int Polynomial(int count) { int sum = 0; for (int i = 0; i < count; i++) sum = unchecked(sum + i * (i + 1)); return sum; }
  public static long WidePolynomial(int count) { long sum = 0; for (int i = 0; i < count; i++) sum += (long)i * (i + 1); return sum; }
  public static int Fibonacci(int n) => n < 2 ? n : Fibonacci(n - 1) + Fibonacci(n - 2);
}`;
const sourceOptions = {outputKind: 'library', optimization: 'release', emitPdb: false, assemblyName: 'CompilerBenchmark'};
const report = {
  measuredAt: new Date().toISOString(),
  environment: {node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalProcessors: cpus().length},
  methodology: 'The bundled .NET WebAssembly Roslyn compiles the same genuine C# into one PE. Both JavaScript and native Wasm consume its unchanged inspector model. Uncached IL emission, JS function construction, WebAssembly engine compilation, instantiation, public compilation caches, generated code sizes and execution are reported separately. Execution samples alternate configurations after warm-up and validate every aggregate result. Timings are wall-clock measurements in this environment; same-byte WebAssembly.compile may benefit from V8 internal caching. The initial runtime startup includes filesystem loading under Node, not browser network transfer.',
  source, sourceSha256: createHash('sha256').update(source).digest('hex'), phases: {}, backends: {},
};
const summarize = values => ({samples: values.length, firstMs: values[0], minimumMs: Math.min(...values), medianMs: [...values].sort((a,b)=>a-b)[Math.floor(values.length / 2)], maximumMs: Math.max(...values), totalMs: values.reduce((a,b)=>a+b,0)});
async function measure(name, count, action) {
  const values = []; let result;
  for (let i=0;i<count;i++) { const start=performance.now(); result=await action(i); values.push(performance.now()-start); }
  report.phases[name]=summarize(values);
  console.log(`${name}: ${report.phases[name].medianMs.toFixed(3)} ms median (${count} samples)`);
  return result;
}
function codeSectionBytes(bytes) {
  let at=8;
  const unsigned=()=>{let n=0,shift=0,byte;do{byte=bytes[at++];n+=(byte&127)*2**shift;shift+=7;}while(byte&128);return n;};
  while(at<bytes.length){const id=bytes[at++],length=unsigned();if(id===10)return length;at+=length;}
  return 0;
}
const success=value=>{assert.equal(value.success,true,JSON.stringify(value.error??value.diagnostics));return value;};
let compiler;
const programs=[];
try {
  compiler=await measure('roslynRuntimeStartup',1,()=>createRoslyn({worker:false,baseUrl:new URL('../dist/',import.meta.url).href}));
  report.managedRuntime=compiler.info;
  const pe=success(await measure('firstCSharpToPE',1,()=>compiler.compile(source,{...sourceOptions,useCompilationCache:false})));
  report.peBytes=pe.pe.length; report.firstRoslynPerformance=pe.performance;
  const model=await measure('inspectPE',5,()=>compiler.inspect(pe));
  for (const optimize of [false,'blocks',true]) {
    const label=optimize==='blocks'?'blocks':optimize?'optimized':'reference';
    const jsSource=await measure(`javascript.${label}.emitESModule`,7,()=>generateModule(model,{strict:true,optimize}));
    const blueprint=await measure(`javascript.${label}.emitAndConstructFunctions`,7,()=>compileJavaScriptModule(model,{strict:true,optimize}));
    const js=await measure(`javascript.${label}.instantiateFreshRuntime`,7,()=>blueprint.createRuntime());
    const jsKey=`javascript.${label}`;
    report.backends[jsKey]={optimization:blueprint.optimization,esModuleUtf8Bytes:Buffer.byteLength(jsSource),generatedMethodUtf8Bytes:Object.values(blueprint.compiledMethods).reduce((size,fn)=>size+Buffer.byteLength(String(fn)),0)};
    programs.push({key:jsKey,runtime:js});
    if(optimize==='blocks')continue;
    const emitted=await measure(`wasm.${label}.emitBinary`,7,()=>compileWasm(model,{optimize}));
    assert.equal(WebAssembly.validate(emitted.bytes),true);
    const module=await measure(`wasm.${label}.engineCompileSameBytes`,7,()=>WebAssembly.compile(emitted.bytes));
    assert.deepEqual(WebAssembly.Module.imports(module),[]);
    const wasm=await measure(`wasm.${label}.instantiateModule`,7,()=>loadWasm(module));
    const wasmKey=`wasm.${label}`;
    report.backends[wasmKey]={optimization:emitted.optimization,wasmBytes:emitted.bytes.length,nativeCodeSectionBytes:codeSectionBytes(emitted.bytes),moduleImports:WebAssembly.Module.imports(module)};
    programs.push({key:wasmKey,runtime:wasm});
  }
  const workloads=[
    {method:'Polynomial',argument:500,calls:200,expected:41666500},
    {method:'WidePolynomial',argument:500,calls:200,expected:41666500n},
    {method:'Fibonacci',argument:12,calls:200,expected:144},
  ];
  report.workloads=workloads.map(item=>({...item,expected:String(item.expected),resultType:typeof item.expected==='bigint'?'System.Int64':'System.Int32'}));
  for(const workload of workloads) {
    const nativeResult=await compiler.invoke(pe.assemblyId,'CompilerBenchmark',workload.method,[workload.argument]);
    assert.equal(nativeResult.success, true, JSON.stringify(nativeResult,(_key,value)=>typeof value==='bigint'?value.toString():value));
    const referenceValue=nativeResult.result?.value ?? nativeResult.result;
    assert.equal(String(referenceValue),String(workload.expected));
    // Managed reflection uses tagged Int64 values; retain the complete independent check evidence.
    report.workloads.find(item=>item.method===workload.method).managedReference=nativeResult;
    for(const program of programs) for(let i=0;i<25;i++) assert.equal(program.runtime.invoke(`CompilerBenchmark::${workload.method}`,[workload.argument]),workload.expected);
    const times=new Map(programs.map(program=>[program.key,[]]));
    for(let sample=0;sample<7;sample++) for(let offset=0;offset<programs.length;offset++) {
      const program=programs[(sample+offset)%programs.length];
      let total=typeof workload.expected==='bigint'?0n:0;
      const start=performance.now();
      for(let i=0;i<workload.calls;i++) total+=program.runtime.invoke(`CompilerBenchmark::${workload.method}`,[workload.argument]);
      times.get(program.key).push(performance.now()-start);
      const calls=typeof total==='bigint'?BigInt(workload.calls):workload.calls;
      assert.equal(total,workload.expected*calls);
    }
    for(const [key,values] of times) {
      const phase=`${key}.execute.${workload.method}`;
      report.phases[phase]=summarize(values);
      console.log(`${phase}: ${report.phases[phase].medianMs.toFixed(3)} ms median`);
    }
  }
  await compiler.compile(source,sourceOptions);
  const cachedPE=success(await measure('cachedRoslynCSharpToPE',7,()=>compiler.compile(source,sourceOptions)));
  report.cachedRoslynPerformance=cachedPE.performance;
  for(const [method,kind] of [['compileToJavaScript','javascript'],['compileToWasm','wasm']]) {
    assert.equal(typeof compiler[method],'function',`${method} public API is required`);
    const options={...sourceOptions,assemblyName:`CompilerBenchmark_${kind}`};
    const initial=success(await measure(`public.${kind}.firstPipeline`,1,()=>compiler[method](source,options)));
    const cached=success(await measure(`public.${kind}.cachedPipeline`,7,()=>compiler[method](source,options)));
    assert.equal(cached.cache.emitHit,true);
    report.backends[`${kind}.public`]={firstTimings:initial.timings,cachedTimings:cached.timings,cache:cached.cache};
  }
  report.passed=true;
} catch(error) {
  report.passed=false;report.error={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;console.error(error);
} finally {
  for(const program of programs) program.runtime.dispose?.();
  compiler?.dispose();
  await writeFile(new URL('../docs/compiler-performance-v6.json',import.meta.url),JSON.stringify(report,(_key,value)=>typeof value==='bigint'?value.toString():value,2)+'\n');
}
