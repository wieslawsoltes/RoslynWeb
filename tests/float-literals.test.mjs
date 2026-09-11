import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileAssembly,generateModule} from '../src/il/compiler.mjs';
import {compileWasm} from '../src/wasm/compiler.mjs';
import {loadWasm} from '../src/wasm/runtime.mjs';
const fixture=JSON.parse(await readFile(new URL('./float-literals-fixture.json',import.meta.url)));
const expected=item=>item.kind==='i64'?BigInt(item.value):Number(item.value);

test('floating literal regression uses the same real PE for native execution and inspection',async()=>{
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(Buffer.from(fixture.peBase64,'base64')),fixture.assemblySha256);
  assert.equal(hash(await readFile(new URL('./float-literals-fixture.cs',import.meta.url))),fixture.sourceSha256);
  assert.equal(fixture.sdk,'10.0.100');assert.equal(fixture.runtime,'10.0.0');
  const methods=fixture.model.types.flatMap(type=>type.methods);
  for(const item of fixture.cases){
    const method=methods.find(method=>method.name===item.method);
    const instruction=method.body.find(instruction=>instruction.opcode==='ldc.r4'||instruction.opcode==='ldc.r8');
    assert.match(instruction.operandBits,instruction.opcode==='ldc.r4'?/^[0-9a-f]{8}$/:/^[0-9a-f]{16}$/);
    if(item.patchedBits)assert.equal(instruction.operandBits,item.patchedBits);
  }
});
for(const optimize of[false,'blocks',true]){
  const runtime=compileAssembly(fixture.model,{optimize});
  for(const item of fixture.cases)test(`JavaScript optimize=${optimize} preserves real PE literal bits: ${item.method}`,()=>assert.equal(runtime.invoke(item.method),expected(item)));
}
for(const optimize of[false,true])for(const item of fixture.cases)test(`Wasm optimize=${optimize} preserves real PE literal bits: ${item.method}`,async()=>{
  const artifact=compileWasm(fixture.model,{exports:[item.method],optimize});
  const program=await loadWasm(artifact);
  try{assert.equal(program.invoke(item.method),expected(item));if(item.method!=='SingleArray')assert.deepEqual(WebAssembly.Module.imports(program.module),[]);}finally{program.dispose();}
});
test('saved JavaScript preserves literal payloads without access to Roslyn or its PE',async()=>{
  const source=generateModule(fixture.model,{runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href});
  const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const runtime=module.createAssembly();for(const item of fixture.cases)assert.equal(runtime.invoke(item.method),expected(item));
});
for(const backend of['javascript','wasm'])test(`${backend} rejects malformed raw literal metadata before execution`,()=>{
  const model=structuredClone(fixture.model);model.types.flatMap(type=>type.methods).find(method=>method.name==='DoubleNaN').body[0].operandBits='not-hex';
  assert.throws(()=>backend==='javascript'?compileAssembly(model):compileWasm(model,{exports:['DoubleNaN']}),/operandBits/);
});
