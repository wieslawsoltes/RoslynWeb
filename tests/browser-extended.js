import {createRoslyn} from '../src/index.js';
export async function runExtended({test,assert}) {
 let compiler;
 await test('Worker compiler boots independently from the page runtime',async()=>{compiler=await createRoslyn({baseUrl:new URL('../dist/',import.meta.url).href});assert(compiler.info.referenceCount>=160,'Missing references');});
 if(!compiler)return;
 const compile=async(source,options={})=>{const c=await compiler.compile(source,options);assert(c.success,JSON.stringify(c.error||c.diagnostics));return c;};
 await test('Worker compiles and runs real C#',async()=>{const c=await compile('using System;Console.WriteLine("worker");');const r=await compiler.run(c);assert(r.success&&r.stdout.trim()==='worker',JSON.stringify(r));});
 await test('Worker executes MSIL compiled to JavaScript',async()=>{const c=await compile('using System;public static class Program{public static void Main(){int n=0;for(int i=0;i<10;i++)n+=i;Console.WriteLine(n);}}');const r=await compiler.run(c,{backend:'javascript'});assert(r.success&&r.stdout.trim()==='45',JSON.stringify(r));});
 await test('Browser nupkg decompression and .NET execution',async()=>{const bytes=new Uint8Array(await(await fetch('./fixtures/newtonsoft.json.13.0.3.nupkg')).arrayBuffer());await compiler.importPackage(bytes);const c=await compile('using System;using Newtonsoft.Json;Console.WriteLine(JsonConvert.SerializeObject(new {Answer=42}));');const r=await compiler.run(c);assert(r.success&&r.stdout.trim()==='{"Answer":42}',JSON.stringify(r));});
 await test('Lossless Int64 argument and result through worker',async()=>{const c=await compile('public static class Api{public static long Echo(long value)=>value;}',{outputKind:'library'});const r=await compiler.invoke(c.assemblyId,'Api','Echo',[9007199254740993n]);assert(r.success&&r.result===9007199254740993n,'Lossy integer result');});
 await test('Timeout terminates a runaway worker',async()=>{const c=await compile('public static class Program{public static void Main(){while(true){}}}');let failed=false;try{await compiler.run(c,{timeoutMs:100});}catch(e){failed=e.code==='TIMEOUT';}assert(failed&&compiler.disposed,'Worker did not terminate');});
 compiler.dispose();
}
