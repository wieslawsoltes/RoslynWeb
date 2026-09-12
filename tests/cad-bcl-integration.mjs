// Real Roslyn C# -> PE inspection -> JavaScript differential verification.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./cad-bcl-fixture.cs',import.meta.url),'utf8');
const methods=['EnumNames','EnumValues','Colors','Strings','OrdinalStrings','Errors'];
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const compiler=await createRoslyn({startupTimeoutMs:90000});
try {
  const assembly=succeed(await compiler.compile(source,{assemblyName:'CadBclFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model=assembly.inspection??await compiler.inspect(assembly),cases=[];
  for(const method of methods)cases.push({method,result:succeed(await compiler.invoke(assembly.assemblyId,'CadBclFixture',method)).result});
  const report={runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases};
  // BigInt constants preserve all 64 bits in the reusable inspection fixture.
  const json=(v)=>JSON.stringify(v,(_key,value)=>typeof value==='bigint'?{$int64:String(value)}:value,2)+'\n';
  if(process.argv.includes('--update')){await writeFile(new URL('./cad-bcl-fixture.json',import.meta.url),json(model));await writeFile(new URL('./cad-bcl-baseline.json',import.meta.url),json(report));}
  for(const optimize of [false,'blocks',true]) {
    const program=compileAssembly(model,{strict:true,optimize});
    for(const item of cases){assert.deepEqual(program.invoke(`CadBclFixture::${item.method}`),item.result,`${item.method}, optimize=${optimize}`);console.log(`PASS ${item.method} optimize=${optimize}`);}
  }
  for(const optimize of [false,true]) {
    const artifact=compileWasm(model,{exports:methods,optimize});
    const program=await loadWasm(artifact.bytes);
    try {for(const item of cases){assert.deepEqual(program.invoke(`CadBclFixture::${item.method}`),item.result,`${item.method}, native-Wasm optimize=${optimize}`);console.log(`PASS ${item.method} native-Wasm optimize=${optimize}`);}}
    finally {program.dispose();}
  }
  console.log(`PASS ${methods.length} CAD framework scenarios match .NET ${report.runtime} in three JavaScript and two native-Wasm compiler modes.`);
} finally {await compiler.close();}
