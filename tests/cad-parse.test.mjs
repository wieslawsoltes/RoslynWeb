import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
import {isCadParseBuiltin,invokeCadParseBuiltin} from '../src/il/cad-parse.mjs';
import {i4} from '../src/il/runtime.mjs';
const source=readFileSync(new URL('./cad-parse-fixture.cs',import.meta.url),'utf8');
const model=JSON.parse(readFileSync(new URL('./cad-parse-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(readFileSync(new URL('./cad-parse-baseline.json',import.meta.url),'utf8'));
test('integer parse fixture matches its .NET oracle source',()=>assert.equal(baseline.sourceSha256,createHash('sha256').update(source).digest('hex')));
for(const optimize of [false,'blocks',true])test(`integer Parse/TryParse matches .NET ${baseline.runtime}, optimize=${optimize}`,()=>{
  const program=compileAssembly(model,{strict:true,optimize});
  for(const item of baseline.cases)assert.deepEqual(program.invoke(`CadParseFixture::${item.method}`),item.result,item.method);
});
for(const optimize of [false,true])test(`integer Parse/TryParse matches .NET ${baseline.runtime} in native Wasm, optimize=${optimize}`,async()=>{
  const artifact=compileWasm(model,{optimize,exports:baseline.cases.map(item=>`CadParseFixture::${item.method}`)});assert.ok(WebAssembly.validate(artifact.bytes));
  const program=await loadWasm(artifact.bytes);
  try{for(const item of baseline.cases)assert.deepEqual(program.invoke(`CadParseFixture::${item.method}`),item.result,item.method);}
  finally{program.dispose();}
});
const ref={declaringType:'System.Int32',name:'TryParse',isStatic:true,returnType:'System.Boolean',parameters:[{type:'System.String'},{type:'System.Globalization.NumberStyles'},{type:'System.IFormatProvider'},{type:'System.Int32&'}]};
test('integer parsing admission requires the exact overload and out type',()=>{
  assert.ok(isCadParseBuiltin(ref));
  for(const altered of [{isStatic:false},{returnType:'System.Int32'},{genericParameterCount:1},{parameters:['System.String','System.Globalization.NumberStyles','System.IFormatProvider','System.Int64&']},{parameters:['System.ReadOnlySpan`1<System.Char>','System.Globalization.NumberStyles','System.IFormatProvider','System.Int32&']}])assert.equal(isCadParseBuiltin({...ref,...altered}),false);
});
test('TryParse invalid styles leave the caller output unchanged, syntax failure zeros it',()=>{
  let value=i4(23);const output={$byref:true,get:()=>value,set:v=>value=v};
  assert.throws(()=>invokeCadParseBuiltin({},ref,[null,i4(516),null,output]),e=>e.$type==='System.ArgumentException');assert.equal(value.value,23);
  assert.equal(invokeCadParseBuiltin({},ref,['bad',i4(7),null,output]).value.value,0);assert.equal(value.value,0);
});
test('huge decimal exponents and leading zeros parse without unbounded BigInt allocation',()=>{
  let value;const output={$byref:true,get:()=>value,set:v=>value=v};
  for(const input of ['0e999999999999999999999999999','0'.repeat(100000)+'12']){
    assert.equal(invokeCadParseBuiltin({},ref,[input,i4(167),null,output]).value.value,1);assert.equal(value.value,input[1]==='e'?0:12);
  }
  assert.equal(invokeCadParseBuiltin({},ref,['1e99999999999999999999',i4(167),null,output]).value.value,0);assert.equal(value.value,0);
});
