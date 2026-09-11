import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/index.js';
import {NodeBrowserWorker} from './worker-adapter.mjs';
import {compilerExtensionSource,workflowExamples,projectFiles} from '../demo/workflows.js';
import {NativeModuleRegistry} from '../src/hosting/index.js';
const previousWorker=globalThis.Worker;globalThis.Worker=NodeBrowserWorker;
const records=[];let compiler;
async function test(name,action){const start=performance.now();try{await action();records.push({name,passed:true,ms:Math.round(performance.now()-start)});console.log('PASS',name);}catch(error){records.push({name,passed:false,error:error.message});console.error('FAIL',name,error);}}
const success=r=>{assert.equal(r.success,true,JSON.stringify(r.error||r.diagnostics));return r;};
const compile=async(source,options={})=>success(await compiler.compile(source,{compilerExtensions:[],enableGenerators:false,enableAnalyzers:false,...options}));
try{
compiler=await createRoslyn({baseUrl:new URL('../dist/',import.meta.url),startupTimeoutMs:120000,timeoutMs:60000});
await test('Public API compiles and loads real analyzer/generator DLL in a Worker',async()=>{
 for(const name of ['Microsoft.CodeAnalysis.dll','Microsoft.CodeAnalysis.CSharp.dll'])await compiler.addReference(name,new Uint8Array(await readFile(new URL('../dist/compiler-references/'+name,import.meta.url))));
 const extension=await compile(compilerExtensionSource,{assemblyName:'DemoCompilerExtensions',outputKind:'library'});
 await compiler.addCompilerExtension('DemoCompilerExtensions.dll',extension.pe);
 const entries=await compiler.compilerExtensions();assert.ok(JSON.stringify(entries).includes('GreetingGenerator'));
});
await test('Demo incremental generator produces compilable C# and analyzer diagnostics',async()=>{
 const assembly=success(await compiler.compile(workflowExamples.find(x=>x.kind==='extensions').source,{compilerExtensions:['DemoCompilerExtensions']}));
 assert.ok(assembly.generatedSources.some(s=>(s.text||s.source).includes('GeneratedValues')));
 assert.ok(assembly.diagnostics.some(d=>d.id==='LAB001'&&d.severity==='warning'));
 const r=success(await compiler.run(assembly));assert.match(r.stdout,/Hello from a real Roslyn source generator!/);
});
await test('Editorconfig can promote analyzer diagnostics to errors',async()=>{
 const assembly=await compiler.compile(workflowExamples.find(x=>x.kind==='extensions').source,{compilerExtensions:['DemoCompilerExtensions'],analyzerConfigFiles:[{path:'/.editorconfig',text:'root = true\n[*.cs]\ndotnet_diagnostic.LAB001.severity = error'}]});
 assert.equal(assembly.success,false);assert.ok(assembly.diagnostics.some(d=>d.id==='LAB001'&&d.severity==='error'));assert.equal(assembly.pe,undefined);
});
await test('Build .csproj, imported targets and generated source inside WASM',async()=>{
 const source=workflowExamples.find(x=>x.kind==='project').source;
 const build=await compiler.buildProject({projectPath:'Demo.csproj',files:projectFiles(source),restore:false});
 success(build);assert.ok(build.compileResult.pe.length>512);assert.ok([...build.generatedFiles.keys()].some(path=>path.endsWith('obj/Generated.cs')));
 const result=success(await compiler.run(build.compileResult));assert.match(result.stdout,/Built from a .csproj inside the browser\.\n42/);
});
await test('Persistent CLR object handles support properties, optional and generic methods',async()=>{
 const assembly=await compile('public class Counter {public int Value {get;set;} public Counter(int n){Value=n;} public int Add(int n=1)=>Value+=n; public T Echo<T>(T value)=>value;}',{outputKind:'library'});
 const obj=await compiler.createObject(assembly.assemblyId,'Counter',[10]);assert.ok(obj.$handle);
 await compiler.setProperty(obj,'Value',20);assert.equal(await compiler.getProperty(obj,'Value'),20);
 assert.equal(success(await compiler.invokeObject(obj,'Add',[22])).result,42);
 assert.equal(success(await compiler.invokeObject(obj,'Add')).result,43);
 assert.equal(success(await compiler.invokeObject(obj,'Echo',['generic'],{genericArguments:['string']})).result,'generic');
 await compiler.releaseObject(obj);await assert.rejects(compiler.getProperty(obj,'Value'),/handle/i);
});
await test('Runtime generated C# functions preserve Int64 and evaluate expressions',async()=>{
 const fn=success(await compiler.compileFunction({name:'Multiply',returnType:'long',parameters:[{name:'value',type:'long'},{name:'factor',type:'long'}],body:'return checked(value * factor);',compileOptions:{compilerExtensions:[]}}));
 assert.equal(success(await fn.invoke(9007199254740993n,2n)).result,18014398509481986n);
 assert.equal(success(await compiler.evaluate('value + 2',{returnType:'int',parameters:[{name:'value',type:'int'}],arguments:[40],compileOptions:{compilerExtensions:[]}})).result,42);
});
await test('Generic methods and separate generic static fields execute as JavaScript',async()=>{
 const c=await compile('using System; public class Box<T>{public static int Value; public T Item; public Box(T item){Item=item;}} public class Program { public static T Echo<T>(T x)=>x; public static void Main(){Box<int>.Value=20;Box<string>.Value=22;Console.WriteLine(Box<int>.Value+Box<string>.Value);Console.WriteLine(Echo<string>("generic"));}}');
 const r=success(await compiler.run(c,{backend:'javascript'}));assert.equal(r.stdout.trim(),'42\ngeneric');
});
await test('Actual DllImport metadata maps to an explicitly supplied native WASM export',async()=>{
 const wasm=new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);
 const registry=new NativeModuleRegistry();await registry.register('native',wasm);
 registry.bind({library:'native',entryPoint:'add',managed:{type:'Native',name:'Add',parameters:['System.Int32','System.Int32']},parameters:['i32','i32'],result:'i32'});
 const c=await compile('using System;using System.Runtime.InteropServices;public static class Native{[DllImport("native",EntryPoint="add")]public static extern int Add(int a,int b);}public static class Program{public static void Main()=>Console.WriteLine(Native.Add(20,22));}');
 const r=success(await compiler.run(c,{backend:'javascript',externals:registry.externals}));assert.equal(r.stdout.trim(),'42');registry.dispose();
});
await test('C# browser UI model and event method round-trip through the Worker',async()=>{
 const c=await compile(workflowExamples.find(x=>x.kind==='desktop').source,{outputKind:'library'});
 const model=success(await compiler.invoke(c.assemblyId,'DesktopDemo','Model')).result;assert.equal(model.title,'Managed counter');assert.equal(model.value,0);
 assert.equal(success(await compiler.invoke(c.assemblyId,'DesktopDemo','Increment',[model.value])).result,1);
});
}catch(error){records.push({name:'startup',passed:false,error:error.message});console.error(error);}
finally{
 compiler?.dispose();for(const worker of NodeBrowserWorker.instances)worker.terminate();await Promise.all(NodeBrowserWorker.instances.map(w=>w.termination));
 if(previousWorker===undefined)delete globalThis.Worker;else globalThis.Worker=previousWorker;
 const report={testedAt:new Date().toISOString(),environment:'Actual .NET browser-wasm in Node Worker, unmodified browser worker protocol',browserEngineValidated:false,passed:records.filter(r=>r.passed).length,failed:records.filter(r=>!r.passed).length,tests:records};
 await writeFile(new URL('../docs/compatibility-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(`${report.passed} passed; ${report.failed} failed`);process.exitCode=report.failed?1:0;
}
