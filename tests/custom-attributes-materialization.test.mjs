import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const model=JSON.parse(await readFile(new URL('./custom-attributes-materialization-fixture.json',import.meta.url)));
const baseline=JSON.parse(await readFile(new URL('./custom-attributes-materialization-baseline.json',import.meta.url)));
const source=await readFile(new URL('./custom-attributes-materialization-fixture.cs',import.meta.url));
assert.equal(createHash('sha256').update(source).digest('hex'),baseline.sourceSha256);
const exports=baseline.cases.map(item=>`${item.type ?? "Probe"}::${item.method}`);
for(const optimize of [false,'blocks',true]) test(`custom attribute boxes, generic types and UInt64 match .NET; JS optimize=${optimize}`,()=>{
  const runtime=compileAssembly(model,{strict:true,optimize,exports});
  for(const item of baseline.cases) assert.equal(runtime.invoke(`${item.type ?? "Probe"}::${item.method}`),item.result,item.method);
});
for(const optimize of [false,true]) test(`metadata-only attribute constructors and setters execute in native Wasm; optimize=${optimize}`,async()=>{
  const artifact=compileWasm(model,{optimize,exports});
  const runtime=await loadWasm(artifact.bytes);
  try {for(const item of baseline.cases) assert.equal(runtime.invoke(`${item.type ?? "Probe"}::${item.method}`),item.result,item.method);}
  finally {runtime.dispose();}
});
