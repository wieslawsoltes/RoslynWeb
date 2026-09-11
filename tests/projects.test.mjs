import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProject, evaluateProject } from '../src/projects/index.js';
const encoder=new TextEncoder();
function host(){return {calls:[],references:[],assemblies:[],extensions:[],async compile(sources,options){this.calls.push({sources,options});return {success:true,pe:encoder.encode(options.assemblyName),pdb:new Uint8Array([7]),diagnostics:[]};},async addReference(name,bytes){this.references.push({name,bytes});},async addAssembly(name,bytes){this.assemblies.push({name,bytes});},async addCompilerExtension(name,bytes){this.extensions.push({name,bytes});}};}

test('SDK project selects virtual C# files, applies properties conditions, remove and metadata update',async()=>{
 const compiler=host();const result=await buildProject(compiler,{projectPath:'/app/App.csproj',files:{'/app/App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><Nullable>enable</Nullable></PropertyGroup><PropertyGroup Condition="'$(Configuration)' == 'Release'"><Optimize>true</Optimize><DefineConstants>FAST;PROD</DefineConstants></PropertyGroup><ItemGroup><Compile Remove="ignored/**/*.cs"/><Compile Update="Program.cs"><Visible>false</Visible></Compile></ItemGroup></Project>`,'/app/Program.cs':'class A{}','/app/ignored/A.cs':'bad','/app/obj/gen.cs':'bad','/app/sub/B.cs':'class B{}'},properties:{Configuration:'Release'}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(compiler.calls.length,1);assert.deepEqual(compiler.calls[0].sources.map(x=>x.path),['/app/Program.cs','/app/sub/B.cs']);assert.equal(compiler.calls[0].options.optimization,'release');assert.ok(compiler.calls[0].options.defines.includes('FAST'));assert.equal(result.items.Compile[0].metadata.Visible,'false');assert.ok(result.files.has('/app/bin/App.dll'));
});

test('virtual props imports, Directory.Build files, Choose and global immutable properties',()=>{
 const result=evaluateProject({projectPath:'/a/p/App.csproj',properties:{Configuration:'Release'},files:{'/a/Directory.Build.props':`<Project><PropertyGroup><Configured>yes</Configured><Configuration>Wrong</Configuration></PropertyGroup></Project>`,'/a/p/feature.props':`<Project><Choose><When Condition="Exists('feature.props') And '$(Configuration)' == 'Release'"><PropertyGroup><Feature>ON</Feature><Origin>$(MSBuildThisFileDirectory)</Origin></PropertyGroup></When><Otherwise><PropertyGroup><Feature>OFF</Feature></PropertyGroup></Otherwise></Choose></Project>`,'/a/p/App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><Import Project="feature.props"/><PropertyGroup><DefineConstants>$(Feature)</DefineConstants></PropertyGroup></Project>`}});
 assert.equal(result.properties.Configuration,'Release');assert.equal(result.properties.Configured,'yes');assert.equal(result.properties.DefineConstants,'ON');assert.equal(result.properties.Origin,'/a/p/');
});

test('targets execute dependency / before / after order and generate source before Roslyn',async()=>{
 const compiler=host();const result=await buildProject(compiler,{files:{'App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><Target Name="Prep" BeforeTargets="CoreCompile" DependsOnTargets="Check"><WriteLinesToFile File="obj/Generated.cs" Lines="public class Generated { public const int Value = 42%3B }" Overwrite="true"/><ItemGroup><Compile Include="obj/Generated.cs"/></ItemGroup></Target><Target Name="Check"><Message Text="Ready"/></Target><Target Name="Finish" AfterTargets="CoreCompile"><Copy SourceFiles="$(TargetPath)" DestinationFiles="export/Copy.dll"/><ReadLinesFromFile File="obj/Generated.cs"><Output TaskParameter="Lines" PropertyName="GeneratedText"/></ReadLinesFromFile></Target></Project>`,'App.cs':'class App{}'}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.deepEqual(result.targets,['BeforeBuild','Check','Prep','CoreCompile','Finish','AfterBuild','Build']);assert.ok(compiler.calls[0].sources.some(x=>x.text.includes('Value = 42;')));assert.equal(result.files.get('/export/Copy.dll'),result.pe);assert.match(result.properties.GeneratedText,/Value = 42/);
});

test('target graph deduplicates dependencies and rejected conditions still trigger hooks',async()=>{
 const compiler=host();const result=await buildProject(compiler,{files:{'App.csproj':`<Project DefaultTargets="Build"><Target Name="Build" DependsOnTargets="A;B;A"/><Target Name="A" Condition="false" DependsOnTargets="Never"/><Target Name="B"/><Target Name="Before" BeforeTargets="A"><PropertyGroup><RanBefore>yes</RanBefore></PropertyGroup></Target><Target Name="After" AfterTargets="A"><PropertyGroup><RanAfter>yes</RanAfter></PropertyGroup></Target></Project>`}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(result.properties.RanBefore,'yes');assert.equal(result.properties.RanAfter,'yes');assert.equal(result.targets.filter(x=>x==='B').length,1);assert.equal(compiler.calls.length,0);
});

test('ProjectReference compiles dependency before consumer and loads emitted DLL',async()=>{
 const compiler=host();const result=await buildProject(compiler,{projectPath:'/app/App.csproj',files:{'/app/App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../lib/Lib.csproj"/></ItemGroup></Project>`,'/app/A.cs':'class A{}','/lib/Lib.csproj':`<Project Sdk="Microsoft.NET.Sdk"/>`,'/lib/L.cs':'class L{}'}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.deepEqual(compiler.calls.map(x=>x.options.assemblyName),['Lib','App']);assert.equal(compiler.references[0].name,'Lib.dll');assert.equal(result.projectReferences.length,1);
});

test('explicit references, analyzer DLLs, additional texts and editorconfig reach compiler interface',async()=>{
 const compiler=host();const result=await buildProject(compiler,{files:{'App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Reference Include="Other"><HintPath>lib/Other.dll</HintPath></Reference><Analyzer Include="tools/Generator.dll"/><AdditionalFiles Include="input.txt"/><EditorConfigFiles Include=".editorconfig"/></ItemGroup></Project>`,'A.cs':'class A{}','lib/Other.dll':new Uint8Array([1]),'tools/Generator.dll':new Uint8Array([2]),'input.txt':'answer=42','.editorconfig':'root=true'}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(compiler.references[0].name,'Other.dll');assert.equal(compiler.extensions[0].name,'Generator.dll');assert.deepEqual(compiler.calls[0].options.additionalTexts,[{path:'/input.txt',text:'answer=42'}]);assert.equal(compiler.calls[0].options.analyzerConfigFiles.length,1);
});

test('NuGet props/targets imports really generate source and selected package assets are loaded',async()=>{
 const compiler=host(),dll={name:'Package.dll',bytes:new Uint8Array([3])};
 const pkg={id:'Package',version:'1.0.0',files:new Map([['build/Package.props','<Project><PropertyGroup><PackageConstant>42</PackageConstant></PropertyGroup></Project>'],['build/Package.targets','<Project><Target Name="PackageGenerate" BeforeTargets="CoreCompile"><WriteLinesToFile File="obj/P.cs" Lines="class P { public const int V = $(PackageConstant)%3B }" Overwrite="true"/><ItemGroup><Compile Include="obj/P.cs"/></ItemGroup></Target></Project>']]),buildAssets:[{kind:'build',phase:'props',path:'build/Package.props'},{kind:'build',phase:'targets',path:'build/Package.targets'}],contentAssets:[]};
 const result=await buildProject(compiler,{files:{'App.csproj':'<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Package" Version="[1.0.0]" ExcludeAssets="native"/></ItemGroup></Project>','A.cs':'class A{}'},restore:async requests=>{assert.equal(requests[0].excludeAssets,'native');return {packages:[pkg],compileAssets:[dll],runtimeAssets:[dll],analyzerAssets:[]};}});
 assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(result.properties.PackageConstant,'42');assert.ok(compiler.calls[0].sources.some(x=>x.text.includes('V = 42;')));assert.equal(compiler.references[0].name,'Package.dll');
});

test('unsupported tasks, external SDKs, invalid XML and cycles fail with explicit diagnostic codes',async()=>{
 for(const [xml,code] of [['<Project DefaultTargets="B"><Target Name="B"><Exec Command="echo no"/></Target></Project>','UNSUPPORTED_BUILD_TASK'],['<Project Sdk="Microsoft.NET.Sdk.WindowsDesktop"/>','UNSUPPORTED_SDK'],['<Project><Bad></Project>','INVALID_PROJECT_XML'],['<Project DefaultTargets="A"><Target Name="A" DependsOnTargets="B"/><Target Name="B" DependsOnTargets="A"/></Project>','TARGET_CYCLE'],['<Project><Import Project="App.csproj"/></Project>','IMPORT_CYCLE']]){const result=await buildProject(host(),{files:{'App.csproj':xml}});assert.equal(result.success,false);assert.equal(result.error.code,code);}
});

test('conditions support comparisons, Exists, negation and report unsupported functions',()=>{
 const files={'App.csproj':`<Project><PropertyGroup Condition="!Exists('missing') And ('2.0.0' &gt;= '1.0.1' Or false)"><A>yes</A></PropertyGroup></Project>`};assert.equal(evaluateProject({files}).properties.A,'yes');
 assert.throws(()=>evaluateProject({files:{'App.csproj':`<Project><PropertyGroup Condition="GetRegistryValue('x')"><A>x</A></PropertyGroup></Project>`}}),error=>error.code==='UNSUPPORTED_CONDITION_FUNCTION');
});

test('compile errors propagate Roslyn diagnostics and skip subsequent tasks',async()=>{
 const compiler=host();compiler.compile=async()=>({success:false,diagnostics:[{id:'CS1002',severity:'error',message:'; expected'}]});const result=await buildProject(compiler,{files:{'App.csproj':'<Project Sdk="Microsoft.NET.Sdk"><Target Name="After" AfterTargets="CoreCompile"><WriteLinesToFile File="should-not-exist" Lines="bad"/></Target></Project>','A.cs':'bad'}});assert.equal(result.success,false);assert.equal(result.diagnostics[0].id,'CS1002');assert.ok(!result.files.has('/should-not-exist'));
});

test('Write/Read/MakeDir/Delete and task outputs operate only within virtual files',async()=>{
 const result=await buildProject(host(),{files:{'App.csproj':`<Project DefaultTargets="Build"><Target Name="Build"><MakeDir Directories="out"/><WriteLinesToFile File="out/a.txt" Lines="one;two" Overwrite="true"/><ReadLinesFromFile File="out/a.txt"><Output TaskParameter="Lines" ItemName="Read"/></ReadLinesFromFile><Copy SourceFiles="out/a.txt" DestinationFolder="copy"><Output TaskParameter="CopiedFiles" PropertyName="Copied"/></Copy><Delete Files="out/a.txt"/></Target></Project>`}});assert.equal(result.success,true,JSON.stringify(result.error));assert.deepEqual(result.items.Read.map(x=>x.include),['one','two']);assert.equal(result.properties.Copied,'/copy/a.txt');assert.equal(result.files.get('/copy/a.txt'),'one\ntwo\n');assert.ok(!result.files.has('/out/a.txt'));
});

test('project copy output content, automatic editorconfig and inferred SDK constants are honored',async()=>{
 const compiler=host();const result=await buildProject(compiler,{files:{'App.csproj':`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><Content Include="settings.json"><CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory></Content></ItemGroup></Project>`,'A.cs':'class A{}','.editorconfig':'root=true','settings.json':'{"ok":true}'}});assert.equal(result.success,true,JSON.stringify(result.error));assert.equal(result.files.get('/bin/settings.json'),'{"ok":true}');assert.equal(compiler.calls[0].options.analyzerConfigFiles.length,1);assert.ok(compiler.calls[0].options.defines.includes('NET8_0_OR_GREATER'));assert.equal(result.properties.TargetFrameworkMoniker,'.NETCoreApp,Version=v10.0');
});

test('resource host requirements, unsupported target frameworks and desktop workloads fail explicitly',async()=>{
 for(const [xml,code] of [['<Project Sdk="Microsoft.NET.Sdk"/>','RESOURCE_HOST_UNAVAILABLE'],['<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>','UNSUPPORTED_FRAMEWORK'],['<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><UseWPF>true</UseWPF></PropertyGroup></Project>','UNSUPPORTED_DESKTOP_WORKLOAD']]){const result=await buildProject(host(),{files:{'App.csproj':xml,'file.resx':'<root/>'}});assert.equal(result.error.code,code);}
});

test('project reference cycles and duplicate Compile includes are diagnosed',async()=>{
 const result=await buildProject(host(),{projectPath:'/a/A.csproj',files:{'/a/A.csproj':'<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../b/B.csproj"/></ItemGroup></Project>','/b/B.csproj':'<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="../a/A.csproj"/></ItemGroup></Project>'}});assert.equal(result.success,false);assert.equal(result.error.code,'PROJECT_REFERENCE_FAILED');assert.equal(result.error.details.diagnostics[0].id,'PROJECT_CYCLE');
 const duplicate=await buildProject(host(),{files:{'App.csproj':'<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><Compile Include="A.cs"/></ItemGroup></Project>','A.cs':'class A{}'}});assert.equal(duplicate.error.code,'DUPLICATE_COMPILE_ITEM');
});
