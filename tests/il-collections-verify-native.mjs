// DOTNET=/path/to/dotnet node tests/il-collections-verify-native.mjs
import {mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'roslynweb-collections-native-'));
try {
 await copyFile(new URL('./il-collections-fixture.cs',import.meta.url),join(dir,'CollectionsFixture.cs'));
 await writeFile(join(dir,'Program.cs'),`using System;using System.Collections.Generic;using System.Reflection;using System.Text.Json;
var results=new SortedDictionary<string,string>();foreach(var m in typeof(CollectionsFixture).GetMethods(BindingFlags.Public|BindingFlags.Static))results[m.Name]=Convert.ToString(m.Invoke(null,null),System.Globalization.CultureInfo.InvariantCulture)!;Console.Write(JsonSerializer.Serialize(new{runtime=Environment.Version.ToString(),results}));`);
 await writeFile(join(dir,'Native.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup></Project>');
 const result=spawnSync(process.env.DOTNET??'dotnet',['run','--project',join(dir,'Native.csproj'),'--configuration','Release','--verbosity','quiet'],{encoding:'utf8'});
 if(result.status!==0)throw Error(result.stderr||result.stdout||String(result.error));
 const data=JSON.parse(result.stdout);await writeFile(new URL('./il-collections-native-baseline.json',import.meta.url),JSON.stringify(data,null,2)+'\n');console.log(`Native .NET ${data.runtime}: ${Object.keys(data.results).length} collection cases recorded.`);
}finally{await rm(dir,{recursive:true,force:true});}
