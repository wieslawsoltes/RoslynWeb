// Optional native CLR differential oracle. Requires the pinned .NET SDK.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const source=await readFile(new URL('./spans-fixture.cs',import.meta.url),'utf8');
const baselinePath=fileURLToPath(new URL('./spans-baseline.json',import.meta.url));
const baseline=JSON.parse(await readFile(baselinePath,'utf8'));
const directory=await mkdtemp(join(tmpdir(),'roslynweb-spans-native-'));
const dotnet=process.env.DOTNET??'dotnet';
function run(args){const p=spawnSync(dotnet,args,{encoding:'utf8',timeout:120000});if(p.error)throw p.error;assert.equal(p.status,0,p.stdout+'\n'+p.stderr);return p.stdout;}
try {
 await writeFile(join(directory,'SpansOracle.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><ImplicitUsings>enable</ImplicitUsings><InvariantGlobalization>true</InvariantGlobalization></PropertyGroup></Project>');
 await writeFile(join(directory,'Fixture.cs'),source);
 await writeFile(join(directory,'Program.cs'),`using System.Text.Json;\nusing System.Runtime.InteropServices;\nusing System.Globalization;\nCultureInfo.CurrentCulture=CultureInfo.InvariantCulture;\nusing var baseline=JsonDocument.Parse(File.ReadAllText(args[0]));\nvar cases=baseline.RootElement.GetProperty("cases").EnumerateArray().Select(item=> {var method=item.GetProperty("method").GetString()!;return new {method,result=(string)typeof(SpansFixture).GetMethod(method)!.Invoke(null,null)!};}).ToArray();\nConsole.WriteLine(JsonSerializer.Serialize(new {runtime=RuntimeInformation.FrameworkDescription,architecture=RuntimeInformation.ProcessArchitecture.ToString(),cases}));\n`);
 run(['build',join(directory,'SpansOracle.csproj'),'--configuration','Release','--nologo','--verbosity','quiet']);
 const report=JSON.parse(run([join(directory,'bin/Release/net10.0/SpansOracle.dll'),baselinePath]));
 report.sourceSha256=createHash('sha256').update(source).digest('hex');
 assert.equal(report.sourceSha256,baseline.sourceSha256);assert.deepEqual(report.cases,baseline.cases);
 if(process.argv.includes('--update'))await writeFile(new URL('./spans-native-baseline.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
 console.log(`PASS ${report.cases.length} span scenarios agree between ${report.runtime} ${report.architecture} and .NET WebAssembly ${baseline.runtime}.`);
}finally{await rm(directory,{recursive:true,force:true});}
