// DOTNET=/path/to/dotnet node tests/file-exceptions-verify-native.mjs
import {mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=await mkdtemp(join(tmpdir(),'roslynweb-file-exceptions-native-'));
try{
 await copyFile(new URL('./file-exceptions-fixture.cs',import.meta.url),join(directory,'Fixture.cs'));
 await writeFile(join(directory,'Program.cs'),'using System;using System.Collections.Generic;using System.Reflection;using System.Text.Json;var results=new SortedDictionary<string,object>();foreach(var method in typeof(FileExceptionsFixture).GetMethods(BindingFlags.Public|BindingFlags.Static))results[method.Name]=method.Invoke(null,null)!;Console.Write(JsonSerializer.Serialize(new{runtime=Environment.Version.ToString(),results}));');
 await writeFile(join(directory,'Native.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><WarningLevel>0</WarningLevel></PropertyGroup></Project>');
 const result=spawnSync(process.env.DOTNET??'dotnet',['run','--project',join(directory,'Native.csproj'),'--configuration','Release','--verbosity','quiet'],{encoding:'utf8'});if(result.status!==0)throw Error(result.stderr||result.stdout||String(result.error));
 const data=JSON.parse(result.stdout);await writeFile(new URL('./file-exceptions-native-baseline.json',import.meta.url),JSON.stringify(data,null,2)+'\n');console.log(`Native .NET ${data.runtime}: ${Object.keys(data.results).length} file exception and character cases recorded.`);
}finally{await rm(directory,{recursive:true,force:true});}
