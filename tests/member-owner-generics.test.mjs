import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const model=JSON.parse(await readFile(new URL('./member-owner-generics-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(await readFile(new URL('./member-owner-generics-baseline.json',import.meta.url),'utf8'));
const exports=baseline.cases.map(({method})=>`MemberOwnerGenericsFixture.${method}`);
test('generic member-owner signature baseline authenticates genuine compiled C#',async()=> {
  assert.equal(createHash('sha256').update(await readFile(new URL('./member-owner-generics-fixture.cs',import.meta.url))).digest('hex'),baseline.sourceSha256);
  assert.deepEqual(baseline.cases.map(item=>item.result),[['41','dictionary value'],['17','second','first','second'],['nested','31'],['3.5','method','String:Int32:Int64:Double','Int32:String:Byte:Boolean']]);
});
for(const optimize of [false,'blocks',true])test(`closed generic member-owner parameters, return values, fields and MethodSpecs matches CLR on JS optimize=${optimize}`,()=> {
  const program=compileAssembly(model,{strict:true,optimize,exports});
  for(const {method,result} of baseline.cases)assert.deepEqual(program.invoke(`MemberOwnerGenericsFixture::${method}`),result,method);
});
for(const optimize of [false,true])test(`closed generic member-owner parameters, return values, fields and MethodSpecs matches CLR on native Wasm optimize=${optimize}`,async()=> {
  const program=await loadWasm(compileWasm(model,{exports,optimize}).bytes);
  try {for(const {method,result} of baseline.cases)assert.deepEqual(program.invoke(`MemberOwnerGenericsFixture::${method}`),result,method);}
  finally {program.dispose();}
});
