// Regenerate the real Roslyn metadata fixture and native .NET differential expectations.
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';import {tmpdir} from 'node:os';import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'roslynweb-types-native-'));
try{
 await mkdir(join(dir,'fixture'));await mkdir(join(dir,'runner'));
 await copyFile(new URL('./il-types-fixture.cs',import.meta.url),join(dir,'fixture','Fixture.cs'));
 await copyFile(new URL('../managed/IlInspector.cs',import.meta.url),join(dir,'runner','IlInspector.cs'));
 await writeFile(join(dir,'fixture','Fixture.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>');
 await writeFile(join(dir,'runner','Runner.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><ProjectReference Include="../fixture/Fixture.csproj" /></ItemGroup></Project>');
 await writeFile(join(dir,'runner','Program.cs'),`using System.Reflection;using System.Text.Json;using RoslynBrowser;
var result=new Dictionary<string,string>();foreach(var m in typeof(EmitTypeFixture).GetMethods(BindingFlags.Public|BindingFlags.Static))result[m.Name]=m.Invoke(null,null)?.ToString()??"null";
File.WriteAllText(args[0],JsonSerializer.Serialize(new {runtime=Environment.Version.ToString(),results=result},new JsonSerializerOptions{WriteIndented=true,PropertyNamingPolicy=JsonNamingPolicy.CamelCase}));
File.WriteAllText(args[1],JsonSerializer.Serialize(IlInspector.Inspect(File.ReadAllBytes(typeof(EmitTypeFixture).Assembly.Location)),new JsonSerializerOptions{WriteIndented=true,PropertyNamingPolicy=JsonNamingPolicy.CamelCase}));`);
 const baseline=join(dir,'baseline.json'),model=join(dir,'model.json');
 const r=spawnSync(process.env.DOTNET??'/tmp/dotnet/dotnet',['run','--project',join(dir,'runner','Runner.csproj'),'-c','Release','--',baseline,model],{encoding:'utf8'});
 if(r.status)throw new Error(r.stderr+'\n'+r.stdout);
 await writeFile(new URL('./il-types-native-baseline.json',import.meta.url),await readFile(baseline));await writeFile(new URL('./il-types-fixture.json',import.meta.url),await readFile(model));
 console.log('Recorded '+Object.keys(JSON.parse(await readFile(baseline))).length+' data sections from actual native .NET.');
}finally{await rm(dir,{recursive:true,force:true});}
