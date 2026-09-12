import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {compileAssembly} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
import {reflectionType,invokeReflectionBuiltin,isReflectionBuiltin} from '../src/il/reflection.mjs';
import {i4} from '../src/il/runtime.mjs';
const model=JSON.parse(await readFile(new URL('./custom-attributes-fixture.json',import.meta.url)));
const baseline=JSON.parse(await readFile(new URL('./custom-attributes-baseline.json',import.meta.url)));
const native=JSON.parse(await readFile(new URL('./custom-attributes-native-baseline.json',import.meta.url)));
const query={declaringType:'System.Reflection.MemberInfo',name:'GetCustomAttributes',parameters:['System.Type','System.Boolean'],returnType:'System.Object[]',isStatic:false};
const fieldOf=(rt,name='Value')=>invokeReflectionBuiltin(rt,{declaringType:'System.Type',name:'GetField',parameters:['System.String'],isStatic:false},[name],reflectionType(rt,'AttributeData')).value;
test('attribute fixtures authenticate original C# and native/managed oracle results',async()=>{
  const digest=createHash('sha256').update(await readFile(new URL('./custom-attributes-fixture.cs',import.meta.url))).digest('hex');
  assert.equal(digest,baseline.sourceSha256);assert.equal(digest,native.sourceSha256);
  for(const c of baseline.cases)assert.deepEqual(c.result,native.results[c.method],c.method);
  const attribute=model.types.find(x=>x.name==='AttributeData').fields.find(x=>x.name==='Value').customAttributes[0];
  assert.equal(attribute.type,'ProbeAttribute');
  assert.deepEqual(attribute.fixedArguments[2],{type:'System.UInt64',value:{$int64:'18446744073709551615'}});
  assert.deepEqual(attribute.fixedArguments[4],{type:'System.Int32',value:42});
  assert.equal(attribute.namedArguments[1].kind,'Property');
});
for(const optimize of [false,'blocks',true])test(`custom attributes C# oracle matches JavaScript optimize=${optimize}`,()=>{
  const runtime=compileAssembly(model,{strict:true,optimize});
  for(const c of baseline.cases)assert.deepEqual(runtime.invoke('CustomAttributesFixture::'+c.method),c.result,c.method);
});
for(const optimize of [false,true])test(`custom attributes C# oracle matches native Wasm optimize=${optimize}`,async()=>{
  const artifact=compileWasm(model,{exports:baseline.cases.map(c=>'CustomAttributesFixture::'+c.method),optimize});
  const runtime=await loadWasm(artifact.bytes);
  try {for(const c of baseline.cases)assert.deepEqual(runtime.invoke('CustomAttributesFixture::'+c.method),c.result,c.method);}
  finally {runtime.dispose();}
});
test('typed attribute array filters follow native CLR object/interface/value semantics',()=>{
  const runtime=compileAssembly(model,{strict:true});const field=fieldOf(runtime);
  for(const [name,expected] of Object.entries(native.filters)) {
    const result=invokeReflectionBuiltin(runtime,query,[reflectionType(runtime,name),i4(0)],field).value;
    assert.equal(result.$type,expected.arrayType,name);assert.equal(result.items.length,expected.count,name);
  }
  const untyped=invokeReflectionBuiltin(runtime,{...query,parameters:['System.Boolean']},[i4(0)],field).value;
  assert.equal(untyped.$type,'System.Object[]');assert.equal(untyped.items[0].$type,'ProbeAttribute');
});
test('undecodable attributes remain visible and fail explicitly only on instantiation',()=>{
  const broken=structuredClone(model);
  broken.types.find(x=>x.name==='AttributeData').fields.find(x=>x.name==='Value').customAttributes[0].decodeError='Unknown external enum width.';
  const runtime=compileAssembly(broken,{strict:true});const field=fieldOf(runtime);
  const args=[reflectionType(runtime,'ProbeAttribute'),i4(0)];
  assert.equal(invokeReflectionBuiltin(runtime,{...query,name:'IsDefined',returnType:'System.Boolean'},args,field).value.value,1);
  assert.throws(()=>invokeReflectionBuiltin(runtime,query,args,field),e=>e.runtimeLimitation===true&&/external enum width/.test(e.message));
  assert.equal(invokeReflectionBuiltin(runtime,query,[reflectionType(runtime,'ManyAttribute'),i4(0)],field).value.items.length,0);
});
test('custom attribute gate admits only implemented member-provider query overloads',()=>{
  assert.equal(isReflectionBuiltin(query),true);
  for(const parameters of [[],['System.Type'],['System.Boolean','System.Type'],['System.Type','System.Boolean','System.Boolean']])assert.equal(isReflectionBuiltin({...query,parameters}),false);
  assert.equal(isReflectionBuiltin({...query,declaringType:'System.Attribute'}),false);
  for(const patch of [{isStatic:true},{returnType:'System.Attribute[]'},{genericArguments:['System.Int32']}])assert.equal(isReflectionBuiltin({...query,...patch}),false);
});

test('pseudo attributes are visible to IsDefined and reject unsupported construction explicitly',()=>{
  const runtime=compileAssembly(model,{strict:true});
  for(const [self,type] of [[reflectionType(runtime,'PseudoType'),'System.SerializableAttribute'],[invokeReflectionBuiltin(runtime,{declaringType:'System.Type',name:'GetField',parameters:['System.String'],isStatic:false},['Skipped'],reflectionType(runtime,'PseudoType')).value,'System.NonSerializedAttribute']]) {
    const args=[reflectionType(runtime,type),i4(0)];
    assert.equal(invokeReflectionBuiltin(runtime,{...query,name:'IsDefined',returnType:'System.Boolean'},args,self).value.value,1);
    assert.throws(()=>invokeReflectionBuiltin(runtime,query,args,self),e=>e.runtimeLimitation===true&&/pseudo-attribute/.test(e.message));
  }
});
test('unsigned JSON metadata tags preserve high bits in materialized attributes',async()=>{
  const tagged=structuredClone(model);
  const attribute=tagged.types.find(x=>x.name==='AttributeData').fields.find(x=>x.name==='Value').customAttributes[0];
  for(const index of [2,3])attribute.fixedArguments[index].value={$uint64:attribute.fixedArguments[index].value.$int64};
  const expected=baseline.cases.find(c=>c.method==='Values').result;
  const js=compileAssembly(tagged,{strict:true});assert.deepEqual(js.invoke('CustomAttributesFixture::Values'),expected);
  const wasm=await loadWasm(compileWasm(tagged,{exports:['CustomAttributesFixture::Values']}).bytes);
  try {assert.deepEqual(wasm.invoke('CustomAttributesFixture::Values'),expected);}finally{wasm.dispose();}
});
