import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./custom-attributes-fixture.cs',import.meta.url),'utf8');
const methods=['Values','Queries','Nulls','Inheritance','PseudoDefinitions','Errors'];
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
const compiler=await createRoslyn({startupTimeoutMs:90000});
try {
  const assembly=succeed(await compiler.compile(source,{assemblyName:'CustomAttributesFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model=assembly.inspection??await compiler.inspect(assembly),cases=[];
  for(const method of methods)cases.push({method,result:succeed(await compiler.invoke(assembly.assemblyId,'CustomAttributesFixture',method)).result});
  const report={runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases};
  const json=v=>JSON.stringify(v,(_key,value)=>typeof value==='bigint'?{$int64:String(value)}:value,2)+'\n';
  if(process.argv.includes('--update')){await writeFile(new URL('./custom-attributes-fixture.json',import.meta.url),json(model));await writeFile(new URL('./custom-attributes-baseline.json',import.meta.url),json(report));}
  if(!process.argv.includes('--oracle-only')) {
    for(const optimize of [false,'blocks',true]) {
      const program=compileAssembly(model,{strict:true,optimize});
      for(const item of cases){assert.deepEqual(program.invoke(`CustomAttributesFixture::${item.method}`),item.result,`${item.method}, optimize=${optimize}`);console.log(`PASS ${item.method} optimize=${optimize}`);}
    }
    for(const optimize of [false,true]) {
      const artifact=compileWasm(model,{exports:methods.map(x=>`CustomAttributesFixture::${x}`),optimize});
      const program=await loadWasm(artifact.bytes);
      try {for(const item of cases){assert.deepEqual(program.invoke(`CustomAttributesFixture::${item.method}`),item.result,`${item.method}, native-Wasm optimize=${optimize}`);console.log(`PASS ${item.method} native-Wasm optimize=${optimize}`);}}
      finally {program.dispose();}
    }
  }
  console.log(`PASS ${methods.length} custom attribute scenarios match .NET ${report.runtime}.`);
} finally {await compiler.close();}
