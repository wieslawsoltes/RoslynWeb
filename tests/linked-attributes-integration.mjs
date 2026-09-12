import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const sources=await Promise.all(['linked-attributes-library.cs','linked-attributes-fixture.cs'].map(name=>readFile(new URL(name,import.meta.url),'utf8')));
const compiler=await createRoslyn({startupTimeoutMs:90000});
const succeed=r=>{assert.equal(r.success,true,JSON.stringify(r.error??r.diagnostics));return r;};
try{
  const dependency=succeed(await compiler.compile(sources[0],{assemblyName:'LinkedAttributeLibrary',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  await compiler.addDll('LinkedAttributeLibrary.dll',dependency.pe);
  const assembly=succeed(await compiler.compile(sources[1],{assemblyName:'LinkedAttributesFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model=assembly.inspection??await compiler.inspect(assembly),library=dependency.inspection??await compiler.inspect(dependency);
  const result=succeed(await compiler.invoke(assembly.assemblyId,'LinkedAttributesFixture','Values')).result;
  const report={runtime:compiler.info.runtimeVersion,sourceSha256:sources.map(source=>createHash('sha256').update(source).digest('hex')),result};
  const exports=['LinkedAttributesFixture::Values'],assemblies=[library];
  for(const optimize of [false,'blocks',true])assert.deepEqual(compileAssembly(model,{assemblies,exports,optimize,strict:true}).invoke(exports[0]),result,`JS optimize=${optimize}`);
  for(const optimize of [false,true]){
    const runtime=await loadWasm(compileWasm(model,{assemblies,exports,optimize}).bytes);
    try{assert.deepEqual(runtime.invoke(exports[0]),result,`native Wasm optimize=${optimize}`);}finally{runtime.dispose();}
  }
  if(process.argv.includes('--update')){
    const json=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?{$int64:String(item)}:item,2)+'\n';
    await writeFile(new URL('./linked-attributes-fixture.json',import.meta.url),json({model,library}));
    await writeFile(new URL('./linked-attributes-baseline.json',import.meta.url),json(report));
  }
  console.log(`PASS ${result.length} linked generic attribute results and metadata-only constructor/setter dependencies in five modes match .NET ${report.runtime}.`);
}finally{await compiler.close();}
