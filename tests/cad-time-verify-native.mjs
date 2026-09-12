// Independent native .NET oracle for the same checked-in temporal fixture.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const directory=await mkdtemp(join(tmpdir(),'roslynweb-time-oracle-'));
try {
 await writeFile(join(directory,'Oracle.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
 await copyFile(new URL('./cad-time-fixture.cs',import.meta.url),join(directory,'Fixture.cs'));
 await copyFile(new URL('../vendor/netDxf/source/Units/DrawingTime.cs',import.meta.url),join(directory,'DrawingTime.cs'));
 await copyFile(new URL('./cad-time-baseline.json',import.meta.url),join(directory,'baseline.json'));
 await writeFile(join(directory,'Program.cs'),`using System.Text.Json;
using System.Reflection;
using System.Globalization;
var entries=JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
var results=new List<object>();
foreach(var entry in entries.EnumerateArray()) {
 var name=entry.GetProperty("method").GetString()!;var method=typeof(CadTimeFixture).GetMethod(name)!;
 var parameters=method.GetParameters();var input=entry.GetProperty("args").EnumerateArray().ToArray();
 object[] call=new object[input.Length];for(int i=0;i<input.Length;i++)call[i]=parameters[i].ParameterType==typeof(long)?(object)long.Parse(input[i].GetProperty("$int64").GetString()!,CultureInfo.InvariantCulture):input[i].GetInt32();
 object? result=method.Invoke(null,call);
 if(result is long[] values)result=values.Select(v=>new Dictionary<string,string>{{"$int64",v.ToString(CultureInfo.InvariantCulture)}}).ToArray();
 results.Add(new {method=name,args=entry.GetProperty("args").Clone(),result});
}
File.WriteAllText(args[1],JsonSerializer.Serialize(results));`);
 const run=spawnSync(process.env.DOTNET??'dotnet',['run','--project',join(directory,'Oracle.csproj'),'-c','Release','-p:UseSharedCompilation=false','--',join(directory,'baseline.json'),join(directory,'results.json')],{encoding:'utf8',maxBuffer:8*1024*1024,timeout:180000});
 assert.equal(run.status,0,run.stdout+'\n'+run.stderr);
 const results=JSON.parse(await readFile(join(directory,'results.json'),'utf8')),baseline=JSON.parse(await readFile(new URL('./cad-time-baseline.json',import.meta.url),'utf8'));
 for(let i=0;i<results.length;i++)assert.deepEqual(results[i],baseline[i],`Native .NET temporal oracle case ${i} ${results[i].method}`);
 console.log(`PASS ${results.length} temporal scenarios match native .NET and managed Wasm.`);
}finally{await rm(directory,{recursive:true,force:true});}
