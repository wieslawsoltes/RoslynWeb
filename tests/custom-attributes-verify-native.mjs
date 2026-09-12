// DOTNET=/path/to/dotnet node tests/custom-attributes-verify-native.mjs
import {mkdtemp,copyFile,writeFile,rm,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const directory=await mkdtemp(join(tmpdir(),'roslynweb-attributes-native-'));
try {
 await copyFile(new URL('./custom-attributes-fixture.cs',import.meta.url),join(directory,'AttributeFixture.cs'));
 await writeFile(join(directory,'Program.cs'),`using System;using System.Collections.Generic;using System.Reflection;using System.Text.Json;
var results=new SortedDictionary<string,object>();foreach(var method in typeof(CustomAttributesFixture).GetMethods(BindingFlags.Public|BindingFlags.Static))results[method.Name]=method.Invoke(null,null)!;
var filters=new SortedDictionary<string,object>();var field=typeof(AttributeData).GetField("Value");foreach(var type in new[]{typeof(string),typeof(int),typeof(IProbeTag),typeof(object)}){var attributes=field.GetCustomAttributes(type,false);filters[type.FullName]=new{arrayType=attributes.GetType().FullName,count=attributes.Length};}
Console.Write(JsonSerializer.Serialize(new{runtime=Environment.Version.ToString(),results,filters}));`);
 await writeFile(join(directory,'Native.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><WarningLevel>0</WarningLevel></PropertyGroup></Project>');
 const result=spawnSync(process.env.DOTNET??'dotnet',['run','--project',join(directory,'Native.csproj'),'--configuration','Release','--verbosity','quiet','-p:UseSharedCompilation=false'],{encoding:'utf8'});
 if(result.status!==0)throw Error(result.stderr||result.stdout||String(result.error));
 const data={...JSON.parse(result.stdout),sourceSha256:createHash('sha256').update(await readFile(new URL('./custom-attributes-fixture.cs',import.meta.url))).digest('hex')};
 const baselineUrl=new URL('./custom-attributes-native-baseline.json',import.meta.url);
 if(process.argv.includes('--update')) await writeFile(baselineUrl,JSON.stringify(data,null,2)+'\n');
 else assert.deepEqual(data,JSON.parse(await readFile(baselineUrl,'utf8')),'Native attribute baseline');
 console.log(`Native .NET ${data.runtime}: ${Object.keys(data.results).length} attribute scenarios and ${Object.keys(data.filters).length} filter contracts verified.`);
}finally{await rm(directory,{recursive:true,force:true});}
