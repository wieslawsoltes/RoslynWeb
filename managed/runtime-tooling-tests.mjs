import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {dotnet} from '../dist/_framework/dotnet.js';
const runtime = await dotnet.withDiagnosticTracing(false).create();
const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
const bridge = exports.RoslynBrowser.CompilerBridge;
const records=[];
const parse=JSON.parse;
async function test(name,action){const started=performance.now();try{await action();records.push({name,status:'passed',ms:Math.round(performance.now()-started)});console.log('PASS',name);}catch(error){records.push({name,status:'failed',message:error.message,stack:error.stack});console.error('FAIL',name,error.stack);}}
const compile=async(source,options={})=>{const result=parse(await bridge.CompileAsync(JSON.stringify({source,...options})));assert.equal(result.success,true,JSON.stringify(result.error||result.diagnostics));return result;};
await test('Real Roslyn compiler references registered lazily', async()=>{
 for(const name of ['Microsoft.CodeAnalysis','Microsoft.CodeAnalysis.CSharp']){
  const bytes=await readFile(new URL(`../dist/compiler-references/${name}.dll`,import.meta.url));
  const result=parse(bridge.AddReference(`${name}.dll`,bytes.toString('base64')));assert.equal(result.success,true,JSON.stringify(result));
 }
});
await test('Culture-specific assemblies preserve identities and resolve independently',async()=>{
 const neutral=await compile('[assembly:System.Reflection.AssemblyVersion("1.0.0.0")] public static class CultureApi { public static string Value()=>"neutral"; }',{outputKind:'library',assemblyName:'CultureDependency'});
 const polish=await compile('[assembly:System.Reflection.AssemblyVersion("1.0.0.0")][assembly:System.Reflection.AssemblyCulture("pl")] public static class CultureApi { public static string Value()=>"polish"; }',{outputKind:'library',assemblyName:'CultureDependency'});
 assert.equal(parse(bridge.AddAssembly('neutral/CultureDependency.dll',neutral.peBase64)).success,true);
 assert.equal(parse(bridge.AddAssembly('pl/CultureDependency.dll',polish.peBase64)).culture,'pl');
 const consumer=await compile('using System;using System.Reflection;Console.WriteLine(Assembly.Load("CultureDependency, Version=1.0.0.0, Culture=pl, PublicKeyToken=null").GetType("CultureApi")!.GetMethod("Value")!.Invoke(null,null));Console.WriteLine(Assembly.Load("CultureDependency, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null").GetType("CultureApi")!.GetMethod("Value")!.Invoke(null,null));');
 const result=parse(await bridge.Run(consumer.assemblyId,'[]'));assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.stdout.trim(),'polish\nneutral');
});
await test('PE-image run and assemblyId invocation share static state',async()=>{
 const assembly=await compile('public static class Stateful { public static int Value; public static void Main(){Value++;} public static int Read()=>Value; }');
 assert.equal(parse(await bridge.Run(assembly.peBase64,'[]')).success,true);
 const result=parse(await bridge.Invoke(assembly.assemblyId,'Stateful','Read','[]'));assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.result,1);
});
let extension;
await test('Compile generator/analyzer source inside actual browser WASM',async()=>{
 extension=await compile(await readFile(new URL('./SelfTest/CompilerExtensionFixture.cs.txt',import.meta.url),'utf8'),{assemblyName:'CompilerToolingFixture',outputKind:'library'});
 assert.equal(Buffer.from(extension.pdbBase64,'base64').subarray(0,4).toString(),'BSJB');
});
await test('Load and discover classic/incremental generators and diagnostic analyzer',async()=>{
 const result=parse(bridge.AddCompilerExtension('fixture',extension.peBase64));assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.generators.length,2);assert.equal(result.analyzers.length,1);
 assert.equal(parse(bridge.GetCompilerExtensions()).length,1);
});
const request={sources:[{path:'/src/Program.cs',text:'public class Example {} public static class Program { public static void Main() => System.Console.WriteLine(ClassicGenerated.Value + IncrementalGenerated.Value); }'}],additionalTexts:[{path:'/src/value.txt',text:'hello'}],analyzerOptions:{globalOptions:{'build_property.Suffix':'!'}},analyzerConfigFiles:[{path:'/.editorconfig',text:'root=true\n[*.cs]\ndotnet_diagnostic.BROWSER001.severity=warning'}],compilerExtensions:['fixture'],emitPdb:true};
let generated;
await test('Classic and incremental generators execute, analyzer reports diagnostics, PDB emitted',async()=>{
 generated=parse(await bridge.CompileAsync(JSON.stringify(request)));assert.equal(generated.success,true,JSON.stringify(generated.error||generated.diagnostics));assert.equal(generated.generatedSources.length,2);assert.ok(generated.analyzerDiagnostics.some(d=>d.id==='BROWSER001'));assert.ok(generated.pdbBase64.length>0);
});
await test('Generated C# executes inside WASM runtime',async()=>{const result=parse(await bridge.Run(generated.assemblyId,'[]'));assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.stdout.trim(),'hello!5');});
await test('Actual editorconfig error severity prevents publishing PE output',async()=>{
 const result=parse(await bridge.CompileAsync(JSON.stringify(request).replace('severity=warning','severity=error')));assert.equal(result.success,false,JSON.stringify(result));assert.ok(result.analyzerDiagnostics.some(d=>d.id==='BROWSER001'&&d.severity==='error'));assert.equal(result.peBase64,undefined);
});
await test('Actual editorconfig suppression prevents analyzer diagnostics',async()=>{
 const result=parse(await bridge.CompileAsync(JSON.stringify(request).replace('severity=warning','severity=none')));assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.analyzerDiagnostics.length,0);
});
await test('Compiler extension selector and execution flags disable extensions',async()=>{
 const result=await compile('public class Unchecked {}',{outputKind:'library',enableAnalyzers:false,enableGenerators:false});assert.equal(result.generatedSources.length,0);assert.equal(result.analyzerDiagnostics.length,0);
});
await test('Missing extension is an explicit compiler error',async()=>{
 const result=parse(await bridge.CompileAsync(JSON.stringify({source:'class A {}',outputKind:'library',compilerExtensions:['missing']})));assert.equal(result.success,false);assert.match(result.error.message,/not been registered/);
});
let objectAssembly,handle;
await test('Compile persistent CLR object and generic methods',async()=>{
 objectAssembly=await compile('public class Counter { public int Value {get;set;} public Counter(int value) {Value=value;} public int Add(int n) => Value+=n; public T Echo<T>(T value)=>value; public static T StaticEcho<T>(T value)=>value; public int Copy(Counter value)=>value.Value; public Counter Clone()=>new Counter(Value); public int Optional(int n=3)=>n; public void Mutate(ref int x){x+=Value;} }',{outputKind:'library',compilerExtensions:[]});
});
await test('Create persistent object handle',async()=>{const result=parse(await bridge.CreateObject(objectAssembly.assemblyId,'Counter','[10]','{}'));assert.equal(result.success,true,JSON.stringify(result));handle=result.result.$handle;assert.ok(handle);});
await test('Invoke object method preserves mutable state',async()=>{const result=parse(await bridge.InvokeObject(handle,'Add','[5]','{}'));assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.result,15);});
await test('Get and set CLR property',async()=>{assert.equal(parse(await bridge.GetProperty(handle,'Value')).result,15);assert.equal(parse(await bridge.SetProperty(handle,'Value','42')).success,true);assert.equal(parse(await bridge.GetProperty(handle,'Value')).result,42);});
await test('Invoke generic instance method',async()=>{const result=parse(await bridge.InvokeObject(handle,'Echo','["generic"]','{"genericArguments":["string"]}'));assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.result,'generic');});
await test('Invoke generic static method with explicit parameter signature',async()=>{const result=parse(await bridge.InvokeWithOptions(objectAssembly.assemblyId,'Counter','StaticEcho','[42]','{"genericArguments":["int"],"parameterTypes":["int"]}'));assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.result,42);});
await test('Pass object handle as managed method argument',async()=>{const result=parse(await bridge.InvokeObject(handle,'Copy',JSON.stringify([{$handle:handle}]),'{}'));assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.result,42);});
await test('Method return creates another persistent object handle',async()=>{const result=parse(await bridge.InvokeObject(handle,'Clone','[]','{"returnHandle":true}'));assert.equal(result.success,true,JSON.stringify(result));assert.ok(result.result.$handle);assert.equal(parse(await bridge.GetProperty(result.result.$handle,'Value')).result,42);assert.equal(parse(bridge.ReleaseObject(result.result.$handle)).success,true);});
await test('Optional arguments and ref argument output',async()=>{const optional=parse(await bridge.InvokeObject(handle,'Optional','[]','{}'));assert.equal(optional.result,3);const ref=parse(await bridge.InvokeObject(handle,'Mutate','[1]','{"includeArguments":true}'));assert.equal(ref.success,true,JSON.stringify(ref));assert.equal(ref.result.arguments[0],43);});
await test('Release object handle invalidates further access',async()=>{assert.equal(parse(bridge.ReleaseObject(handle)).success,true);assert.equal(parse(await bridge.GetProperty(handle,'Value')).success,false);});
const report={testedAt:new Date().toISOString(),environment:'Actual .NET 10 browser-wasm runtime hosted by Node',runtime:parse(bridge.Version()),passed:records.filter(r=>r.status==='passed').length,failed:records.filter(r=>r.status==='failed').length,tests:records};
await writeFile(new URL('../docs/wasm-tooling-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(`${report.passed} passed; ${report.failed} failed`);
process.exit(report.failed?1:0);
