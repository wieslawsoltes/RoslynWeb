import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {compileAssembly,isBuiltinCandidate} from '../src/il/compiler.mjs';
import {ILRuntime} from '../src/il/runtime.mjs';
import {compileWasm,loadWasm} from '../src/wasm/index.js';
const model=JSON.parse(await readFile(new URL('./file-exceptions-fixture.json',import.meta.url),'utf8'));
const baseline=JSON.parse(await readFile(new URL('./file-exceptions-baseline.json',import.meta.url),'utf8'));
const types=['System.IO.FileNotFoundException','System.IO.FileLoadException'];
const ref=(declaringType,name,parameters=[],returnType='System.Void')=>({declaringType,name,parameters:parameters.map(type=>({type})),returnType,isStatic:false});
test('file exception evidence retains Mono resource/message differences and authentic native results',async()=>{
 const source=await readFile(new URL('./file-exceptions-fixture.cs',import.meta.url));assert.equal(createHash('sha256').update(source).digest('hex'),baseline.sourceSha256);assert.equal(baseline.nativeRuntime,'10.0.0');assert.deepEqual(baseline.managedDifferences,['DefaultMessages','ToStrings']);for(const name of ['ExplicitMetadata','CatchHierarchy','CustomFields','Characters'])assert.deepEqual(baseline.managed[name],baseline.expected[name]);assert.equal(baseline.expected.Characters,2147450880);
});
for(const optimize of [false,'blocks',true])test(`file exceptions and all 65536 character conversions match native .NET in JS ${optimize}`,()=>{
 const runtime=compileAssembly(model,{strict:true,optimize});for(const [name,expected]of Object.entries(baseline.expected))assert.deepEqual(runtime.invoke('FileExceptionsFixture::'+name),expected,name);
});
for(const optimize of [false,true])test(`file exception constructors and properties match native .NET in Wasm ${optimize}`,async()=>{
 const artifact=compileWasm(model,{exports:Object.keys(baseline.expected),optimize});assert.equal(WebAssembly.validate(artifact.bytes),true);const runtime=await loadWasm(artifact.bytes);try{for(const [name,expected]of Object.entries(baseline.expected))assert.deepEqual(runtime.invoke('FileExceptionsFixture::'+name),expected,name);}finally{runtime.dispose();}
});
test('file exception overload admission and runtime reject malformed metadata consistently',()=>{
 const runtime=new ILRuntime({name:'InvalidFileExceptionSignatures',types:[]});for(const type of types){const invalid=[ref(type,'.ctor',['System.Int32']),ref(type,'.ctor',['System.String','System.Object']),ref(type,'.ctor',['System.String','System.String','System.String']),ref(type,'.ctor',[],'System.String'),{...ref(type,'.ctor'),isStatic:true},{...ref(type,'.ctor'),genericArguments:['System.Int32']},ref(type,'get_FileName',[],'System.Object'),ref(type,'get_FileName',['System.String'],'System.String'),ref(type,'get_FusionLog',[],'System.Boolean')];for(const method of invalid){assert.equal(isBuiltinCandidate(method),false,JSON.stringify(method));assert.equal(runtime.callBuiltin(method,method.parameters.map(()=>null),runtime.allocate(type),'call').handled,false,JSON.stringify(method));}}
});
test('file exception constructors retain inner identity and hierarchy through IOException',()=>{
 const runtime=new ILRuntime({name:'FileExceptionIdentity',types:[]});const inner=runtime.allocate('System.IO.IOException');for(const type of types){const exception=runtime.allocate(type);runtime.callBuiltin(ref(type,'.ctor',['System.String','System.String','System.Exception']),['message','drawing.dxf',inner],exception,'newobj');assert.equal(runtime.callBuiltin(ref(type,'get_InnerException',[],'System.Exception'),[],exception,'call').value,inner);assert.equal(runtime.callBuiltin(ref(type,'get_FileName',[],'System.String'),[],exception,'call').value,'drawing.dxf');assert.equal(runtime.inherits(type,'System.IO.IOException'),true);assert.equal(runtime.inherits(type,'System.SystemException'),true);assert.equal(runtime.inherits(type,'System.Exception'),true);}
});
