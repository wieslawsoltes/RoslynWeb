import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const model=JSON.parse(await readFile(new URL('./enumerable-inheritance-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(await readFile(new URL('./enumerable-inheritance-baseline.json',import.meta.url),'utf8'));
const exports=baseline.cases.map(({method})=>`EnumerableInheritanceFixture.${method}`);
test('inherited enumeration oracle authenticates genuine C# source',async()=> {
  assert.equal(createHash('sha256').update(await readFile(new URL('./enumerable-inheritance-fixture.cs',import.meta.url))).digest('hex'),baseline.sourceSha256);
  assert.deepEqual(baseline.cases.map(item=>item.result),[[0,2,4],[3,6,9],[7,11,13]]);
});
for(const optimize of [false,'blocks',true])test(`inherited source/enumerator callbacks survive JS export selection optimize=${optimize}`,()=> {
  const program=compileAssembly(model,{strict:true,optimize,exports});
  for(const {method,result} of baseline.cases)assert.deepEqual(program.invoke(`EnumerableInheritanceFixture::${method}`),result,method);
});
for(const optimize of [false,true])test(`inherited source/enumerator callbacks survive native Wasm export selection optimize=${optimize}`,async()=> {
  const program=await loadWasm(compileWasm(model,{exports,optimize}).bytes);
  try {for(const {method,result} of baseline.cases)assert.deepEqual(program.invoke(`EnumerableInheritanceFixture::${method}`),result,method);}
  finally {program.dispose();}
});
