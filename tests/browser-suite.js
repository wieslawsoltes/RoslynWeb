import { bootManaged } from '../src/host.js';
const status = document.querySelector('#status'), list = document.querySelector('#results'), detail = document.querySelector('#detail');
const failures = []; let passed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, action) { const li = document.createElement('li'); list.append(li); li.textContent = name + '…'; try { await action(); passed++; li.className = 'pass'; li.textContent = 'PASS · ' + name; } catch (e) { li.className = 'fail'; li.textContent = 'FAIL · ' + name + ': ' + e.message; failures.push({ name, error: e.message, stack: e.stack }); } }
try {
 const host = await bootManaged({ baseUrl: new URL('../dist/', import.meta.url).href }, e => { if(e.type === 'progress') status.textContent = e.message; });
 detail.textContent = JSON.stringify(host.info, null, 2);
 let seq = 0;
 const compile = async (text, options = {}) => {
   const r = await host.call('Compile', [JSON.stringify({ assemblyName: 'Verification' + (++seq), sources: [{ path: 'Program.cs', text }], outputKind: 'console', emitPdb: true, includeInspection: true, ...options })]);
   assert(r.success, JSON.stringify(r.diagnostics)); return r;
 };
 const run = async (code, expected, options = {}) => { const c = await compile(code, options); const r = await host.call('Run', [c.peBase64, '[]']); assert(r.success, JSON.stringify(r.error)); assert(r.stdout.trim() === expected, 'Output: ' + r.stdout); return c; };
 await test('Roslyn and reference assembly initialization', () => { assert(host.info.referenceCount > 100, 'Missing framework references'); });
 await test('Compile C# to PE DLL and portable PDB; execute entry point', async () => {
   const c = await run('using System; Console.WriteLine("Hello WASM");', 'Hello WASM'); assert(atob(c.peBase64).slice(0,2) === 'MZ', 'Not a PE file'); assert(atob(c.pdbBase64).slice(0,4) === 'BSJB', 'Not a portable PDB');
 });
 await test('Source diagnostics carry ID and source position', async () => { const r=await host.call('Compile',[JSON.stringify({sources:[{path:'Error.cs',text:'class Test { int a = "bad"; }'}],outputKind:'library'})]);assert(!r.success,'Should fail');assert(r.diagnostics.some(d=>d.id==='CS0029'&&d.path==='Error.cs'&&d.startLine===1),'Missing CS0029 location'); });
 await test('LINQ, records and generic collections', () => run('using System; using System.Linq; using System.Collections.Generic; var xs=new List<Item>{new(3),new(7)};Console.WriteLine(xs.Sum(x=>x.Value)); record Item(int Value);','10'));
 await test('Async/await, Task.Delay and finally', () => run('using System;using System.Threading.Tasks; await Task.Delay(10);try{throw new Exception("x");}catch(Exception){Console.WriteLine("caught");}finally{Console.WriteLine("finally");}','caught\nfinally'));
 await test('JSON serialization and reflection', () => run('using System;using System.Text.Json;Console.WriteLine(JsonSerializer.Serialize(new R(42)));Console.WriteLine(typeof(R).GetProperty("Answer").Name);record R(int Answer);','{"Answer":42}\nAnswer'));
 await test('Compile multiple source files and invoke static method', async () => {const c=await host.call('Compile',[JSON.stringify({assemblyName:'MultiFile',sources:[{path:'A.cs',text:'public static partial class MathApi { public static int Add(int a,int b)=>a+b; }'},{path:'B.cs',text:'public static partial class MathApi { public static string Name()=>"Math"; }'}],outputKind:'library'})]);assert(c.success,JSON.stringify(c.diagnostics));const r=await host.call('Invoke',[c.assemblyId,'MathApi','Add','[19,23]']);assert(r.success&&r.result===42,JSON.stringify(r));});
 await test('Compile DLL dependency, register metadata and runtime, execute consumer', async () => {const lib=await compile('namespace Library; public static class API { public static int Answer()=>42; }',{outputKind:'library',assemblyName:'Dependency'});await host.call('AddReference',['Dependency.dll',lib.peBase64]);await host.call('AddAssembly',['Dependency.dll',lib.peBase64]);await run('using System;Console.WriteLine(Library.API.Answer());','42');});
 await test('Real MSIL inspection includes instructions', async () => {const c=await compile('using System;public class Program{public static void Main(){Console.WriteLine(Add(2,3));}public static int Add(int a,int b)=>a+b;}');const m=await host.call('InspectAssembly',[c.peBase64]);const methods=m.methods||m.types?.flatMap(t=>t.methods)||[];assert(methods.some(m=>(m.instructions||m.body||[]).some(i=>(i.opCode||i.opcode||i.op)==='add')),'Missing add IL: '+JSON.stringify(m).slice(0,500));});
 await test('Runtime failures are structured and preserve stdout', async()=>{const c=await compile('using System;Console.WriteLine("before");throw new InvalidOperationException("expected failure");');const r=await host.call('Run',[c.peBase64,'[]']);assert(!r.success&&r.error?.message==='expected failure'&&r.stdout.includes('before'),JSON.stringify(r));});
 const { runExtended } = await import('./browser-extended.js');
 await runExtended({test,assert,host,compile,run});
 status.textContent = `${passed} passed · ${failures.length} failed · COMPLETE`;
 detail.textContent += '\n' + JSON.stringify(failures, null, 2);
 document.documentElement.dataset.complete = 'true';
 document.documentElement.dataset.failures = failures.length;
} catch(e) {status.textContent='BOOT FAILED'; detail.textContent=e.stack || e.message;document.documentElement.dataset.complete='true';document.documentElement.dataset.failures=String(failures.length+1);}
