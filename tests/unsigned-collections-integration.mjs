// Rebuild the real C# fixture and its .NET oracle; compare both execution tiers.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./unsigned-collections-fixture.cs',import.meta.url),'utf8');
const methods=['ListSort','ListSearch','Comparers','SortedSets','SortedDictionaries','SignedControls','CustomComparers'];
// Every represented collection enumerator is exercised on both generated tiers.
const nativeMethods=methods;
const succeed=result=>{assert.equal(result.success,true,JSON.stringify(result.error??result.diagnostics));return result;};
const compiler=await createRoslyn({startupTimeoutMs:90000,timeoutMs:300000});
try{
  const assembly=succeed(await compiler.compile(source,{assemblyName:'UnsignedCollectionsFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false}));
  const model=assembly.inspection??await compiler.inspect(assembly),cases=[];
  for(const method of methods)cases.push({method,result:succeed(await compiler.invoke(assembly.assemblyId,'UnsignedCollectionsFixture',method)).result});
  const baseline={runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases};
  if(process.argv.includes('--update')){
    await writeFile(new URL('./unsigned-collections-fixture.json',import.meta.url),JSON.stringify(model,null,2)+'\n');
    await writeFile(new URL('./unsigned-collections-baseline.json',import.meta.url),JSON.stringify(baseline,null,2)+'\n');
  }
  for(const optimize of [false,'blocks',true]){
    const program=compileAssembly(model,{strict:true,optimize});
    for(const item of cases)assert.deepEqual(program.invoke(`UnsignedCollectionsFixture::${item.method}`),item.result,`${item.method}, JavaScript optimize=${optimize}`);
    console.log(`PASS unsigned collections JavaScript optimize=${optimize}`);
  }
  for(const optimize of [false,true]){
    const artifact=compileWasm(model,{optimize,exports:nativeMethods.map(method=>`UnsignedCollectionsFixture::${method}`)});
    assert.ok(WebAssembly.validate(artifact.bytes));
    const program=await loadWasm(artifact.bytes);
    try{for(const item of cases.filter(item=>nativeMethods.includes(item.method)))assert.deepEqual(program.invoke(`UnsignedCollectionsFixture::${item.method}`),item.result,`${item.method}, native Wasm optimize=${optimize}`);}
    finally{program.dispose();}
    console.log(`PASS unsigned collections native Wasm optimize=${optimize}`);
  }
  console.log(`PASS ${cases.length} JavaScript and ${nativeMethods.length} native-Wasm comparison methods against .NET ${baseline.runtime}.`);
}finally{await compiler.close();}
