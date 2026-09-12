// DOTNET=/path/to/dotnet node tests/verify-ordinal-native.mjs [--update]
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoslyn } from '../src/node/index.js';
import { compileAssembly } from '../src/il/compiler.mjs';
import { compileWasm, loadWasm } from '../src/wasm/index.js';
import { ordinalTableInfo, ordinalUpperPairs } from '../src/il/ordinal-tables.mjs';
const directory=await mkdtemp(join(tmpdir(),'roslynweb-ordinal-oracle-'));let compiler;
try {
 const command=promisify(execFile);
 await command(process.execPath,[fileURLToPath(new URL('./generate-ordinal-tables.mjs',import.meta.url))],{encoding:'utf8',timeout:60000});
 const source=await readFile(new URL('./ordinal-unicode-fixture.cs',import.meta.url),'utf8');
 await Promise.all([
  copyFile(new URL('./ordinal-oracle-generator/Program.cs',import.meta.url),join(directory,'Program.cs')),
  writeFile(join(directory,'Fixture.cs'),source),
  writeFile(join(directory,'Native.csproj'),'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>'),
  writeFile(join(directory,'tables.json'),JSON.stringify({mappings:ordinalUpperPairs})),
 ]);
 const result=await command(process.env.DOTNET??'dotnet',['run','--project',join(directory,'Native.csproj'),'--configuration','Release','--verbosity','quiet','-p:UseSharedCompilation=false','--',join(directory,'tables.json')],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
 const baseline={...JSON.parse(result.stdout),sourceSha256:createHash('sha256').update(source).digest('hex'),mappingSha256:ordinalTableInfo.mappingSha256};
 const path=new URL('./ordinal-unicode-baseline.json',import.meta.url);
 compiler=await createRoslyn({startupTimeoutMs:90000});
 const assembly=await compiler.compile(source,{assemblyName:'OrdinalUnicodeFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false});
 assert.equal(assembly.success,true,JSON.stringify(assembly.error??assembly.diagnostics));
 const model=assembly.inspection??await compiler.inspect(assembly);
 if(process.argv.includes('--update')) {
  await writeFile(new URL('./ordinal-unicode-fixture.json',import.meta.url),JSON.stringify(model,null,2)+'\n');
  await writeFile(path,JSON.stringify(baseline)+'\n');
 } else {
  const {runtime:recordedRuntime,...expected}=JSON.parse(await readFile(path,'utf8'));
  const {runtime:actualRuntime,...actual}=baseline;
  // Runtime patches are provenance; mapping/source hashes and every result remain exact.
  assert.equal(actualRuntime.split('.')[0],recordedRuntime.split('.')[0],'Native runtime major version');
  assert.deepEqual(actual,expected,'Native CLR ordinal oracle differs from the reviewed baseline.');
 }
 const str=units=>units==null?null:String.fromCharCode(...units);
 const check=program=>{
  for(const x of baseline.comparisons)assert.deepEqual(program.invoke('OrdinalUnicodeFixture::Compare',[str(x.a),str(x.b)]),x.result,JSON.stringify(x));
  for(const x of baseline.searches)assert.deepEqual(program.invoke('OrdinalUnicodeFixture::Search',[str(x.text),str(x.needle),x.start,x.count]),x.result,JSON.stringify(x));
  for(const x of baseline.collections)assert.deepEqual(program.invoke('OrdinalUnicodeFixture::Collections',[str(x.a),str(x.b)]),x.result,JSON.stringify(x));
 };
 for(const optimize of [false,'blocks',true])check(compileAssembly(model,{strict:true,optimize}));
 for(const optimize of [false,true]){
  const program=await loadWasm(compileWasm(model,{exports:['OrdinalUnicodeFixture::Compare','OrdinalUnicodeFixture::Search','OrdinalUnicodeFixture::Collections'],optimize}).bytes);
  try{check(program);}finally{program.dispose();}
 }
 console.log(`PASS native .NET ${baseline.runtime}: ${baseline.comparisons.length} comparisons, ${baseline.searches.length} searches, ${baseline.collections.length} collection cases in all five generated modes.`);
} finally {await compiler?.close();await rm(directory,{recursive:true,force:true});}
