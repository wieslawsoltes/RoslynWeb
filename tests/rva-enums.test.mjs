import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileAssembly} from '../src/il/compiler.mjs';
import {createRuntime,i4,toJS} from '../src/il/runtime.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const model=JSON.parse(await readFile(new URL('./rva-enums-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(await readFile(new URL('./rva-enums-baseline.json',import.meta.url),'utf8'));
const exports=baseline.cases.map(({method})=>`RvaEnumsFixture.${method}`);
test('enum RVA baseline authenticates genuine C# and all eight initializer paths',async()=> {
  assert.equal(createHash('sha256').update(await readFile(new URL('./rva-enums-fixture.cs',import.meta.url))).digest('hex'),baseline.sourceSha256);
  assert.equal(baseline.cases.length,8);
  const fixture=model.types.find(type=>type.name==='RvaEnumsFixture');
  for(const {method} of baseline.cases) {
    const body=fixture.methods.find(item=>item.name===method).body;
    assert.ok(body.some(instruction=>instruction.operand?.name==='InitializeArray'),method+' emits genuine RVA initialization');
  }
});
for(const optimize of [false,'blocks',true])test(`enum RVA data agrees with managed .NET on JS optimize=${optimize}`,()=> {
  const program=compileAssembly(model,{strict:true,optimize,exports});
  for(const {method,result} of baseline.cases)assert.deepEqual(program.invoke(`RvaEnumsFixture::${method}`),result,method);
});
for(const optimize of [false,true])test(`enum RVA data agrees with managed .NET on native Wasm optimize=${optimize}`,async()=> {
  const program=await loadWasm(compileWasm(model,{exports,optimize}).bytes);
  try {for(const {method,result} of baseline.cases)assert.deepEqual(program.invoke(`RvaEnumsFixture::${method}`),result,method);}
  finally {program.dispose();}
});
test('truncated primitive and enum RVA data throws before any destination mutation',()=> {
  const runtime=createRuntime(model);
  const widths=new Map([['System.Byte',1],['System.SByte',1],['System.Int16',2],['System.UInt16',2],['System.Int32',4],['System.UInt32',4],['System.Int64',8],['System.UInt64',8],['System.Char',2],['System.Boolean',1],['System.Single',4],['System.Double',8]]);
  const enums=model.types.filter(type=>type.isEnum).map(type=>[type.name,widths.get(type.fields.find(field=>field.name==='value__').type)]);
  for(const [elementType,width] of [...widths,...enums]) {
    const before=[i4(17),i4(23)],array={$array:true,elementType,items:[...before]};
    assert.throws(()=>runtime.initializeArray(array,new Uint8Array(width*2-1)),error=>error.$type==='System.ArgumentException',elementType);
    assert.deepEqual(array.items,before,elementType+' leaves elements untouched');
  }
});
test('RVA floating values preserve signed zero, signaling NaNs and payloads',()=> {
  const runtime=createRuntime(model);
  for(const [type,width,method,resultType,values] of [
    ['System.Single',4,'SingleToInt32Bits','System.Int32',[0x80000000n,0x7f801234n,0xffc05678n]],
    ['System.Double',8,'DoubleToInt64Bits','System.Int64',[0x8000000000000000n,0x7ff0000000001234n,0xfff8000000005678n]]
  ]) {
    const bytes=new Uint8Array(width*values.length),view=new DataView(bytes.buffer);
    values.forEach((bits,index)=>width===4?view.setUint32(index*width,Number(bits),true):view.setBigUint64(index*width,bits,true));
    const array={$array:true,elementType:type,items:values.map(()=>null)};runtime.initializeArray(array,bytes);
    const ref={declaringType:'System.BitConverter',name:method,isStatic:true,returnType:resultType,parameters:[{type}]};
    array.items.forEach((value,index)=> {
      const result=runtime.callBuiltin(ref,[value],null,'call');assert.equal(result.handled,true);
      assert.equal(BigInt(toJS(result.value)),BigInt.asIntN(width*8,values[index]));
    });
  }
});
