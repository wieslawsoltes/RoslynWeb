import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {compileAssembly,isBuiltinCandidate} from '../src/il/compiler.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
import {wasmType} from '../src/wasm/analysis.mjs';
import {createRuntime,i4,toJS} from '../src/il/runtime.mjs';
import {genericDefinitionName,splitTypeArguments} from '../src/il/generics.mjs';
import {spanBuiltin,invokeSpanBuiltin} from '../src/il/spans.mjs';
const read=name=>JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8'),(_,v)=>v?.$int64!==undefined?BigInt(v.$int64):v);
const model=read('./spans-fixture.json'),baseline=read('./spans-baseline.json');
const source=readFileSync(new URL('./spans-fixture.cs',import.meta.url),'utf8');
test('span inspection and oracle correspond to the actual C# source and InlineArray attributes',()=>{
 assert.equal(baseline.sourceSha256,createHash('sha256').update(source).digest('hex'));
 assert.equal(model.types.find(t=>t.name==='IntBuffer').inlineArrayLength,4);
 assert.equal(model.types.find(t=>t.name==='ObjectBuffer').inlineArrayLength,3);
 assert.equal(model.types.find(t=>t.name.startsWith('<>y__InlineArray')).inlineArrayLength,4);
});
for(const optimize of [false,'blocks',true])for(const item of baseline.cases)test(`managed spans ${item.method} match .NET ${baseline.runtime}, JS ${optimize}`,()=>{
 const p=compileAssembly(model,{strict:true,optimize,exports:['SpansFixture.'+item.method]});
 assert.deepEqual(p.invoke('SpansFixture::'+item.method),item.result);
});
for(const optimize of [false,true])for(const item of baseline.cases)test(`managed spans ${item.method} match .NET ${baseline.runtime}, native Wasm ${optimize}`,async()=>{
 const a=compileWasm(model,{optimize,exports:['SpansFixture.'+item.method]});assert(WebAssembly.validate(a.bytes));
 const p=await loadWasm(a.bytes);try{assert.deepEqual(p.invoke('SpansFixture::'+item.method),item.result);}finally{p.dispose();}
});
test('native CLR oracle agrees with the managed WebAssembly oracle',()=>{const native=read('./spans-native-baseline.json');assert.equal(native.sourceSha256,baseline.sourceSha256);assert.deepEqual(native.cases,baseline.cases);});
test('generic parsing preserves compiler generated names and locates the final argument list',()=>{
 for(const name of ['<PrivateImplementationDetails>','<>y__InlineArray4`1','P+<Method>d__2']){assert.equal(genericDefinitionName(name),name);assert.deepEqual(splitTypeArguments(name),[]);}
 const type='<>y__InlineArray4`1<System.Collections.Generic.Dictionary`2<System.String,System.Int32>>';
 assert.equal(genericDefinitionName(type),'<>y__InlineArray4`1');assert.deepEqual(splitTypeArguments(type),['System.Collections.Generic.Dictionary`2<System.String,System.Int32>']);
 assert.deepEqual(splitTypeArguments('Pair<System.Int32[,],List<System.String>>'),['System.Int32[,]','List<System.String>']);
});
const ref=(type,name,parameters,result,ga=[])=>({declaringType:type,name,parameters:parameters.map(type=>({type})),returnType:result,isStatic:true,genericParameterCount:ga.length,genericArguments:ga});
test('closed unsafe reinterpretations require verified inline-array metadata or identical managed types',()=>{
 const as=ref('System.Runtime.CompilerServices.Unsafe','As',['!!0&'],'!!1&',['System.Int32','System.Single']);assert.equal(isBuiltinCandidate(as),false);
 const same={...as,genericArguments:['System.Int32','System.Int32']};assert(isBuiltinCandidate(same));
 const inline={...as,genericArguments:['IntBuffer','System.Int32']};assert.equal(isBuiltinCandidate(inline),false);
 assert(isBuiltinCandidate(inline,{types:new Map(model.types.map(t=>[t.name,t]))}));
 assert.equal(isBuiltinCandidate({...inline,genericArguments:['IntBuffer','System.Object']},{types:new Map(model.types.map(t=>[t.name,t]))}),false);
 for(const changed of [{isStatic:false},{returnType:'System.Int32'},{genericParameterCount:3},{parameters:['System.Int32*']}])assert.equal(spanBuiltin({...same,...changed}),null);
});
test('native storage rejects pointer-backed spans, nested spans, boxed spans and malformed generic forms',()=>{
 for(const type of ['System.Span`1<System.Int32>*','System.Span`1<System.Int32>[]','System.Span`1<System.Span`1<System.Int32>>','System.Span`1<System.Int32&>','System.Span`1<System.Int32,System.Object>','System.Span`1','System.Memory`1<System.Int32>'])assert.throws(()=>wasmType(type));
 assert.equal(wasmType('System.Span`1<System.Int32>'),'externref');
 assert.equal(wasmType('System.ReadOnlySpan`1<System.Object>&'),'externref');
 const invalid={name:'InvalidSpan',types:[{name:'P',methods:[{name:'Box',token:1,isStatic:true,returnType:'System.Object',parameters:[],locals:['System.Span`1<System.Int32>'],body:[{offset:0,opcode:'ldloc.0'},{offset:1,opcode:'box',operand:{name:'System.Span`1<System.Int32>'}},{offset:2,opcode:'ret'}]}]}]};
 assert.throws(()=>compileWasm(invalid),error=>error.diagnostics?.some(d=>d.code==='WASM_SPAN_STORAGE'));
});
test('managed Unsafe.Add and MemoryMarshal reject access beyond represented storage without fabricating memory',()=>{
 const rt=createRuntime({name:'SpanStorage',types:[]});const a=rt.newArray('System.Int32',i4(2));a.items[0]=i4(3);a.items[1]=i4(8);const first=rt.arrayAddress(a,i4(0));
 const add=ref('System.Runtime.CompilerServices.Unsafe','Add',['!!0&','System.Int32'],'!!0&',['System.Int32']);
 const third=invokeSpanBuiltin(rt,add,[first,i4(2)]).value;assert.equal(third.$index,2);assert.throws(()=>third.get(),e=>e.$type==='System.IndexOutOfRangeException');
 assert.throws(()=>invokeSpanBuiltin(rt,add,[first,i4(3)]),e=>e.runtimeLimitation===true);
 const make=ref('System.Runtime.InteropServices.MemoryMarshal','CreateReadOnlySpan',['!!0&','System.Int32'],'System.ReadOnlySpan`1<!!0>',['System.Int32']);
 assert.throws(()=>invokeSpanBuiltin(rt,make,[first,i4(3)]),e=>e.runtimeLimitation===true);
 assert.throws(()=>invokeSpanBuiltin(rt,make,[first,i4(-1)]),e=>e.$type==='System.ArgumentOutOfRangeException');
 assert.deepEqual(toJS(a),[3,8]);
});
