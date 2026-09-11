import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildProject,evaluateProject} from '../src/projects/index.js';
const host=()=>({async compile(sources,options){return {success:true,pe:new Uint8Array([1]),diagnostics:[]};},async addReference(){},async addAssembly(){}});
const prop=expression=>evaluateProject({files:{'App.csproj':`<Project><PropertyGroup><P>${expression.replaceAll('&','&amp;').replaceAll('<','&lt;')}</P></PropertyGroup></Project>`}}).properties.P;

test('property functions and metadata batches match recorded native MSBuild output',async()=>{
 const fixture=await readFile(new URL('fixtures/projects-v4.proj',import.meta.url),'utf8');const baseline=JSON.parse(await readFile(new URL('fixtures/projects-v4-native.json',import.meta.url),'utf8'));
 const result=await buildProject(host(),{projectPath:'/Build.proj',files:{'/Build.proj':fixture}});assert.equal(result.success,true,JSON.stringify(result.error));
 for(const [name,text] of Object.entries(baseline.files))assert.equal(String(result.files.get('/out/'+name)).trim(),text.trim(),name);
 assert.deepEqual(result.items.Input.map(i=>i.include),['a','b','c']);
});

test('functions access only explicit virtual filesystem and reject unsupported members and arguments',()=>{
 assert.equal(prop("$([MSBuild]::Add(9007199254740993, 2))"),'9007199254740995');
 assert.equal(prop("$([System.IO.Path]::ChangeExtension('a.cs','.dll'))"),'a.dll');
 assert.equal(prop("$([MSBuild]::MakeRelative('/a/b','/a/c/file'))"),'../c/file');
 for(const expression of ["$([System.Environment]::GetEnvironmentVariable('HOME'))","$([System.Diagnostics.Process]::Start('sh'))","$([System.String]::Copy('x').Substring(5))","$([System.Int32]::Parse('2147483648'))"]){assert.throws(()=>prop(expression),e=>['UNSUPPORTED_PROPERTY_FUNCTION','INVALID_PROPERTY_ARGUMENT'].includes(e.code));}
 const result=evaluateProject({projectPath:'/app/App.csproj',files:{'/app/App.csproj':`<Project><PropertyGroup><Above>$([MSBuild]::GetPathOfFileAbove('root.props'))</Above><Data>$([System.IO.File]::ReadAllText('../input.txt'))</Data></PropertyGroup></Project>`,'/root.props':'<Project/>','/input.txt':'data'}});assert.equal(result.properties.Above,'/root.props');assert.equal(result.properties.Data,'data');
});

test('metadata batches filter all participating lists and preserve task item outputs',async()=>{
 const compiler=host();compiler.executeBuildTask=async(a,t,r)=>({success:true,outputs:{Result:r.parameters.Inputs},files:[],diagnostics:[]});
 const result=await buildProject(compiler,{files:{'App.csproj':`<Project DefaultTargets="Build"><UsingTask TaskName="Tools.Pass" AssemblyName="Tasks"/><ItemGroup><I Include="a" Group="red"/><I Include="b" Group="blue"/><I Include="c" Group="red"/></ItemGroup><Target Name="Build"><Pass Inputs="@(I)" Group="%(I.Group)"><Output TaskParameter="Result" ItemName="R"/></Pass></Target></Project>`}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.deepEqual(result.items.R.map(i=>i.include),['a','c','b']);assert.deepEqual(result.items.I.map(i=>i.include),['a','b','c']);assert.equal(result.items.R[0].metadata.Group,'red');
});

test('metadata inside item transforms does not trigger task batching',async()=>{
 const result=await buildProject(host(),{files:{'App.csproj':'<Project DefaultTargets="Build"><ItemGroup><I Include="a"/><I Include="b"/></ItemGroup><Target Name="Build"><WriteLinesToFile File="out.txt" Lines="@(I-&gt;\'%(Identity).cs\')" Overwrite="true"/></Target></Project>'}});assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(result.files.get('/out.txt'),'a.cs\nb.cs\n');
});

test('nested MSBuild applies globals/removals, rebases outputs, passes metadata, and uses selected targets',async()=>{
 const files={'/app/App.csproj':`<Project DefaultTargets="Build"><ItemGroup><P Include="../lib/Lib.proj"><AdditionalProperties>Value=42</AdditionalProperties></P></ItemGroup><Target Name="Build"><MSBuild Projects="@(P)" Targets="Generate" Properties="Flavor=blue" RemoveProperties="Outer" RebaseOutputs="true"><Output TaskParameter="TargetOutputs" ItemName="Result"/></MSBuild><MSBuild Projects="../lib/Lib.proj" Targets="Second"/></Target></Project>`,'/lib/Lib.proj':`<Project><Target Name="Generate" Returns="obj/value.txt"><WriteLinesToFile File="obj/value.txt" Lines="$(Value);$(Flavor);$(Outer)" Overwrite="true"/></Target><Target Name="Second"><WriteLinesToFile File="obj/second.txt" Lines="second"/></Target></Project>`};
 const result=await buildProject(host(),{projectPath:'/app/App.csproj',files,properties:{Outer:'outer'}});assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(result.files.get('/lib/obj/value.txt'),'42\nblue\n');assert.equal(result.files.get('/lib/obj/second.txt'),'second\n');assert.equal(result.items.Result[0].include,'/lib/obj/value.txt');assert.equal(result.items.Result[0].metadata.MSBuildSourceProjectFile,'/lib/Lib.proj');assert.equal(result.items.Result[0].metadata.MSBuildSourceTargetName,'Generate');
});

test('nested self-project target invocation succeeds and real recursion fails',async()=>{
 let result=await buildProject(host(),{files:{'App.csproj':'<Project DefaultTargets="Build"><Target Name="Build"><MSBuild Projects="App.csproj" Targets="Generate"/></Target><Target Name="Generate"><WriteLinesToFile File="made.txt" Lines="made"/></Target></Project>'}});assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(result.files.get('/made.txt'),'made\n');
 result=await buildProject(host(),{files:{'App.csproj':'<Project DefaultTargets="Build"><Target Name="Build"><MSBuild Projects="App.csproj" Targets="Build"/></Target></Project>'}});assert.equal(result.success,false);assert.ok(result.diagnostics.some(d=>d.id==='PROJECT_CYCLE'));
});

test('Exec routes quoted args, environment and virtual files through explicit runner',async()=>{
 let request;const result=await buildProject(host(),{commandRunner:async r=>{request=r;return {exitCode:0,stdout:'done\n',stderr:'',files:{'/obj/generated.txt':new TextEncoder().encode('42')},removedFiles:['/old.txt']};},files:{'App.csproj':`<Project DefaultTargets="Build"><Target Name="Build"><Exec Command="tool &quot;two words&quot; ''" EnvironmentVariables="MODE=test;VALUE=42" ConsoleToMSBuild="true"><Output TaskParameter="ExitCode" PropertyName="Code"/><Output TaskParameter="ConsoleOutput" ItemName="Lines"/></Exec></Target></Project>`,'old.txt':'old'}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.deepEqual(request.args,['two words','']);assert.deepEqual(request.env,{MODE:'test',VALUE:'42'});assert.equal(request.workingDirectory,'/');assert.equal(result.properties.Code,'0');assert.equal(result.items.Lines[0].include,'done');assert.ok(!result.files.has('/old.txt'));assert.equal(new TextDecoder().decode(result.files.get('/obj/generated.txt')),'42');
});

test('Exec does not invent native shell behavior or hide failure exit codes',async()=>{
 const files=command=>({'App.csproj':`<Project DefaultTargets="Build"><Target Name="Build"><Exec Command="${command}"/></Target></Project>`});let called=false;
 let result=await buildProject(host(),{files:files('tool')});assert.equal(result.error.code,'COMMAND_RUNNER_REQUIRED');
 result=await buildProject(host(),{files:files('tool | shell'),commandRunner:async()=>{called=true;}});assert.equal(result.error.code,'UNSUPPORTED_SHELL_COMMAND');assert.equal(called,false);
 result=await buildProject(host(),{files:files('tool'),commandRunner:async()=>({exitCode:7})});assert.equal(result.error.code,'COMMAND_FAILED');assert.equal(result.error.details.exitCode,7);
});

test('target batching groups declared Inputs/Outputs and collects each output',async()=>{
 const result=await buildProject(host(),{files:{'App.csproj':`<Project DefaultTargets="Generate"><ItemGroup><Input Include="a.txt"/><Input Include="b.txt"/></ItemGroup><Target Name="Generate" Inputs="@(Input)" Outputs="obj/%(Input.Filename).txt"><WriteLinesToFile File="obj/%(Input.Filename).txt" Lines="@(Input)" Overwrite="true"/></Target></Project>`,'a.txt':'a','b.txt':'b'}});assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(result.files.get('/obj/a.txt'),'a.txt\n');assert.equal(result.files.get('/obj/b.txt'),'b.txt\n');assert.deepEqual(result.targetOutputs.Generate,['obj/a.txt','obj/b.txt']);
});

test('explicit Culture metadata appends culture manifest suffix while LogicalName stays exact',async()=>{
 const calls=[],compiler=host();compiler.convertResx=async()=>({success:true,base64:'AQ=='});compiler.compile=async(sources,options)=>{calls.push(options);return {success:true,pe:new Uint8Array([1]),diagnostics:[]};};
 const result=await buildProject(compiler,{files:{'App.csproj':'<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><EmbeddedResource Update="Strings.resx" Culture="pl"/><EmbeddedResource Update="Custom.resx" Culture="pl" LogicalName="Exact.name"/></ItemGroup></Project>','Strings.resx':'<root/>','Custom.resx':'<root/>'}});assert.equal(result.success,true,JSON.stringify(result.error));assert.deepEqual(calls[1].resources.map(r=>r.name).sort(),['App.Strings.pl.resources','Exact.name']);assert.equal(result.satelliteAssemblies.length,1);
});

test('qualified batches, escaping, short circuit conditions and target removals match native MSBuild regressions',async()=>{
 const fixture=await readFile(new URL('fixtures/projects-v4-regressions.proj',import.meta.url),'utf8');const baseline=JSON.parse(await readFile(new URL('fixtures/projects-v4-regressions-native.json',import.meta.url),'utf8'));
 const result=await buildProject(host(),{projectPath:'/Build.proj',files:{'/Build.proj':fixture}});assert.equal(result.success,true,JSON.stringify(result.error));
 for(const [name,text] of Object.entries(baseline.files))assert.equal(String(result.files.get('/out/'+name)).trim(),text.trim(),name);
 assert.deepEqual(result.items.Escaped.map(i=>i.include),['a;b']);assert.deepEqual(result.items.Copied.map(i=>i.include),['a;b']);assert.deepEqual(result.items.Gone,[]);
 for(const rejection of baseline.rejections){if(rejection.expression)assert.throws(()=>prop(rejection.expression),e=>e.code==='INVALID_PROPERTY_ARGUMENT');else {const rejected=await buildProject(host(),{files:{'App.csproj':`<Project DefaultTargets="Build"><Target Name="Build">${rejection.task}</Target></Project>`}});assert.equal(rejected.error.code,'UNSUPPORTED_TASK_PARAMETER');}}
});

test('short circuit conditions still reject malformed syntax and diagnostic tasks reject unknown children',async()=>{
 assert.throws(()=>evaluateProject({files:{'App.csproj':`<Project><PropertyGroup Condition="false And ('a' &gt; 'b'"><P>x</P></PropertyGroup></Project>`}}),e=>e.code==='INVALID_CONDITION');
 const result=await buildProject(host(),{files:{'App.csproj':'<Project DefaultTargets="Build"><Target Name="Build"><Message Text="x"><Bogus/></Message></Target></Project>'}});assert.equal(result.error.code,'UNSUPPORTED_TASK_CHILD');
});
