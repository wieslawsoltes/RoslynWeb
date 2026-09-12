import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./runtime-type-fixture.cs',import.meta.url),'utf8');
const methods=['Names','Null'];
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const compiler=await createRoslyn({startupTimeoutMs:90000});
try {
  const assembly=succeed(await compiler.compile(source,{assemblyName:'RuntimeTypeFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model=assembly.inspection??await compiler.inspect(assembly),cases=[];
  for(const method of methods)cases.push({method,result:succeed(await compiler.invoke(assembly.assemblyId,'RuntimeTypeFixture',method)).result});
  const report={runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases};
  const json=v=>JSON.stringify(v,(_key,value)=>typeof value==='bigint'?{$int64:String(value)}:value,2)+'\n';
  if(process.argv.includes('--update')){await writeFile(new URL('./runtime-type-fixture.json',import.meta.url),json(model));await writeFile(new URL('./runtime-type-baseline.json',import.meta.url),json(report));}
  for(const optimize of [false,'blocks',true]) {
    const program=compileAssembly(model,{strict:true,optimize});
    for(const c of cases)assert.deepEqual(program.invoke(`RuntimeTypeFixture::${c.method}`),c.result,`${c.method}, optimize=${optimize}`);
  }
  for(const optimize of [false,true]) {
    const program=await loadWasm(compileWasm(model,{exports:methods.map(x=>`RuntimeTypeFixture::${x}`),optimize}).bytes);
    try {for(const c of cases)assert.deepEqual(program.invoke(`RuntimeTypeFixture::${c.method}`),c.result,`${c.method}, native-Wasm optimize=${optimize}`);}
    finally {program.dispose();}
  }
  console.log(`PASS constrained GetType for eight enum widths, primitives, boxed values, references and null in five generated modes matches .NET ${report.runtime}.`);
} finally {await compiler.close();}
