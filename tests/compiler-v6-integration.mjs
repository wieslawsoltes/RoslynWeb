// Actual .NET WASM Roslyn and the browser Worker protocol, with both compiler backends.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/browser.js';
import {loadWasm} from '../src/wasm/index.js';
import {NodeBrowserWorker} from '../scripts/worker-adapter.mjs';

const originalWorker=globalThis.Worker;
globalThis.Worker=NodeBrowserWorker;
const checks=[];
let compiler;
const ok=result=>{assert.equal(result.success,true,JSON.stringify(result.error??result.diagnostics));return result;};
async function check(name,action){const start=performance.now();const evidence=await action();checks.push({name,passed:true,milliseconds:performance.now()-start,evidence});console.log('PASS',name);}
const timeout=setTimeout(()=>{for(const worker of NodeBrowserWorker.instances)worker.terminate();process.exitCode=1;console.error('Compiler v6 integration exceeded 180 seconds.');},180000);
let portableJavaScript,portableWasm;
try {
  await check('Initialize real Roslyn in a browser-protocol Worker',async()=>{
    compiler=await createRoslyn({baseUrl:new URL('../dist/',import.meta.url).href,startupTimeoutMs:90000});
    assert.match(compiler.info.roslynVersion,/^5\./);return compiler.info;
  });
  await check('One-call JavaScript pipeline returns real PE, generated source and cache reuse',async()=>{
    const source='public static class PortableJsV6 { static int count; public static int Next()=>++count; public static int Sum(int n){int sum=0;for(int i=0;i<n;i++)sum+=i*(i+1);return sum;} }';
    const options={outputKind:'library',assemblyName:'PortableJsV6',javascript:{runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href}};
    const first=ok(await compiler.compileToJavaScript(source,options));
    portableJavaScript=ok(await compiler.compileToJavaScript(source,options));
    assert.equal(portableJavaScript.format,'javascript');assert.deepEqual([...first.assembly.pe.slice(0,2)],[77,90]);
    assert.equal(portableJavaScript.cache.emitHit,true);assert.equal(first.source,portableJavaScript.source);
    assert.equal(first.assembly.pdb,undefined);assert.equal(first.assembly.inspection,undefined);
    const reference=ok(await compiler.compileToJavaScript(source,{...options,javascript:{...options.javascript,optimize:false}}));
    assert.equal(reference.cache.emitHit,false);assert.equal(reference.optimization.enabled,false);
    assert(portableJavaScript.optimization.numericMethods>=1);
    return{cache:portableJavaScript.cache,optimization:portableJavaScript.optimization,peBytes:first.assembly.pe.length};
  });
  await check('Wasm optimization changes native code while preserving an import-free module',async()=>{
    const source='public static class PortableWasmV6 { public static int Sum(int n){int sum=0;for(int i=0;i<n;i++)sum+=i*(i+1);return sum;} }';
    const options={outputKind:'library',assemblyName:'PortableWasmV6'};
    const reference=ok(await compiler.compileToWasm(source,{...options,wasm:{optimize:false}}));
    portableWasm=ok(await compiler.compileToWasm(source,{...options,wasm:{optimize:true}}));
    assert.equal(reference.optimization.enabled,false);assert.equal(portableWasm.optimization.enabled,true);
    assert(portableWasm.optimization.structuredMethods>=1);
    assert(portableWasm.optimization.functionBodyBytes<reference.optimization.functionBodyBytes);
    const module=await WebAssembly.compile(portableWasm.bytes);assert.deepEqual(WebAssembly.Module.imports(module),[]);
    return{reference:reference.optimization,optimized:portableWasm.optimization};
  });
  for(const backend of ['javascript','native-wasm'])for(const optimize of [false,true])await check(`${backend} optimize=${optimize} executes exact values and first-pass filters inside its Worker`,async()=>{
    const source='using System; public static class CombinedV6 { static int state; static bool Match(){state=state*10+1;return true;} static void Throw(){try{throw new InvalidOperationException();}finally{state=state*10+3;}} public static void Main(){decimal a=.1m,b=.2m;Console.WriteLine(a+b);int? n=42;Console.WriteLine(n.Value);var original=(3,7);var copy=original;copy.Item1=99;Console.WriteLine(original.ToString());try{Throw();}catch(InvalidOperationException)when(Match()){Console.WriteLine(state*10+4);}}}';
    const options={assemblyName:'CombinedV6_'+backend.replace('-','_')+'_'+optimize};
    const artifact=ok(backend==='javascript'?await compiler.compileToJavaScript(source,{...options,javascript:{optimize}}):await compiler.compileToWasm(source,{...options,wasm:{optimize}}));
    const first=ok(await compiler.run(artifact)),second=ok(await compiler.run(artifact));
    assert.equal(first.backend,backend);assert.equal(first.stdout,'0.3\n42\n(3, 7)\n134\n');
    assert.equal(second.stdout,first.stdout,'Reusable compiled code must create independent static state per run');
    if(backend==='javascript'&&optimize)for(const mismatch of ['wasm','native-wasm','auto'])await assert.rejects(compiler.run(artifact,{backend:mismatch}),error=>error.code==='JAVASCRIPT_BACKEND_MISMATCH');
    return{stdout:first.stdout,backend:first.backend,optimization:artifact.optimization};
  });
  await check('Both compiler pipelines automatically link a registered managed implementation DLL',async()=>{
    const dependency=ok(await compiler.compile('public static class LinkedV6 { public static int Add(int a,int b)=>a+b; }',{outputKind:'library',assemblyName:'LinkedV6'}));
    await compiler.addDll('LinkedV6.dll',dependency.pe);
    const source='public static class LinkedMainV6 { public static void Main()=>System.Console.WriteLine(LinkedV6.Add(20,22)); }';
    const results=[];
    for(const backend of ['javascript','native-wasm']){
      const options={assemblyName:'LinkedMainV6_'+backend.replace('-','_')};
      const artifact=ok(backend==='javascript'?await compiler.compileToJavaScript(source,options):await compiler.compileToWasm(source,options));
      const result=ok(await compiler.run(artifact));assert.equal(result.stdout,'42\n');results.push({backend,stdout:result.stdout});
    }
    return results;
  });
  await check('Cached JavaScript PE execution isolates virtual filesystem snapshots',async()=>{
    const pe=ok(await compiler.compile('System.IO.File.WriteAllText("out.txt",System.IO.File.ReadAllText("in.txt"));'));
    for(const input of ['first','second']){const result=ok(await compiler.run(pe,{backend:'javascript',virtualFiles:{'in.txt':input},captureVirtualFiles:true}));assert.equal(new TextDecoder().decode(result.virtualFiles['/out.txt']),input);}
    return{inputs:['first','second'],independent:true};
  });
  await check('The rebuilt inspector links explicit constrained interface methods through both Worker pipelines',async()=>{
    const source='using System; interface I { int Read(); } struct S:I { int I.Read()=>42; } class P {static int Read<T>(T v) where T:I=>v.Read(); static int Main(){try{throw new Exception();}catch(Exception)when(Read(new S())==42){decimal n=0.1m+0.2m; int? x=42; var pair=(n,x); Console.WriteLine(pair.Item1.ToString()); return pair.Item2.Value;}}}';
    for(const method of ['compileToJavaScript','compileToWasm']){const artifact=ok(await compiler[method](source));const result=ok(await compiler.run(artifact));assert.equal(result.exitCode,42);assert.equal(result.stdout.trim(),'0.3');}
    return{exitCode:42,stdout:'0.3'};
  });
  await check('Invalid C# returns diagnostics and leaves both compiler pipelines reusable',async()=>{
    const results=[];
    for(const method of ['compileToJavaScript','compileToWasm']){
      const result=await compiler[method]('public class Broken { int value = "wrong"; }',{outputKind:'library'});
      assert.equal(result.success,false);assert.equal(result.stage,'csharp');assert(result.diagnostics.some(item=>item.id==='CS0029'||item.code==='CS0029'));
      await assert.rejects(compiler.run(result),error=>error.code==='COMPILE_FAILED');
      const fixed=ok(await compiler[method]('public static class Fixed { public static int Answer()=>42; }',{outputKind:'library'}));results.push({method,format:fixed.format});
    }
    return results;
  });
  await check('Both public compiler pipelines retain exact NaN literal sign and payload from the real PE',async()=>{
    const source='using System; public static class LiteralBitsV6 { public static void Main(){Console.WriteLine(BitConverter.DoubleToInt64Bits(double.NaN));Console.WriteLine(BitConverter.SingleToInt32Bits(float.NaN));} }';
    const assembly=ok(await compiler.compile(source,{assemblyName:'LiteralBitsV6Oracle',optimization:'release',emitPdb:false,includeInspection:true}));
    const constants=assembly.inspection.types.flatMap(type=>type.methods).flatMap(method=>method.body??[]).filter(instruction=>instruction.opcode==='ldc.r4'||instruction.opcode==='ldc.r8');
    assert.deepEqual(constants.map(instruction=>instruction.operandBits),['fff8000000000000','ffc00000']);
    const oracle=ok(await compiler.run(assembly,{backend:'wasm'}));
    assert.equal(oracle.stdout,'-2251799813685248\n-4194304\n');
    const results=[];
    for(const method of ['compileToJavaScript','compileToWasm']){
      const artifact=ok(await compiler[method](source,{assemblyName:'LiteralBitsV6_'+method}));
      const result=ok(await compiler.run(artifact));assert.equal(result.stdout,oracle.stdout);
      results.push({method,stdout:result.stdout});
    }
    return {operandBits:constants.map(instruction=>instruction.operandBits),results};
  });
  await check('Saved JavaScript and native Wasm remain executable after the Roslyn Worker is disposed',async()=>{
    compiler.dispose();assert.equal(compiler.disposed,true);
    await assert.rejects(compiler.compileToJavaScript('return 42;'),error=>error.code==='DISPOSED');
    const js=await import('data:text/javascript;base64,'+Buffer.from(portableJavaScript.source).toString('base64'));
    const first=js.createAssembly(),second=js.createAssembly();
    assert.equal(first.invoke('PortableJsV6::Sum',[100]),333300);
    assert.deepEqual([first.invoke('PortableJsV6::Next'),first.invoke('PortableJsV6::Next'),second.invoke('PortableJsV6::Next')],[1,2,1]);
    const wasm=await loadWasm(portableWasm.bytes);
    try{assert.equal(wasm.invoke('PortableWasmV6::Sum',[100]),333300);return{javascript:333300,wasm:333300,independentStatics:[1,2,1]};}
    finally{wasm.dispose();}
  });
  await check('JavaScript instruction limits fail without poisoning reusable compiled functions',async()=>{
    compiler=await createRoslyn({baseUrl:new URL('../dist/',import.meta.url).href});
    const artifact=ok(await compiler.compileToJavaScript('int n=0;for(int i=0;i<100;i++)n+=i;return n;'));
    assert.equal((await compiler.run(artifact,{maxInstructions:10})).success,false);
    assert.equal(ok(await compiler.run(artifact)).exitCode,4950);return{recoveredExitCode:4950};
  });
  await check('A runaway generated JavaScript program is terminated by its Worker timeout',async()=>{
    const artifact=ok(await compiler.compileToJavaScript('while(true){}'));
    await assert.rejects(compiler.run(artifact,{maxInstructions:1e15,timeoutMs:100}),error=>error.code==='TIMEOUT');
    assert.equal(compiler.disposed,true);return{errorCode:'TIMEOUT',disposed:true};
  });
}catch(error){checks.push({name:'Failure',passed:false,error:{message:error.message,stack:error.stack}});process.exitCode=1;console.error(error);}
finally{
  clearTimeout(timeout);compiler?.dispose();for(const worker of NodeBrowserWorker.instances)worker.terminate();await Promise.all(NodeBrowserWorker.instances.map(worker=>worker.termination));if(originalWorker===undefined)delete globalThis.Worker;else globalThis.Worker=originalWorker;
  await writeFile(new URL('../docs/compiler-v6-worker-verification.json',import.meta.url),JSON.stringify({testedAt:new Date().toISOString(),checks,passed:checks.every(check=>check.passed)},null,2)+'\n');
  console.log(`${checks.filter(check=>check.passed).length} compiler v6 Worker checks passed`);
}
