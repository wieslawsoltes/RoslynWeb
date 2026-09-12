// Recompile genuine C# closed generic delegate targets and compare both generated backends
// with the managed .NET WebAssembly runtime; no native SDK is required.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/node/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=await readFile(new URL('./delegate-generics-fixture.cs',import.meta.url),'utf8');
const methods=['MethodIdentity','ReturnIdentity','TypeIdentity','Collections'];
const compiler=await createRoslyn({startupTimeoutMs:90000});
try {
  const assembly=await compiler.compile(source,{assemblyName:'DelegateGenericsFixture',outputKind:'library',optimization:'release',includeInspection:true,emitPdb:false});
  assert.equal(assembly.success,true,JSON.stringify(assembly.diagnostics));
  const model=assembly.inspection??await compiler.inspect(assembly),cases=[];
  for(const method of methods) {
    const result=await compiler.invoke(assembly.assemblyId,'DelegateGenericsFixture',method);
    assert.equal(result.success,true,JSON.stringify(result.error));cases.push({method,result:result.result});
  }
  const report={runtime:compiler.info.runtimeVersion,sourceSha256:createHash('sha256').update(source).digest('hex'),cases};
  const json=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?{$int64:String(item)}:item,2)+'\n';
  if(process.argv.includes('--update')) {
    await writeFile(new URL('./delegate-generics-fixture.json',import.meta.url),json(model));
    await writeFile(new URL('./delegate-generics-baseline.json',import.meta.url),json(report));
  }
  const exports=methods.map(method=>`DelegateGenericsFixture.${method}`);
  for(const optimize of [false,'blocks',true]) {
    const program=compileAssembly(model,{strict:true,optimize,exports});
    for(const {method,result} of cases)assert.deepEqual(program.invoke(`DelegateGenericsFixture::${method}`),result,`${method} JS ${optimize}`);
  }
  for(const optimize of [false,true]) {
    const program=await loadWasm(compileWasm(model,{exports,optimize}).bytes);
    try {for(const {method,result} of cases)assert.deepEqual(program.invoke(`DelegateGenericsFixture::${method}`),result,`${method} native Wasm ${optimize}`);}
    finally {program.dispose();}
  }
  console.log(`PASS ${cases.length} genuine C# generic delegate scenarios on three JS and two native-Wasm compiler modes.`);
} finally {await compiler.close();}
