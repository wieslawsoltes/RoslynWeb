// DOTNET=/path/to/dotnet node tests/cad-strings-verify-native.mjs [--update]
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=await mkdtemp(join(tmpdir(),'roslynweb-strings-native-'));
try {
 const source=await readFile(new URL('./cad-strings-fixture.cs',import.meta.url),'utf8');
 const baseline=JSON.parse(await readFile(new URL('./cad-strings-baseline.json',import.meta.url),'utf8'));
 const methods=baseline.cases.map(item=>item.method).filter(method=>method!=='EnvironmentValues');
 await copyFile(new URL('./cad-strings-fixture.cs',import.meta.url),join(directory,'Fixture.cs'));
 await copyFile(new URL('../managed/Utf16JsonConverter.cs',import.meta.url),join(directory,'Utf16JsonConverter.cs'));
 await writeFile(join(directory,'Program.cs'),`using System;using System.Text.Json;using System.Globalization;using RoslynBrowser;using System.Collections.Generic;
CultureInfo.CurrentCulture=CultureInfo.InvariantCulture;var cases=new List<object>();foreach(var method in new[]{${methods.map(name=>JSON.stringify(name)).join(',')}})cases.Add(new {method,result=typeof(CadStringsFixture).GetMethod(method).Invoke(null,null)});
Console.WriteLine(JsonSerializer.Serialize(new {runtime=Environment.Version.ToString(),cases},new JsonSerializerOptions {Converters={new Utf16JsonConverter()}}));`);
 await writeFile(join(directory,'Native.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><WarningLevel>0</WarningLevel><ImplicitUsings>enable</ImplicitUsings></PropertyGroup></Project>');
 const result=spawnSync(process.env.DOTNET??'dotnet',['run','--project',join(directory,'Native.csproj'),'--configuration','Release','--verbosity','quiet'],{encoding:'utf8',maxBuffer:16*1024*1024});
 if(result.status!==0)throw Error(result.stderr||result.stdout||String(result.error));
 const data=JSON.parse(result.stdout);for(const item of data.cases)assert.deepEqual(item.result,baseline.cases.find(expected=>expected.method===item.method).result,item.method);
 const report={runtime:data.runtime,sourceSha256:createHash('sha256').update(source).digest('hex'),cases:data.cases.map(item=>({method:item.method,results:item.result.length,sha256:createHash('sha256').update(JSON.stringify(item.result)).digest('hex')}))};
 if(process.argv.includes('--update'))await writeFile(new URL('./cad-strings-native-baseline.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 else assert.deepEqual(report,JSON.parse(await readFile(new URL('./cad-strings-native-baseline.json',import.meta.url),'utf8')));
 console.log(`PASS native .NET ${data.runtime}: ${data.cases.reduce((sum,item)=>sum+item.result.length,0)} string/split/comparer/builder results match managed .NET Wasm.`);
}finally{await rm(directory,{recursive:true,force:true});}
