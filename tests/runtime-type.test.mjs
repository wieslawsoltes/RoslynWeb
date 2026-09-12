import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const model=JSON.parse(await readFile(new URL('./runtime-type-fixture.json',import.meta.url)));
const baseline=JSON.parse(await readFile(new URL('./runtime-type-baseline.json',import.meta.url)));
const source=await readFile(new URL('./runtime-type-fixture.cs',import.meta.url));
assert.equal(createHash('sha256').update(source).digest('hex'),baseline.sourceSha256);
const exports=baseline.cases.map(item=>`RuntimeTypeFixture::${item.method}`);
for(const optimize of [false,'blocks',true]) test(`constrained GetType preserves enums, primitives, boxes and references; JS optimize=${optimize}`,()=>{
  const runtime=compileAssembly(model,{strict:true,optimize,exports});
  for(const item of baseline.cases)assert.deepEqual(runtime.invoke(`RuntimeTypeFixture::${item.method}`),item.result,item.method);
});
for(const optimize of [false,true]) test(`constrained GetType matches managed results in native Wasm; optimize=${optimize}`,async()=>{
  const runtime=await loadWasm(compileWasm(model,{optimize,exports}).bytes);
  try{for(const item of baseline.cases)assert.deepEqual(runtime.invoke(`RuntimeTypeFixture::${item.method}`),item.result,item.method);}
  finally{runtime.dispose();}
});
