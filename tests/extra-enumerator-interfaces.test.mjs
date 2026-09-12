import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const source=readFileSync(new URL('./extra-enumerator-interfaces-fixture.cs',import.meta.url),'utf8');
const model=JSON.parse(readFileSync(new URL('./extra-enumerator-interfaces-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(readFileSync(new URL('./extra-enumerator-interfaces-baseline.json',import.meta.url),'utf8'));
const nativeCases=baseline.cases;
test('extra collection interface enumerator fixture authenticates its real .NET oracle source',()=>{
  assert.equal(baseline.sourceSha256,createHash('sha256').update(source).digest('hex'));
  assert.equal(baseline.runtime,'10.0.0');
});
for(const optimize of [false,'blocks',true])test(`extra collection interface enumerator comparisons match .NET, JavaScript optimize=${optimize}`,()=>{
  const program=compileAssembly(model,{strict:true,optimize});
  for(const item of baseline.cases)assert.deepEqual(program.invoke(`ExtraEnumeratorInterfacesFixture::${item.method}`),item.result,item.method);
});
for(const optimize of [false,true])test(`extra collection interface enumerator comparisons match .NET, native Wasm optimize=${optimize}`,async()=>{
  const artifact=compileWasm(model,{optimize,exports:nativeCases.map(item=>`ExtraEnumeratorInterfacesFixture::${item.method}`)});
  assert.ok(WebAssembly.validate(artifact.bytes));
  const program=await loadWasm(artifact.bytes);
  try{for(const item of nativeCases)assert.deepEqual(program.invoke(`ExtraEnumeratorInterfacesFixture::${item.method}`),item.result,item.method);}
  finally{program.dispose();}
});
