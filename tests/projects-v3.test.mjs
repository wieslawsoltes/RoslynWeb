import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProject, evaluateProject } from '../src/projects/index.js';
import { fromBase64, toBase64 } from '../src/bytes.js';
const encode=value=>new TextEncoder().encode(value);
const compiler=()=>({calls:[],async compile(sources,options){this.calls.push({sources,options});return {success:true,pe:encode('dll'),diagnostics:[]};},async addReference(){},async addAssembly(){}});

test('UsingTask resolves imported AssemblyFile, first registration wins, explicit override wins',()=>{
 const files={'/app/App.csproj':`<Project><Import Project="../tools/tasks.targets"/><UsingTask TaskName="Tasks.Make" AssemblyName="Ignored"/><UsingTask TaskName="Tasks.Make" AssemblyName="Override" Override="true"/></Project>`,'/tools/tasks.targets':'<Project><UsingTask TaskName="Tasks.Make" AssemblyFile="Make.dll"/></Project>'};
 let result=evaluateProject({projectPath:'/app/App.csproj',files});assert.equal(result.usingTasks[0].assemblyName,'Override');
 files['/app/App.csproj']='<Project><Import Project="../tools/tasks.targets"/><UsingTask TaskName="Tasks.Make" AssemblyName="Ignored"/></Project>';
 result=evaluateProject({projectPath:'/app/App.csproj',files});assert.equal(result.usingTasks[0].assemblyFile,'/tools/Make.dll');
});

test('UsingTask diagnoses inline factories, invalid architecture and duplicate overrides',()=>{
 for(const [task,code] of [['<UsingTask TaskName="T" AssemblyName="A" TaskFactory="RoslynCodeTaskFactory"><Task/></UsingTask>','UNSUPPORTED_TASK_FACTORY'],['<UsingTask TaskName="T" AssemblyName="A" Architecture="x64"/>','UNSUPPORTED_TASK_ARCHITECTURE'],['<UsingTask TaskName="T" AssemblyName="A" Runtime="CLR4"/>','UNSUPPORTED_TASK_RUNTIME'],['<UsingTask TaskName="T" AssemblyName="A" AssemblyFile="a.dll"/>','INVALID_USING_TASK'],['<UsingTask TaskName="T" AssemblyName="A" Override="true"/><UsingTask TaskName="T" AssemblyName="B" Override="true"/>','DUPLICATE_TASK_OVERRIDE']])assert.throws(()=>evaluateProject({files:{'App.csproj':`<Project>${task}</Project>`}}),error=>error.code===code);
});

test('custom task forwards actual DLL, metadata, virtual paths and restores files/property/item outputs',async()=>{
 const host=compiler();let request;
 host.executeBuildTask=async(assembly,type,options)=>{request=options;assert.equal(assembly,toBase64(new Uint8Array([1,2,3])));assert.equal(type,'Demo.Generate');return {success:true,outputs:{Count:2,Generated:[{itemSpec:'/app/obj/Generated.cs',metadata:{Generated:'true'}}]},files:[{path:'app/obj/Generated.cs',base64:toBase64(encode('class Generated{}'))}],removedFiles:['app/delete.txt'],diagnostics:[{severity:'info',message:'Generated'}]};};
 const result=await buildProject(host,{projectPath:'/app/App.csproj',files:{'/app/App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><UsingTask TaskName="Demo.Generate" AssemblyFile="../tools/Task.dll"/><ItemGroup><Input Include="input.txt"><Flavor>blue</Flavor></Input></ItemGroup><Target Name="Generate" BeforeTargets="CoreCompile"><Generate Inputs="@(Input)" Destination="$(MSBuildProjectDirectory)/obj"><Output TaskParameter="count" PropertyName="GeneratedCount"/><Output TaskParameter="Generated" ItemName="Compile"/></Generate></Target></Project>`,'/app/input.txt':'data','/tools/Task.dll':new Uint8Array([1,2,3]),'/app/delete.txt':'old'}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(request.workingDirectory,'app');assert.equal(request.virtualPaths,true);assert.deepEqual(request.parameters.Inputs,[{itemSpec:'input.txt',metadata:{Flavor:'blue'}}]);assert.equal(request.parameters.Destination,'/app/obj');assert.equal(result.properties.GeneratedCount,'2');assert.ok(!result.files.has('/app/delete.txt'));assert.equal(result.items.Compile[0].metadata.Generated,'true');assert.equal(host.calls[0].sources[0].text,'class Generated{}');
});

test('custom task false result preserves diagnostics and executes OnError cleanup',async()=>{
 const host=compiler();host.executeBuildTask=async()=>({success:false,outputs:{},diagnostics:[{severity:'error',message:'Task error',id:'TASK42'}],files:[]});
 const result=await buildProject(host,{files:{'App.csproj':'<Project DefaultTargets="Build"><UsingTask TaskName="Fail" AssemblyName="Tools"/><Target Name="Build"><Fail/><OnError ExecuteTargets="Clean"/></Target><Target Name="Clean"><WriteLinesToFile File="cleanup.txt" Lines="cleaned" Overwrite="true"/></Target></Project>'}});
 assert.equal(result.success,false);assert.equal(result.error.code,'CUSTOM_TASK_FAILED');assert.equal(result.files.get('/cleanup.txt'),'cleaned\n');assert.ok(result.diagnostics.some(d=>d.id==='TASK42'));
});

test('ContinueOnError supports warning and error continuation without hiding error build state',async()=>{
 for(const policy of ['WarnAndContinue','ErrorAndContinue']) {
  const result=await buildProject(compiler(),{files:{'App.csproj':`<Project DefaultTargets="Build"><Target Name="Build"><Error Text="failure" ContinueOnError="${policy}"/><WriteLinesToFile File="continued.txt" Lines="continued"/></Target></Project>`}});
  assert.equal(result.success,policy==='WarnAndContinue');assert.equal(result.files.get('/continued.txt'),'continued\n');assert.ok(result.diagnostics.every(d=>d.severity===(policy==='WarnAndContinue'?'warning':'error')));
 }
});

test('raw resources and RESX conversion emit logical names, visibility and generated resources',async()=>{
 const host=compiler();host.convertResx=async xml=>{assert.match(xml,/hello/);return {success:true,base64:toBase64(new Uint8Array([0xce,0xca,0xef,0xbe])),diagnostics:[]};};
 const result=await buildProject(host,{files:{'App.csproj':'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><RootNamespace>Example</RootNamespace></PropertyGroup><ItemGroup><EmbeddedResource Update="Strings.resx"><LogicalName>Example.Custom.resources</LogicalName></EmbeddedResource><EmbeddedResource Include="blob.bin"><LogicalName>data.bin</LogicalName><Access>private</Access></EmbeddedResource></ItemGroup></Project>','Strings.resx':'<root><data name="Greeting"><value>hello</value></data></root>','blob.bin':new Uint8Array([0,42,255]),'A.cs':'class A{}'}});
 assert.equal(result.success,true,JSON.stringify(result.error));const resources=host.calls[0].options.resources;assert.deepEqual(resources.map(r=>[r.name,r.isPublic]),[['Example.Custom.resources',true],['data.bin',false]]);assert.deepEqual(fromBase64(resources[1].base64),new Uint8Array([0,42,255]));assert.ok(result.files.has('/obj/Example.Custom.resources'));
});

test('GenerateResource task forwards RESX conversion and task output items into Csc Resources',async()=>{
 const host=compiler();host.convertResx=async()=>({success:true,base64:'AQID',diagnostics:[]});
 const result=await buildProject(host,{files:{'App.csproj':'<Project DefaultTargets="Build"><Target Name="Build"><GenerateResource Sources="Strings.resx" OutputResources="obj/Strings.resources"><Output TaskParameter="OutputResources" ItemName="CompiledResources"/></GenerateResource><Csc Sources="A.cs" Resources="@(CompiledResources)"/></Target></Project>','Strings.resx':'<root/>','A.cs':'class A{}'}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(host.calls[0].options.resources[0].base64,'AQID');assert.deepEqual(result.files.get('/obj/Strings.resources'),new Uint8Array([1,2,3]));
});

test('satellite resource and duplicate manifest names fail explicitly',async()=>{
 const host=compiler();host.convertResx=async()=>({success:true,base64:'AQ==',diagnostics:[]});
 let result=await buildProject(host,{files:{'App.csproj':'<Project Sdk="Microsoft.NET.Sdk"/>','Strings.pl.resx':'<root/>'}});assert.equal(result.error.code,'SATELLITE_RESOURCE_REQUIRED');
 result=await buildProject(host,{files:{'App.csproj':'<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><EmbeddedResource Include="a.bin" LogicalName="same"/><EmbeddedResource Include="b.bin" LogicalName="same"/></ItemGroup></Project>','a.bin':'a','b.bin':'b'}});assert.equal(result.error.code,'DUPLICATE_RESOURCE_NAME');
});

test('content incremental cache skips unchanged target and replays inferred item/property outputs',async()=>{
 const cache=new Map(),host=compiler();let files={'App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><Target Name="Generate" BeforeTargets="CoreCompile" Inputs="input.txt" Outputs="obj/Generated.cs"><ReadLinesFromFile File="input.txt"><Output TaskParameter="Lines" PropertyName="GeneratedValue"/></ReadLinesFromFile><WriteLinesToFile File="obj/Generated.cs" Lines="class Generated { const int Value = $(GeneratedValue)%3B }" Overwrite="true"/><ItemGroup><Compile Include="obj/Generated.cs"/></ItemGroup></Target></Project>`,'input.txt':'42'};
 let result=await buildProject(host,{files,incrementalCache:cache});assert.equal(result.success,true,JSON.stringify(result.error));assert.ok(result.targets.includes('Generate'));
 result=await buildProject(host,{files:result.files,incrementalCache:cache});assert.equal(result.success,true,JSON.stringify(result.error));assert.deepEqual(result.skippedTargets,['Generate']);assert.ok(!result.targets.includes('Generate'));assert.equal(result.properties.GeneratedValue,'42');assert.equal(host.calls.at(-1).sources[0].text,'class Generated { const int Value = 42; }\n');
 files=new Map(result.files);files.set('/input.txt','43');result=await buildProject(host,{files,incrementalCache:cache});assert.equal(result.success,true,JSON.stringify(result.error));assert.deepEqual(result.skippedTargets,[]);assert.equal(result.properties.GeneratedValue,'43');
 files=new Map(result.files);files.set('/obj/Generated.cs','corrupt');result=await buildProject(host,{files,incrementalCache:cache});assert.equal(result.skippedTargets.length,0);assert.match(result.files.get('/obj/Generated.cs'),/43/);
});

test('target Returns is propagated through CallTarget and declarations execute without a cache',async()=>{
 const result=await buildProject(compiler(),{files:{'App.csproj':'<Project DefaultTargets="Build"><Target Name="Build"><CallTarget Targets="Generate"><Output TaskParameter="TargetOutputs" ItemName="Returned"/></CallTarget></Target><Target Name="Generate" Inputs="input" Outputs="out/a.txt" Returns="out/a.txt;out/b.txt"><WriteLinesToFile File="out/a.txt" Lines="a"/></Target></Project>','input':'data'}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.deepEqual(result.items.Returned.map(i=>i.include),['out/a.txt','out/b.txt']);
});

test('UTF-16 task output can be read back and compiled without data loss',async()=>{
 const host=compiler();const result=await buildProject(host,{files:{'App.csproj':'<Project DefaultTargets="Build"><Target Name="Build"><WriteLinesToFile File="A.cs" Lines="// Zażółć gęślą jaźń;class A {}" Overwrite="true" Encoding="Unicode"/><ReadLinesFromFile File="A.cs"><Output TaskParameter="Lines" PropertyName="Text"/></ReadLinesFromFile><Csc Sources="A.cs"/></Target></Project>'}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.match(result.properties.Text,/Zażółć/);assert.match(host.calls[0].sources[0].text,/Zażółć/);assert.deepEqual([...result.files.get('/A.cs').slice(0,2)],[255,254]);
});
