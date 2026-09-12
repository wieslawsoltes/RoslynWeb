import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const revive=(_k,v)=>v?.$int64?BigInt(v.$int64):v;
const model=JSON.parse(await readFile(new URL('./collection-copy-fixture.json',import.meta.url),'utf8'),revive);
const cases=JSON.parse(await readFile(new URL('./collection-copy-baseline.json',import.meta.url),'utf8'),revive);
for(const optimize of [false,'blocks',true]) {
  const program=compileAssembly(model,{strict:true,optimize});
  for(const item of cases)test(`collection copy ${item.method}(${item.args}) JavaScript ${optimize}`,()=>assert.deepEqual(program.invoke('CollectionCopyFixture::'+item.method,item.args),item.result));
}
for(const optimize of [false,true])test(`collection copy native Wasm ${optimize}`,async()=>{
  const artifact=compileWasm(model,{exports:[...new Set(cases.map(item=>item.method))],optimize});const program=await loadWasm(artifact.bytes);
  try{for(const item of cases)assert.deepEqual(program.invoke('CollectionCopyFixture::'+item.method,item.args),item.result,`${item.method}(${item.args})`);}finally{program.dispose();}
});
