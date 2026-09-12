import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const model=JSON.parse(await readFile(new URL('./delegate-generics-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(await readFile(new URL('./delegate-generics-baseline.json',import.meta.url),'utf8'));
const exports=baseline.cases.map(({method})=>`DelegateGenericsFixture.${method}`);
test('generic delegate identity baseline authenticates genuine compiled C#',async()=> {
  assert.equal(createHash('sha256').update(await readFile(new URL('./delegate-generics-fixture.cs',import.meta.url))).digest('hex'),baseline.sourceSha256);
  assert.deepEqual(baseline.cases.map(item=>item.result),['False:True:String:True','False:1:2','False:True:String','2:int:string:2:True']);
});
for(const optimize of [false,'blocks',true])test(`closed generic delegate equality/removal/collection identity matches CLR on JS optimize=${optimize}`,()=> {
  const program=compileAssembly(model,{strict:true,optimize,exports});
  for(const {method,result} of baseline.cases)assert.equal(program.invoke(`DelegateGenericsFixture::${method}`),result,method);
});
for(const optimize of [false,true])test(`closed generic delegate equality/removal/collection identity matches CLR on native Wasm optimize=${optimize}`,async()=> {
  const program=await loadWasm(compileWasm(model,{exports,optimize}).bytes);
  try {for(const {method,result} of baseline.cases)assert.equal(program.invoke(`DelegateGenericsFixture::${method}`),result,method);}
  finally {program.dispose();}
});
