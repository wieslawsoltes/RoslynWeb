import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/index.js';
import {WasmCommandRegistry} from '../src/hosting/wasi.js';
import {fromBase64} from '../src/bytes.js';
import {NodeBrowserWorker} from '../scripts/worker-adapter.mjs';
const previousWorker=globalThis.Worker;globalThis.Worker=NodeBrowserWorker;
let compiler,taskAssembly,first;const cache=new Map(),records=[];
const ok=r=>{assert.equal(r.success,true,JSON.stringify(r.error || r.diagnostics));return r;};
async function test(name,action){const start=performance.now();try{await action();records.push({name,passed:true,ms:Math.round(performance.now()-start)});console.log('PASS',name);}catch(error){records.push({name,passed:false,error:error.message,stack:error.stack});console.error('FAIL',name,error);}}
try {
 compiler=await createRoslyn({baseUrl:new URL('../dist/',import.meta.url),startupTimeoutMs:120000,timeoutMs:60000});
 await test('Compile genuine MSBuild task using public Worker compiler',async()=>{
  for(const name of ['Microsoft.Build.Framework','Microsoft.Build.Utilities.Core'])await compiler.addReference(name+'.dll',new Uint8Array(await readFile(new URL(`../dist/task-references/${name}.dll`,import.meta.url))));
  taskAssembly=ok(await compiler.compile(await readFile(new URL('../managed/SelfTest/BuildTaskFixture.cs.txt',import.meta.url),'utf8'),{assemblyName:'ProjectTasks',outputKind:'library',compilerExtensions:[]}));
 });
 const project=`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><RootNamespace>ProjectDemo</RootNamespace></PropertyGroup><Import Project="../tools/tasks.targets"/><ItemGroup><Input Include="value.txt"><Label>metadata</Label></Input></ItemGroup></Project>`;
 const targets=`<Project><UsingTask TaskName="BrowserTasks.GenerateValue" AssemblyFile="Tasks.dll"/><Target Name="Generate" BeforeTargets="CoreCompile" Inputs="value.txt" Outputs="obj/TaskGenerated.cs"><GenerateValue InputFile="$(MSBuildProjectDirectory)/value.txt" Factor="6" Items="@(Input)"><Output TaskParameter="Generated" ItemName="Compile"/><Output TaskParameter="Value" PropertyName="Value"/><Output TaskParameter="Label" PropertyName="Label"/></GenerateValue></Target></Project>`;
 await test('Project UsingTask generates files and returns metadata/typed outputs through WASM',async()=>{
  first=ok(await compiler.buildProject({projectPath:'/app/Demo.csproj',incrementalCache:cache,files:{'/app/Demo.csproj':project,'/tools/tasks.targets':targets,'/tools/Tasks.dll':taskAssembly.pe,'/app/value.txt':'7','/app/Strings.resx':'<root><data name="Greeting"><value>Hello project resource</value></data><data name="Number" type="System.Int32"><value>42</value></data></root>','/app/Program.cs':'using System;using System.Resources;using System.Reflection;Console.WriteLine(TaskGenerated.Value);var r=new ResourceManager("ProjectDemo.Strings",Assembly.GetExecutingAssembly());Console.WriteLine(r.GetString("Greeting"));Console.WriteLine(r.GetObject("Number"));'}}));
  assert.equal(first.properties.Value,'42');assert.equal(first.properties.Label,'value.txt:metadata');assert.equal(first.items.Compile.find(i=>i.path.endsWith('TaskGenerated.cs')).metadata.Generator,'ManagedITask');assert.ok(first.diagnostics.some(d=>d.id==='TASK001'&&d.severity==='warning'));assert.ok(first.files.has('/app/obj/TaskGenerated.cs'));
 });
 await test('Project resources and task-generated code execute from the actual emitted assembly',async()=>{
  const result=ok(await compiler.run(first.compileResult,{backend:'wasm'}));assert.equal(result.stdout.trim(),'42\nHello project resource\n42');
 });
 await test('Second project build reuses task outputs and emits executable assembly again',async()=>{
  const second=ok(await compiler.buildProject({projectPath:'/app/Demo.csproj',incrementalCache:cache,files:first.files}));assert.ok(second.skippedTargets.includes('Generate'));assert.equal(second.properties.Value,'42');assert.equal(ok(await compiler.run(second.compileResult,{backend:'wasm'})).stdout.trim(),'42\nHello project resource\n42');
 });
 await test('Changing input invalidates the managed target content cache',async()=>{
  const files=new Map(first.files);files.set('/app/value.txt','8');const third=ok(await compiler.buildProject({projectPath:'/app/Demo.csproj',incrementalCache:cache,files}));assert.ok(third.targets.includes('Generate'));assert.equal(third.properties.Value,'48');assert.equal(ok(await compiler.run(third.compileResult,{backend:'wasm'})).stdout.trim(),'48\nHello project resource\n42');
 });
 await test('Managed task errors and OnError cleanup propagate through public project build',async()=>{
  const result=await compiler.buildProject({files:{'App.csproj':'<Project DefaultTargets="Build"><UsingTask TaskName="BrowserTasks.LoggedFailure" AssemblyFile="Tasks.dll"/><Target Name="Build"><LoggedFailure/><OnError ExecuteTargets="Clean"/></Target><Target Name="Clean"><WriteLinesToFile File="cleanup.txt" Lines="cleaned"/></Target></Project>','Tasks.dll':taskAssembly.pe}});assert.equal(result.success,false);assert.equal(result.error.code,'CUSTOM_TASK_FAILED');assert.equal(result.files.get('/cleanup.txt'),'cleaned\n');assert.ok(result.diagnostics.some(d=>d.severity==='error'));
 });

 await test('Culture RESX produces genuine satellite assemblies and ResourceManager resolves cultures',async()=>{
  const files={'/local/Local.csproj':'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><RootNamespace>Local</RootNamespace></PropertyGroup></Project>','/local/Program.cs':'using System;using System.Globalization;using System.Resources;using System.Reflection;var r=new ResourceManager("Local.Strings",Assembly.GetExecutingAssembly());Console.WriteLine(r.GetString("Greeting",CultureInfo.InvariantCulture));Console.WriteLine(r.GetString("Greeting",CultureInfo.GetCultureInfo("pl")));Console.WriteLine(r.GetString("Greeting",CultureInfo.GetCultureInfo("fr")));','/local/Strings.resx':'<root><data name="Greeting"><value>Hello</value></data></root>','/local/Strings.pl.resx':'<root><data name="Greeting"><value>Cześć</value></data></root>','/local/Strings.fr.resx':'<root><data name="Greeting"><value>Bonjour</value></data></root>'};
  const built=ok(await compiler.buildProject({projectPath:'/local/Local.csproj',files}));assert.equal(built.satelliteAssemblies.length,2);assert.ok(built.files.has('/local/bin/pl/Local.resources.dll'));const result=ok(await compiler.run(built.compileResult,{backend:'wasm'}));assert.equal(result.stdout.trim(),'Hello\nCześć\nBonjour');
 });
 await test('Nested MSBuild projects and metadata batches generate real C# compiled and executed in WASM',async()=>{
  const built=ok(await compiler.buildProject({projectPath:'/main/Batch.csproj',files:{'/main/Batch.csproj':`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><Value>$([MSBuild]::Multiply(6,7))</Value></PropertyGroup><Target Name="Nested" BeforeTargets="CoreCompile"><MSBuild Projects="../gen/Generate.proj" Targets="Generate" Properties="Value=$(Value)" RebaseOutputs="true"><Output TaskParameter="TargetOutputs" ItemName="Compile"/></MSBuild></Target></Project>`,'/main/Program.cs':'System.Console.WriteLine(Generated.Value);','/gen/Generate.proj':`<Project><ItemGroup><Entry Include="Generated"><Number>$(Value)</Number></Entry></ItemGroup><Target Name="Generate" Returns="@(Made)"><WriteLinesToFile File="obj/%(Entry.Identity).cs" Lines="public static class %(Entry.Identity) { public const int Value = %(Entry.Number)%3B }" Overwrite="true"/><ItemGroup><Made Include="obj/Generated.cs"/></ItemGroup></Target></Project>`}}));
  assert.equal(ok(await compiler.run(built.compileResult,{backend:'wasm'})).stdout.trim(),'42');assert.equal(built.projectReferences[0].success,true);
 });

 await test('Exec runs a real native WASI command and compiles its generated C# in managed WASM',async()=>{
  const registry=new WasmCommandRegistry();const fixture=JSON.parse(await readFile(new URL('fixtures/wasi-command.json',import.meta.url),'utf8'));await registry.register('native-tool',fromBase64(fixture.base64));
  const built=ok(await compiler.buildProject({projectPath:'/native/App.csproj',commandRunner:r=>registry.run(r.command,r),files:{'/native/App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup><Target Name="Generate" BeforeTargets="CoreCompile"><MakeDir Directories="obj"/><Exec Command="native-tool generate input.txt obj/Generated.cs" EnvironmentVariables="OFFSET=2"/><ItemGroup><Compile Include="obj/Generated.cs"/></ItemGroup></Target></Project>`,'/native/input.txt':'40','/native/Program.cs':'System.Console.WriteLine(NativeGenerated.Value);'}}));assert.equal(ok(await compiler.run(built.compileResult,{backend:'wasm'})).stdout.trim(),'42');assert.ok(built.files.has('/native/obj/Generated.cs'));
 });
}catch(error){records.push({name:'startup',passed:false,error:error.message});console.error(error);}
finally {
 compiler?.dispose();for(const worker of NodeBrowserWorker.instances)worker.terminate();await Promise.all(NodeBrowserWorker.instances.map(w=>w.termination));
 if(previousWorker===undefined)delete globalThis.Worker;else globalThis.Worker=previousWorker;
 const report={testedAt:new Date().toISOString(),environment:'Actual .NET browser-wasm in Node Worker through public compiler/project APIs',passed:records.filter(r=>r.passed).length,failed:records.filter(r=>!r.passed).length,tests:records};
 await writeFile(new URL('../docs/wasm-projects-verification.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(`${report.passed} passed; ${report.failed} failed`);process.exitCode=report.failed?1:0;
}
