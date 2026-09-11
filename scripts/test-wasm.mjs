import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRoslyn } from '../src/index.js';
import { examples } from '../demo/examples.js';
const example = name => { const item = examples.find(example => example.name === name); assert.ok(item, `Missing sample: ${name}`); return item.source; };
const records=[];let compiler;
async function test(name,fn){const started=performance.now();try{await fn();records.push({name,status:'passed',ms:Math.round(performance.now()-started)});console.log('PASS',name);}catch(e){records.push({name,status:'failed',message:e.message,stack:e.stack});console.error('FAIL',name,e.stack);}}
try {
 compiler=await createRoslyn({worker:false,baseUrl:new URL('../dist/',import.meta.url).href});
 console.log(JSON.stringify(compiler.info));
 const compile=async(code,options={})=>{const r=await compiler.compile(code,{includeInspection:true,...options});assert.equal(r.success,true,JSON.stringify(r.error||r.diagnostics));assert.ok(r.pe.length>0);return r;};
 const run=async(code,expected,backend='wasm')=>{const c=await compile(code);const r=await compiler.run(c,{backend});assert.equal(r.success,true,JSON.stringify(r.error));assert.equal(r.stdout.trim(),expected);return {c,r};};
 await test('Initialize actual .NET WebAssembly and Roslyn',()=>{assert.ok(compiler.info.referenceCount>=160);assert.match(compiler.info.runtimeVersion,/^10\./);assert.match(compiler.info.roslynVersion,/^5\./);});
 await test('Emit PE DLL and portable PDB from real C#',async()=>{const {c}=await run('using System;Console.WriteLine("Hello wasm");','Hello wasm');assert.equal(Buffer.from(c.pe).subarray(0,2).toString(),'MZ');assert.equal(Buffer.from(c.pdb).subarray(0,4).toString(),'BSJB');});
 await test('Precise Roslyn diagnostics',async()=>{const c=await compiler.compile([{path:'Invalid.cs',text:'public class Broken { int value = "oops"; }'}],{outputKind:'library'});assert.equal(c.success,false);assert.ok(c.diagnostics.some(d=>d.id==='CS0029'&&d.path==='Invalid.cs'&&d.startLine===1));});
 await test('Multiple source files, library output and JSON static invocation',async()=>{const c=await compile([{path:'Math.cs',text:'public static partial class Api {public static int Add(int a,int b)=>a+b;}'},{path:'Version.cs',text:'public static partial class Api {public static string Version()=>"1";}'}],{outputKind:'library'});const r=await compiler.invoke(c.assemblyId,'Api','Add',[20,22]);assert.equal(r.success,true,JSON.stringify(r.error));assert.equal(r.result,42);});
 await test('Compile referenced DLL and execute consumer',async()=>{const c=await compile('namespace Fixture;public static class Library{public static int Value()=>42;}',{outputKind:'library',assemblyName:'FixtureDependency'});await compiler.addDll('FixtureDependency.dll',c.pe);await run('using System;Console.WriteLine(Fixture.Library.Value());','42');});
 await test('Records, generics and LINQ',()=>run(example('LINQ & generics'),'Temperature: 23.15\nPressure: 101.10'));
 await test('Async Task Main and exception/finally',()=>run(example('Async & exceptions'),'Starting asynchronous work…\nCaught: FormatException\nFinally block executed.\nAsync work complete.'));
 await test('System.Text.Json and reflection',()=>run(example('JSON & reflection'),'{"Name":"Ada","Age":36}\nName = Ada\nAge = 36'));
 await test('Portable DLL binary metadata inspection',async()=>{const c=await compile(example('Algorithms → JavaScript'));const m=await compiler.inspect(c);const methods=m.types.flatMap(t=>t.methods);assert.ok(methods.some(m=>m.name==='Fibonacci'));assert.ok(methods.some(m=>(m.body||m.instructions||[]).some(i=>(i.opcode||i.opCode)==='add')));});
 await test('Run generated JavaScript from actual C# MSIL',()=>run(example('Algorithms → JavaScript'),'Array total:\n30\nFibonacci(12):\n144','javascript'));
 await test('JavaScript Console.Write preserves newline behavior',()=>run('using System;public class Program { public static void Main(){Console.Write("a");Console.Write("b");Console.WriteLine("c");}}','abc','javascript'));
 await test('JavaScript preserves Int64 precision and checked overflow',()=>run('using System;public class Program{public static void Main(){long n=9007199254740993L;Console.WriteLine(n+2L);try{int x=int.MaxValue;Console.WriteLine(checked(x+1));}catch(OverflowException){Console.WriteLine("overflow");}}}','9007199254740995\noverflow','javascript'));
 await test('Auto backend selects managed runtime for async code',async()=>{const {r}=await run('using System;using System.Threading.Tasks;await Task.Yield();Console.WriteLine(10);','10','auto');assert.equal(r.backend,'wasm');assert.ok(r.fallback);});
 await test('Generated ES module is executable independently of Roslyn',async()=>{const c=await compile('public static class Program {public static int Main()=>42;}');const r=await compiler.emitJavaScript(c,{runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href});const module=await import('data:text/javascript;base64,'+Buffer.from(r.source).toString('base64'));const executable=module.createAssembly();assert.equal(executable.run([]),42);});
 await test('Runtime exception preserves output and structured error',async()=>{const c=await compile('using System;Console.WriteLine("before");throw new InvalidOperationException("expected failure");');const r=await compiler.run(c);assert.equal(r.success,false);assert.equal(r.error.message,'expected failure');assert.equal(r.stdout.trim(),'before');});
 await test('Invalid DLL is rejected as an API error',()=>assert.rejects(compiler.addDll('bad.dll',new Uint8Array([1,2,3])),/image|PE|DOS|small|metadata/i));
 await test('Load official NuGet archive and execute Newtonsoft.Json',async()=>{const p=await compiler.importPackage(new Uint8Array(await readFile(new URL('../tests/fixtures/newtonsoft.json.13.0.3.nupkg',import.meta.url))));assert.equal(p.id.toLowerCase(),'newtonsoft.json');await run(example('NuGet: Newtonsoft.Json'),'Roslyn Browser\n{"Ready":true,"Answer":42}');});
 await test('Arguments and integer exit code',async()=>{const c=await compile('using System;public class Program{public static int Main(string[] args){Console.WriteLine(args[0]);return args.Length;}}');const r=await compiler.run(c,{args:['value','two']});assert.equal(r.stdout.trim(),'value');assert.equal(r.exitCode,2);});
 await test('Int64/UInt64 JSON invocation is lossless',async()=>{const c=await compile('public static class Api{public static long Echo(long value)=>value;public static ulong Unsigned(ulong value)=>value;}',{outputKind:'library'});const n=9007199254740993n;const r=await compiler.invoke(c.assemblyId,'Api','Echo',[n]);assert.equal(r.success,true,JSON.stringify(r.error));assert.equal(r.result,n);const u=18446744073709551615n;const q=await compiler.invoke(c.assemblyId,'Api','Unsigned',[u]);assert.equal(q.success,true,JSON.stringify(q.error));assert.equal(q.result,u);});
 await test('Auto chooses WASM for unvalidated builtin overloads',()=>run('using System;public static class Program{public static void Main(){Console.WriteLine(new string(\'x\',3));}}','xxx','auto'));
 await test('Dispose rejects further work',async()=>{compiler.dispose();await assert.rejects(compiler.compile(''),/disposed/i);});
} catch(e){console.error(e);records.push({name:'Initialization',status:'failed',message:e.message,stack:e.stack});}
finally {
 compiler?.dispose();
 const report={testedAt:new Date().toISOString(),environment:'Actual .NET browser-wasm runtime hosted by Node; no browser rendering claim',runtime:compiler?.info,passed:records.filter(r=>r.status==='passed').length,failed:records.filter(r=>r.status==='failed').length,tests:records};
 await mkdir(new URL('../docs/',import.meta.url),{recursive:true});await writeFile(new URL('../docs/wasm-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(`${report.passed} passed; ${report.failed} failed`);process.exitCode=report.failed?1:0;
}
