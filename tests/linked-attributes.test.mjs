import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const {model,library}=JSON.parse(await readFile(new URL('./linked-attributes-fixture.json',import.meta.url)));
const baseline=JSON.parse(await readFile(new URL('./linked-attributes-baseline.json',import.meta.url)));
for(const [index,name]of ['linked-attributes-library.cs','linked-attributes-fixture.cs'].entries())assert.equal(createHash('sha256').update(await readFile(new URL(name,import.meta.url))).digest('hex'),baseline.sourceSha256[index]);
const exports=['LinkedAttributesFixture::Values'],assemblies=[library];
for(const optimize of [false,'blocks',true])test(`linked generic attributes preserve both owner scopes and callback dependencies; JS optimize=${optimize}`,()=>{
  assert.deepEqual(compileAssembly(model,{assemblies,exports,optimize,strict:true}).invoke(exports[0]),baseline.result);
});
for(const optimize of [false,true])test(`native closure retains attribute constructors, base setters and helper initialization across assemblies; optimize=${optimize}`,async()=>{
  const artifact=compileWasm(model,{assemblies,exports,optimize});
  const runtime=await loadWasm(artifact.bytes);
  try{assert.deepEqual(runtime.invoke(exports[0]),baseline.result);}finally{runtime.dispose();}
});
