import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,copyFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./cad-collections-fixture.cs',import.meta.url),'utf8');
const methods=['Reverse','Sort','LargeSort','Unsigned','Searches','FindRanges','SearchBinary','CollectionInterfaces','PairInterfaces','DictionaryViews','HashtableKeys','HashtableComparer','HashtableEnumerator','ExtraEnumDefaults','ExtraEnumCopies','ExtraEnumDisposal','ExtraInterfaces','QueueStackCurrent','InterfaceEnumerators'];
const cases=[...methods.map(method=>({method,args:[]})),...Array.from({length:33},(_,value)=>({method:'Error',args:[value]}))];
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const json=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?{$int64:String(v)}:v,2)+'\n';
if(process.env.DOTNET){const dir=await mkdtemp(join(tmpdir(),'cad-collections-native-'));try{
 await copyFile(new URL('./cad-collections-fixture.cs',import.meta.url),join(dir,'Fixture.cs'));
 await writeFile(join(dir,'Program.cs'),`using System;using System.Collections.Generic;using System.Text.Json;var result=new List<string>();foreach(string name in new[]{${methods.map(x=>JSON.stringify(x)).join(',')}})result.Add((string)typeof(CadCollectionsFixture).GetMethod(name)!.Invoke(null,null)!);for(int i=0;i<33;i++)result.Add(CadCollectionsFixture.Error(i));Console.Write(JsonSerializer.Serialize(result));`);
 await writeFile(join(dir,'Native.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup></Project>');
 const result=spawnSync(process.env.DOTNET,['run','--project',join(dir,'Native.csproj'),'-c','Release','--verbosity','quiet'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr+result.stdout);const values=JSON.parse(result.stdout);for(let i=0;i<cases.length;i++)cases[i].result=values[i];console.log('PASS native .NET oracle',cases.length);
}finally{await rm(dir,{recursive:true,force:true});}}
const compiler=await createRoslyn({startupTimeoutMs:120000});
try{
 const assembly=succeed(await compiler.compile(source,{assemblyName:'CadCollectionsFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));const model=assembly.inspection??await compiler.inspect(assembly);
 for(const item of cases){const actual=succeed(await compiler.invoke(assembly.assemblyId,'CadCollectionsFixture',item.method,item.args)).result;if('result'in item)assert.deepEqual(actual,item.result,`managed ${item.method} ${item.args}`);item.result=actual;}
 if(process.argv.includes('--update')){await writeFile(new URL('./cad-collections-fixture.json',import.meta.url),json(model));await writeFile(new URL('./cad-collections-baseline.json',import.meta.url),json(cases));}
 for(const optimize of [false,'blocks',true]){const program=compileAssembly(model,{strict:true,optimize,exports:[...methods,'Error']});for(const item of cases)assert.deepEqual(program.invoke('CadCollectionsFixture::'+item.method,item.args),item.result,`${item.method} ${item.args} JS ${optimize}`);console.log('PASS JS collections',optimize,cases.length);}
 for(const optimize of [false,true]){const artifact=compileWasm(model,{exports:[...methods,'Error'],optimize});const program=await loadWasm(artifact.bytes);try{for(const item of cases)assert.deepEqual(program.invoke('CadCollectionsFixture::'+item.method,item.args),item.result,`${item.method} ${item.args} Wasm ${optimize}`);}finally{program.dispose();}console.log('PASS Wasm collections',optimize,cases.length);}
}finally{await compiler.close();}
