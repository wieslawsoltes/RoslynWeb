import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
import {isCadFormatBuiltin,invokeCadFormatBuiltin} from '../src/il/cad-format.mjs';
import {r8} from '../src/il/runtime.mjs';

const source=readFileSync(new URL('./cad-format-fixture.cs',import.meta.url),'utf8');
const model=JSON.parse(readFileSync(new URL('./cad-format-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(readFileSync(new URL('./cad-format-baseline.json',import.meta.url),'utf8'));
test('numeric formatting fixture matches its .NET oracle source',()=>assert.equal(baseline.sourceSha256,createHash('sha256').update(source).digest('hex')));
for(const optimize of [false,'blocks',true])test(`invariant numeric formats match .NET ${baseline.runtime}, optimize=${optimize}`,()=>{
  const program=compileAssembly(model,{strict:true,optimize});
  for(const item of baseline.cases){const actual=program.invoke(`CadFormatFixture::${item.method}`);assert.equal(actual.length,item.result.length);for(let i=0;i<actual.length;i++)assert.equal(actual[i],item.result[i],`${item.method}[${i}]`);}
});
for(const optimize of [false,true])test(`invariant numeric formats match .NET ${baseline.runtime} in native Wasm, optimize=${optimize}`,async()=>{
  const artifact=compileWasm(model,{optimize,exports:baseline.cases.map(item=>`CadFormatFixture::${item.method}`)});
  assert.ok(WebAssembly.validate(artifact.bytes));
  const program=await loadWasm(artifact.bytes);
  try {for(const item of baseline.cases){const actual=program.invoke(`CadFormatFixture::${item.method}`);assert.equal(actual.length,item.result.length);for(let i=0;i<actual.length;i++)assert.equal(actual[i],item.result[i],`${item.method}[${i}]`);}}
  finally {program.dispose();}
});
const ref={declaringType:'System.Double',name:'ToString',isStatic:false,returnType:'System.String',parameters:[{type:'System.String'},{type:'System.IFormatProvider'}]};
const invariant={$type:'System.Globalization.CultureInfo',name:''};
test('numeric formatting admission requires exact signatures',()=>{
  assert.ok(isCadFormatBuiltin(ref));
  for(const altered of [{isStatic:true},{returnType:'System.Object'},{genericParameterCount:1},{parameters:[{type:'System.Object'},{type:'System.IFormatProvider'}]},{parameters:[{type:'System.Int32'}]}])assert.equal(isCadFormatBuiltin({...ref,...altered}),false);
});
test('foreign providers, unimplemented formats, and excess precision are explicit limitations',()=>{
  for(const [format,provider] of [['G',{$type:'System.Globalization.CultureInfo',name:'fr-FR'}],['G',{}],['N',invariant],['#,##0.00',invariant],['F1001',invariant]])assert.throws(()=>invokeCadFormatBuiltin({},ref,[format,provider],r8(1.25)),e=>e.details?.runtimeLimitation===true||e.runtimeLimitation===true);
});

test('null numeric format providers use deterministic invariant current culture',()=>assert.equal(invokeCadFormatBuiltin({},ref,['G',null],r8(1.25)).value,'1.25'));
