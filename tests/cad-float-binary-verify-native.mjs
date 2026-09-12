// Verify the checked-in .NET Wasm oracle against a native .NET 10 CLR process.
// DOTNET=/path/to/dotnet node tests/cad-float-binary-verify-native.mjs
import assert from 'node:assert/strict';
import {mkdtemp,copyFile,writeFile,readFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFloatParseInputs} from './cad-float-parse-inputs.mjs';
import {invokeCadFloatParseBuiltin} from '../src/il/cad-float-parse.mjs';
import {i4} from '../src/il/runtime.mjs';
const inputs=createFloatParseInputs();
const baseline=JSON.parse(await readFile(new URL('./cad-float-binary-baseline.json',import.meta.url),'utf8'));
const directory=await mkdtemp(join(tmpdir(),'roslynweb-float-native-'));
try{
 await copyFile(new URL('./cad-float-binary-fixture.cs',import.meta.url),join(directory,'Fixture.cs'));
 await writeFile(join(directory,'Program.cs'),`using System;using System.Collections.Generic;using System.Reflection;using System.Text.Json;using System.Globalization;var cases=new List<object>();foreach(var name in new[]{${baseline.cases.map(c=>JSON.stringify(c.method)).join(',')}})cases.Add(new{method=name,result=typeof(CadFloatBinaryFixture).GetMethod(name)!.Invoke(null,null)});var input=JsonDocument.Parse(Console.In.ReadToEnd());var parsing=new string[input.RootElement.GetArrayLength()][];int n=0;foreach(var c in input.RootElement.EnumerateArray()){var text=c.GetProperty("text").GetString();var style=(NumberStyles)c.GetProperty("style").GetInt32();parsing[n++]=new[]{double.TryParse(text,style,CultureInfo.InvariantCulture,out var d)?BitConverter.DoubleToUInt64Bits(d).ToString("x"):"bad",float.TryParse(text,style,CultureInfo.InvariantCulture,out var f)?BitConverter.SingleToUInt32Bits(f).ToString("x"):"bad"};}Console.WriteLine("ORACLE:"+JsonSerializer.Serialize(new{runtime=Environment.Version.ToString(),cases,parsing}));`);
 await writeFile(join(directory,'Native.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType><InvariantGlobalization>true</InvariantGlobalization><WarningLevel>0</WarningLevel></PropertyGroup></Project>');
 const processResult=spawnSync(process.env.DOTNET??'dotnet',['run','--project',join(directory,'Native.csproj'),'--configuration','Release','--verbosity','quiet','-p:UseSharedCompilation=false'],{encoding:'utf8',input:JSON.stringify(inputs),maxBuffer:8*1024*1024});
 if(processResult.status!==0)throw Error(processResult.stderr||processResult.stdout||String(processResult.error));
 const line=processResult.stdout.split('\n').find(line=>line.startsWith('ORACLE:'));assert.ok(line,'native oracle output');const actual=JSON.parse(line.slice(7));
 for(let i=0;i<inputs.length;i++)for(let single=0;single<2;single++){
  const item=inputs[i],type=single?'System.Single':'System.Double',ref={declaringType:type,name:'TryParse',isStatic:true,returnType:'System.Boolean',parameters:['System.String','System.Globalization.NumberStyles','System.IFormatProvider',type+'&']};
  let value;const output={$byref:true,get:()=>value,set:v=>value=v},result=invokeCadFloatParseBuiltin({},ref,[item.text,i4(item.style),null,output]);
  const bits=result.value.value?BigInt.asUintN(single?32:64,value.floatBits).toString(16):'bad';assert.equal(bits,actual.parsing[i][single],`${type} input ${i}, style ${item.style}: ${item.text}`);
 }
 console.log(`PASS ${inputs.length*2} native CLR differential floating parser cases, including exact IEEE half-way boundaries.`);
 assert.deepEqual(actual.cases,baseline.cases);console.log(`PASS native .NET ${actual.runtime} matches ${baseline.cases.reduce((n,c)=>n+c.result.length,0)} checked-in managed Wasm floating/binary oracle cases.`);
}finally{await rm(directory,{recursive:true,force:true});}
