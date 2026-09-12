import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
import {isCadFloatParseBuiltin,invokeCadFloatParseBuiltin} from '../src/il/cad-float-parse.mjs';
import {isCadBinaryBuiltin,invokeCadBinaryBuiltin} from '../src/il/cad-binary.mjs';
import {i4,i8,floatLiteral} from '../src/il/runtime.mjs';
const source=readFileSync(new URL('./cad-float-binary-fixture.cs',import.meta.url),'utf8');
const model=JSON.parse(readFileSync(new URL('./cad-float-binary-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(readFileSync(new URL('./cad-float-binary-baseline.json',import.meta.url),'utf8'));
test('floating/binary fixture matches its .NET oracle source',()=>assert.equal(baseline.sourceSha256,createHash('sha256').update(source).digest('hex')));
for(const optimize of [false,'blocks',true])test(`floating Parse/TryParse and binary conversion matches .NET ${baseline.runtime}, optimize=${optimize}`,()=>{
  const program=compileAssembly(model,{strict:true,optimize});
  for(const item of baseline.cases)assert.deepEqual(program.invoke(`CadFloatBinaryFixture::${item.method}`),item.result,item.method);
});
for(const optimize of [false,true])test(`floating Parse/TryParse and binary conversion matches .NET ${baseline.runtime} in native Wasm, optimize=${optimize}`,async()=>{
  const artifact=compileWasm(model,{optimize,exports:baseline.cases.map(item=>`CadFloatBinaryFixture::${item.method}`)});assert.ok(WebAssembly.validate(artifact.bytes));
  const program=await loadWasm(artifact.bytes);
  try{for(const item of baseline.cases)assert.deepEqual(program.invoke(`CadFloatBinaryFixture::${item.method}`),item.result,item.method);}
  finally{program.dispose();}
});
const ref={declaringType:'System.Single',name:'TryParse',isStatic:true,returnType:'System.Boolean',parameters:['System.String','System.Globalization.NumberStyles','System.IFormatProvider','System.Single&']};
test('floating parser admission checks target, exact signature, and byref output',()=>{
 assert.ok(isCadFloatParseBuiltin(ref));
 for(const altered of [{isStatic:false},{declaringType:'System.Double'},{returnType:'System.Single'},{genericParameterCount:1},{parameters:['System.String','System.Globalization.NumberStyles','System.IFormatProvider','System.Double&']},{parameters:['System.ReadOnlySpan`1<System.Char>','System.Globalization.NumberStyles','System.IFormatProvider','System.Single&']}])assert.equal(isCadFloatParseBuiltin({...ref,...altered}),false);
});
test('float style exceptions preserve out argument; syntax failure clears it',()=>{
 let value=i4(42);const output={$byref:true,get:()=>value,set:v=>value=v};
 assert.throws(()=>invokeCadFloatParseBuiltin({},ref,[null,i4(515),null,output]),e=>e.$type==='System.ArgumentException');assert.equal(value.value,42);
 assert.equal(invokeCadFloatParseBuiltin({},ref,['bad',i4(167),null,output]).value.value,0);assert.equal(value.value,0);
});
test('single decimal parsing avoids double rounding at a half-way value',()=>{
 let value;const output={$byref:true,get:()=>value,set:v=>value=v};
 const text='1.000000059604644775390625000000000000001';assert.equal(Math.fround(Number(text)),1);
 invokeCadFloatParseBuiltin({},ref,[text,i4(167),null,output]);assert.equal(value.floatBits,0x3f800001n);
});
test('large input is parsed with bounded decimal-to-binary arithmetic',()=>{
 let value;const output={$byref:true,get:()=>value,set:v=>value=v};
 for(const [text,bits] of [['0'.repeat(100000)+'1.25',0x3fa00000n],['1e'+'9'.repeat(100000),0x7f800000n],['-1e-'+'9'.repeat(100000),0x80000000n]]){invokeCadFloatParseBuiltin({},ref,[text,i4(167),null,output]);assert.equal(value.floatBits,bits);}
});
const binaryRef={declaringType:'System.BitConverter',name:'GetBytes',isStatic:true,returnType:'System.Byte[]',parameters:['System.UInt64']};
test('BitConverter admission checks exact primitive signatures',()=>{
 assert.ok(isCadBinaryBuiltin(binaryRef));
 for(const altered of [{isStatic:false},{parameters:['System.Decimal']},{returnType:'System.SByte[]'},{genericParameterCount:1}])assert.equal(isCadBinaryBuiltin({...binaryRef,...altered}),false);
});
test('BitConverter preserves unsigned high bits and signaling NaN payloads',()=>{
 const bytes=invokeCadBinaryBuiltin({},binaryRef,[i8(0xfedcba9876543210n)]).value;assert.deepEqual(bytes.items.map(v=>v.value),[16,50,84,118,152,186,220,254]);
 const q={...binaryRef,parameters:['System.Single']};assert.deepEqual(invokeCadBinaryBuiltin({},q,[floatLiteral('r4',0xff812345n)]).value.items.map(v=>v.value),[69,35,129,255]);
 const result=invokeCadBinaryBuiltin({},{...binaryRef,name:'ToDouble',returnType:'System.Double',parameters:['System.Byte[]','System.Int32']},[{$array:true,items:[1,0,0,0,0,0,240,127]},i4(0)]).value;assert.equal(result.floatBits,0x7ff0000000000001n);
});
