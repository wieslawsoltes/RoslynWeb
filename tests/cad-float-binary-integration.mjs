// Compile the real C# fixture, use managed .NET Wasm as oracle, then compare all
// generated-JavaScript and native-Wasm optimization modes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./cad-float-binary-fixture.cs',import.meta.url),'utf8');
const methods=['Doubles','Singles','Providers','Overloads','Binary','BinaryErrors','LongBoundaries','BinarySignals'];
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const compiler=await createRoslyn({startupTimeoutMs:90000,timeoutMs:300000});
try{
  const assembly=succeed(await compiler.compile(source,{assemblyName:'CadFloatBinaryFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model=assembly.inspection??await compiler.inspect(assembly),cases=[];
  for(const method of methods)cases.push({method,result:succeed(await compiler.invoke(assembly.assemblyId,'CadFloatBinaryFixture',method)).result});
  const report={runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases};
  const json=v=>JSON.stringify(v,(_key,value)=>typeof value==='bigint'?{$int64:String(value)}:value,2)+'\n';
  if(process.argv.includes('--update')){await writeFile(new URL('./cad-float-binary-fixture.json',import.meta.url),json(model));await writeFile(new URL('./cad-float-binary-baseline.json',import.meta.url),json(report));}
  if(!process.argv.includes('--oracle-only'))for(const optimize of [false,'blocks',true]){
    const program=compileAssembly(model,{strict:true,optimize});
    for(const item of cases)assert.deepEqual(program.invoke(`CadFloatBinaryFixture::${item.method}`),item.result,`${item.method}, optimize=${optimize}`);
    console.log(`PASS floating parsing/BitConverter JavaScript optimize=${optimize}`);
  }
  if(!process.argv.includes('--oracle-only'))for(const optimize of [false,true]){
    const artifact=compileWasm(model,{optimize,exports:methods.map(method=>`CadFloatBinaryFixture::${method}`)});assert.ok(WebAssembly.validate(artifact.bytes));
    const program=await loadWasm(artifact.bytes);
    try{for(const item of cases)assert.deepEqual(program.invoke(`CadFloatBinaryFixture::${item.method}`),item.result,`${item.method}, native Wasm optimize=${optimize}`);}
    finally{program.dispose();}
    console.log(`PASS floating parsing/BitConverter native Wasm optimize=${optimize}`);
  }
  console.log(`PASS ${cases.reduce((n,c)=>n+c.result.length,0)} floating parse/TryParse and binary conversion oracle pairs on .NET ${report.runtime}.`);
}finally{await compiler.close();}
