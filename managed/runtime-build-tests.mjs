import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {dotnet} from '../dist/_framework/dotnet.js';
const runtime=await dotnet.withDiagnosticTracing(false).create();
const bridge=(await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName)).RoslynBrowser.CompilerBridge;
const parse=JSON.parse, records=[];
async function test(name,action){const t=performance.now();try{await action();records.push({name,status:'passed',ms:Math.round(performance.now()-t)});console.log('PASS',name);}catch(error){records.push({name,status:'failed',message:error.message,stack:error.stack});console.error('FAIL',name,error.stack);}}
const compile=async(source,options={})=>{const r=parse(await bridge.CompileAsync(JSON.stringify({source,compilerExtensions:[],...options})));assert.equal(r.success,true,JSON.stringify(r));return r;};
const task=async(assembly,type,request={})=>parse(await bridge.ExecuteBuildTask(assembly,type,JSON.stringify(request)));
let assembly, output;
await test('PE property metadata preserves accessors, static flags and index signatures',async()=>{
 const a=await compile('public class Properties {public int Value {get;set;} public static string Label=>"label";public int this[int index] {get=>Value+index;set=>Value=value-index;}}',{outputKind:'library',includeInspection:true});
 const properties=a.inspection.types.find(t=>t.name==='Properties').properties;
 const value=properties.find(p=>p.name==='Value');assert.equal(value.type,'System.Int32');assert.equal(value.getter.name,'get_Value');assert.equal(value.setter.name,'set_Value');assert.equal(value.isStatic,false);
 assert.equal(properties.find(p=>p.name==='Label').isStatic,true);assert.equal(properties.find(p=>p.name==='Item').parameters[0].type,'System.Int32');
});
await test('Register actual Microsoft.Build task compilation references',async()=>{
 for(const name of ['Microsoft.Build.Framework','Microsoft.Build.Utilities.Core']){
  const bytes=await readFile(new URL(`../dist/task-references/${name}.dll`,import.meta.url));
  assert.equal(parse(bridge.AddReference(name+'.dll',bytes.toString('base64'))).success,true);
 }
});
await test('Compile a genuine Microsoft.Build.Utilities.Task inside browser WASM',async()=>{
 assembly=await compile(await readFile(new URL('./SelfTest/BuildTaskFixture.cs.txt',import.meta.url),'utf8'),{assemblyName:'BrowserBuildTaskFixture',outputKind:'library'});
 assert.equal(Buffer.from(assembly.pdbBase64,'base64').subarray(0,4).toString(),'BSJB');
});
const request={parameters:{InputFile:'/app/value.txt',Factor:'6',Enabled:'true',Items:[{itemSpec:'source.cs',metadata:{Label:'metadata'}}]},files:[{path:'app/value.txt',base64:'Nw=='}],workingDirectory:'app',virtualPaths:true};
await test('Execute managed task with typed bool/int properties and virtual filesystem',async()=>{
 output=await task(assembly.assemblyId,'GenerateValue',request);assert.equal(output.success,true,JSON.stringify(output));assert.equal(output.outputs.Value,42);
});
await test('ITaskItem arrays, custom metadata and output path round-trip',async()=>{
 assert.equal(output.outputs.Label,'source.cs:metadata');assert.equal(output.outputs.Generated[0].itemSpec,'/app/obj/TaskGenerated.cs');assert.equal(output.outputs.Generated[0].metadata.Generator,'ManagedITask');
});
await test('Managed task warnings and messages use structured build diagnostics',async()=>{
 assert.ok(output.diagnostics.some(d=>d.id==='TASK001'&&d.severity==='warning'));assert.ok(output.diagnostics.some(d=>d.severity==='info'&&d.message.includes('42')));
});
await test('Task generated C# is transferred back, compiled and executed',async()=>{
 assert.equal(output.files.length,1);assert.equal(output.files[0].path,'app/obj/TaskGenerated.cs');
 const emitted=await compile(Buffer.from(output.files[0].base64,'base64').toString()+' public static class Program { public static void Main()=>System.Console.WriteLine(TaskGenerated.Value); }');
 const ran=parse(await bridge.Run(emitted.assemblyId,'[]'));assert.equal(ran.success,true,JSON.stringify(ran));assert.equal(ran.stdout.trim(),'42');
});
await test('Registered dependency identity resolves a task DLL',async()=>{
 assert.equal(parse(bridge.AddAssembly('tasks/BrowserBuildTaskFixture.dll',assembly.peBase64)).success,true);
 assert.equal((await task('BrowserBuildTaskFixture','BrowserTasks.GenerateValue',request)).success,true);
});
await test('Adjacent task dependency DLLs resolve from hydrated project files',async()=>{
 const dependency=await compile('namespace TaskDependency;public static class Values {public static int Get()=>73;}',{assemblyName:'TaskDependency',outputKind:'library'});
 assert.equal(parse(bridge.AddReference('TaskDependency.dll',dependency.peBase64)).success,true);
 const consumer=await compile('public class DependencyTask:Microsoft.Build.Utilities.Task {[Microsoft.Build.Framework.Output] public int Value {get;set;} public override bool Execute(){Value=TaskDependency.Values.Get();return true;}}',{outputKind:'library'});
 const r=await task(consumer.assemblyId,'DependencyTask',{files:[{path:'tools/TaskDependency.dll',base64:dependency.peBase64}]});assert.equal(r.success,true,JSON.stringify(r));assert.equal(r.outputs.Value,73);
});
await test('Required attribute validates task input',async()=>{
 const r=await task(assembly.assemblyId,'GenerateValue');assert.equal(r.success,false);assert.match(r.error.message,/Required task parameter 'InputFile'/);
});
await test('Unknown parameters are rejected before task execution',async()=>{
 const r=await task(assembly.assemblyId,'GenerateValue',{...request,parameters:{...request.parameters,Unknown:'value'}});assert.equal(r.success,false);assert.match(r.error.message,/no writable parameter 'Unknown'/);
});
await test('Logging an error fails a task that returned true',async()=>{
 const r=await task(assembly.assemblyId,'LoggedFailure');assert.equal(r.success,false);assert.ok(r.diagnostics.some(d=>d.severity==='error'));
});
await test('Task file deletions return removedFiles',async()=>{
 const r=await task(assembly.assemblyId,'DeleteInput',{parameters:{InputFile:'value.txt'},files:[{path:'value.txt',base64:'Nw=='}]});assert.equal(r.success,true,JSON.stringify(r));assert.deepEqual(r.removedFiles,['value.txt']);
});
await test('Input path traversal and file-byte limits reject invalid workspaces',async()=>{
 let r=await task(assembly.assemblyId,'GenerateValue',{files:[{path:'../outside.txt',base64:'Nw=='}]});assert.equal(r.success,false);assert.match(r.error.message,/escapes/);
 r=await task(assembly.assemblyId,'GenerateValue',{...request,maxFileBytes:0});assert.equal(r.success,false);assert.match(r.error.message,/exceed maxFileBytes/);
});
await test('Output selection returns only selected attributed properties',async()=>{
 const r=await task(assembly.assemblyId,'GenerateValue',{...request,outputProperties:['Value']});assert.equal(r.success,true,JSON.stringify(r));assert.deepEqual(r.outputs,{Value:42});
});
await test('RESX conversion produces genuine managed resources',async()=>{
 const r=parse(bridge.ConvertResx('<root><data name="Greeting"><value>Hello resource</value></data><data name="Number" type="System.Int32, System.Private.CoreLib"><value>42</value></data></root>'));
 assert.equal(r.success,true,JSON.stringify(r));assert.equal(Buffer.from(r.base64,'base64').readUInt32LE(),0xbeefcace);
 const emitted=await compile('using System;using System.Resources;using System.Reflection;var r=new ResourceManager("Values",Assembly.GetExecutingAssembly());Console.WriteLine(r.GetString("Greeting"));Console.WriteLine(r.GetObject("Number"));',{resources:[{name:'Values.resources',base64:r.base64}]});
 const ran=parse(await bridge.Run(emitted.assemblyId,'[]'));assert.equal(ran.success,true,JSON.stringify(ran));assert.equal(ran.stdout.trim(),'Hello resource\n42');
});
await test('Compile embeds raw resources, RESX and typed resource entries',async()=>{
 const emitted=await compile('using System;using System.IO;using System.Resources;using System.Reflection;var a=Assembly.GetExecutingAssembly();Console.WriteLine(new StreamReader(a.GetManifestResourceStream("Raw.txt")!).ReadToEnd());var r=new ResourceManager("Values",a);Console.WriteLine(r.GetObject("Value"));Console.WriteLine(((byte[])r.GetObject("Bytes")!)[1]);Console.WriteLine(r.GetObject("Flag"));Console.WriteLine(new ResourceManager("Labels",a).GetString("Label"));',{
  resources:[{name:'Raw.txt',base64:Buffer.from('raw').toString('base64'),isPublic:false},{name:'Values.resources',entries:[{name:'Value',type:'long',value:'9223372036854775807'},{name:'Bytes',type:'byte[]',value:'AQID'},{name:'Flag',type:'bool',value:true}]},{name:'Labels.resources',resx:'<root><data name="Label"><value>label</value></data></root>'}]
 });
 const ran=parse(await bridge.Run(emitted.assemblyId,'[]'));assert.equal(ran.success,true,JSON.stringify(ran));assert.equal(ran.stdout.trim(),'raw\n9223372036854775807\n2\nTrue\nlabel');
});
await test('CreateResources exposes a standalone typed .resources writer',async()=>{
 const r=parse(bridge.CreateResources(JSON.stringify([{name:'Value',type:'int',value:42}])));assert.equal(r.success,true,JSON.stringify(r));assert.equal(Buffer.from(r.base64,'base64').readUInt32LE(),0xbeefcace);
});
await test('Invalid duplicate manifest resource names produce compiler diagnostics',async()=>{
 const r=parse(await bridge.CompileAsync(JSON.stringify({source:'System.Console.WriteLine(1);',resources:[{name:'same',base64:'AA=='},{name:'same',base64:'AQ=='}]})));assert.equal(r.success,false);assert.ok(r.diagnostics?.some(d=>d.severity==='error'));
});
await test('Unsupported serialized resource values and external XML entities reject explicitly',async()=>{
 for(const xml of ['<root><data name="Bad" type="System.Drawing.Bitmap"><value>data</value></data></root>','<!DOCTYPE root [<!ENTITY leak SYSTEM "file:///secret">]><root><data name="Bad"><value>&leak;</value></data></root>'])assert.equal(parse(bridge.ConvertResx(xml)).success,false);
});
const report={testedAt:new Date().toISOString(),environment:'Actual .NET 10 browser-wasm runtime hosted by Node',runtime:parse(bridge.Version()),passed:records.filter(t=>t.status==='passed').length,failed:records.filter(t=>t.status==='failed').length,tests:records};
await writeFile(new URL('../docs/wasm-build-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(`${report.passed} passed; ${report.failed} failed`);process.exit(report.failed?1:0);
