// Build real C# and execute exact patched PE payloads on native .NET as the oracle.
import {mkdtemp,mkdir,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const dir=await mkdtemp(join(tmpdir(),'roslyn-float-literals-')),root=new URL('../',import.meta.url);
try{
  await mkdir(join(dir,'fixture'));await mkdir(join(dir,'runner'));
  await copyFile(new URL('global.json',root),join(dir,'global.json'));
  await copyFile(new URL('tests/float-literals-fixture.cs',root),join(dir,'fixture','Fixture.cs'));
  await copyFile(new URL('managed/IlInspector.cs',root),join(dir,'runner','IlInspector.cs'));
  await writeFile(join(dir,'fixture','Fixture.csproj'),`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Optimize>true</Optimize><Deterministic>true</Deterministic><PathMap>$(MSBuildProjectDirectory)=/_/float-literal-fixture</PathMap><AssemblyName>FloatLiteralFixture</AssemblyName></PropertyGroup></Project>`);
  await writeFile(join(dir,'runner','Runner.csproj'),`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><ProjectReference Include="../fixture/Fixture.csproj"/></ItemGroup></Project>`);
  await writeFile(join(dir,'runner','Program.cs'),`using System.Buffers.Binary;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Serialization;
using RoslynBrowser;
byte[] image=File.ReadAllBytes(typeof(FloatLiteralFixture).Assembly.Location);
var patches=new Dictionary<string,string> {
 ["DoublePayloadPositive"]="7ff8000000000042",["DoublePayloadNegative"]="fff8000000012345",
 ["SinglePayloadPositive"]="7fc00042",["SinglePayloadNegative"]="ffc12345",
 ["DoubleSignaling"]="7ff0000000000042",["SingleSignaling"]="7f800042"
};
using(var pe=new PEReader(new MemoryStream(image))) {
 var reader=pe.GetMetadataReader();
 foreach(var handle in reader.MethodDefinitions) {
  var method=reader.GetMethodDefinition(handle);string name=reader.GetString(method.Name);
  if(!patches.TryGetValue(name,out var hex))continue;
  int rva=method.RelativeVirtualAddress;
  var section=pe.PEHeaders.SectionHeaders.First(s=>rva>=s.VirtualAddress&&rva<s.VirtualAddress+Math.Max(s.VirtualSize,s.SizeOfRawData));
  int start=rva-section.VirtualAddress+section.PointerToRawData;
  int code=start+((image[start]&3)==2?1:(BinaryPrimitives.ReadUInt16LittleEndian(image.AsSpan(start,2))>>12)*4);
  if(image[code]!=(hex.Length==8?0x22:0x23))throw new InvalidOperationException("Expected direct floating literal: "+name);
  ulong bits=Convert.ToUInt64(hex,16);
  if(hex.Length==8)BinaryPrimitives.WriteUInt32LittleEndian(image.AsSpan(code+1,4),(uint)bits);
  else BinaryPrimitives.WriteUInt64LittleEndian(image.AsSpan(code+1,8),bits);
 }
}
var context=new AssemblyLoadContext("ExactFloatPayloads",true);
var assembly=context.LoadFromStream(new MemoryStream(image));
var cases=assembly.GetType("FloatLiteralFixture")!.GetMethods(BindingFlags.Public|BindingFlags.Static).Select(method=>new {method=method.Name,kind=method.ReturnType==typeof(long)?"i64":"i32",value=method.Invoke(null,null)!.ToString(),patchedBits=patches.GetValueOrDefault(method.Name)}).ToArray();
var options=new JsonSerializerOptions {WriteIndented=true,PropertyNamingPolicy=JsonNamingPolicy.CamelCase,NumberHandling=JsonNumberHandling.AllowNamedFloatingPointLiterals};
File.WriteAllText(args[0],JsonSerializer.Serialize(new {runtime=Environment.Version.ToString(),cases,model=IlInspector.Inspect(image)},options));
File.WriteAllBytes(args[1],image);
context.Unload();`);
  const json=join(dir,'fixture.json'),pePath=join(dir,'fixture.dll');
  const result=spawnSync(process.env.DOTNET??'/tmp/dotnet/dotnet',['run','--project',join(dir,'runner','Runner.csproj'),'-c','Release','--',json,pePath],{cwd:dir,encoding:'utf8',maxBuffer:1024*1024});
  if(result.status!==0)throw new Error(result.stdout+'\n'+result.stderr);
  const fixture=JSON.parse(await readFile(json)),pe=await readFile(pePath),source=await readFile(new URL('./float-literals-fixture.cs',import.meta.url));
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  await writeFile(new URL('./float-literals-fixture.json',import.meta.url),JSON.stringify({...fixture,sdk:'10.0.100',sourceSha256:hash(source),assemblySha256:hash(pe),peBase64:pe.toString('base64'),methodology:'Pinned SDK Roslyn release compilation. Six named methods have their real PE floating-literal bytes deliberately patched to exact documented IEEE payloads, then that same PE is inspected and independently executed on native .NET.'},null,2)+'\n');
  console.log(`Verified ${fixture.cases.length} native floating-literal oracles.`);
}finally{await rm(dir,{recursive:true,force:true});}
