import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileAssembly,analyzeAssembly,generateModule,i4,toJS} from '../src/il/index.mjs';
const fixture=JSON.parse(await readFile(new URL('./il-v2-fixture.json',import.meta.url),'utf8'));
const externals={'NativeFixture::Add':(a,b)=>a+b};
const method=(name,code,extra={})=>({token:0x06000001,name,declaringType:'Test',isStatic:true,returnType:'System.Int32',parameters:[],locals:[],exceptionHandlers:[],body:code.map(([opcode,operand],offset)=>({offset,opcode,operand})),...extra});
const model=methods=>({name:'Extended',types:[{name:'Test',fields:[],methods}]});

test('real Roslyn closed type/method generic execution and independent static storage',()=>{
 const runtime=compileAssembly(fixture,{externals});
 assert.equal(runtime.invoke('GenericAlgorithms::Main'),42);
 assert.equal(runtime.invoke('GenericAlgorithms::Main'),44);
 const echo=runtime.resolveMethod({name:'Echo',declaringType:'GenericAlgorithms',genericArguments:['System.Int64'],parameters:[{type:'!!0'}]});
 assert.equal(runtime.invoke(echo,[9007199254740993n]),9007199254740993n);
 const zero=runtime.resolveMethod({name:'Default',declaringType:'GenericAlgorithms',genericArguments:['System.Int32'],parameters:[]});
 assert.equal(toJS(runtime.invokeManaged(zero,[],null)),0);
 assert.throws(()=>runtime.invoke('GenericAlgorithms::Echo',[1]),/open generic/);
});
test('real Roslyn multidimensional arrays preserve rank and row major index',()=>{
 const runtime=compileAssembly(fixture,{externals}); assert.equal(runtime.invoke('GenericAlgorithms::Arrays'),46);
 const array=runtime.newMultiArray('System.Int32',[i4(2),i4(3)],[i4(-1),i4(5)]);
 assert.equal(runtime.multiArrayIndex(array,[i4(0),i4(7)]),5);
 assert.throws(()=>runtime.multiArrayIndex(array,[i4(1),i4(5)]),e=>e.$type==='System.IndexOutOfRangeException');
});
test('real PInvoke metadata accepts explicit exports and rejects unresolved import',()=>{
 const native={...fixture,types:fixture.types.filter(t=>t.name==='NativeFixture')};
 assert.equal(analyzeAssembly(native).supported,false);
 assert.equal(analyzeAssembly(native,{externals}).supported,true);
 const runtime=compileAssembly(native,{externals,strict:true});
 assert.equal(runtime.invoke('NativeFixture::Main'),42);
 assert.equal(runtime.invoke('NativeFixture::Add',[12,30]),42);
 const imported=native.types[0].methods.find(m=>m.name==='Add');
 assert.equal(imported.pinvoke.entryPoint,'test_add'); assert.equal(imported.pinvoke.moduleName,'testlib');
});
test('managed calli signature dispatches actual function pointer',()=>{
 const signature={isStatic:true,parameters:[{type:'System.Int32'}],returnType:'System.Int32'};
 const twice=method('Twice',[['ldarg.0'],['ldc.i4.2'],['mul'],['ret']],{token:0x06000002,...signature});
 const main=method('Main',[['ldc.i4',21],['ldftn',{...twice,body:undefined}],['calli',signature],['ret']]);
 assert.equal(compileAssembly(model([main,twice]),{strict:true}).invoke('Main'),42);
 const bad=structuredClone(main);bad.body[2].operand.returnType='System.Int64';
 assert.throws(()=>compileAssembly(model([bad,twice])).invoke('Main'),e=>e.$type==='System.InvalidProgramException');
});
test('localloc/primitive memory access/initblk/cpblk have actual bounded memory semantics',()=>{
 const code=[['ldc.i4.8'],['localloc'],['stloc.0'],['ldloc.0'],['ldc.i4',42],['stind.i4'],['ldloc.0'],['ldc.i4.4'],['add'],['ldc.i4.1'],['ldc.i4.4'],['initblk'],['ldc.i4.8'],['localloc'],['stloc.1'],['ldloc.1'],['ldloc.0'],['ldc.i4.8'],['cpblk'],['ldloc.1'],['ldind.i4'],['ret']];
 const runtime=compileAssembly(model([method('Main',code,{locals:['System.Int32*','System.Int32*']})]),{strict:true});
 assert.equal(runtime.invoke('Main'),42);assert.equal(runtime.memoryBytes,0);
 const invalid=method('Main',[['ldc.i4.2'],['localloc'],['ldind.i4'],['ret']]);
 assert.throws(()=>compileAssembly(model([invalid])).invoke('Main'),e=>e.$type==='System.AccessViolationException');
});
test('escaped local pointer expires after return and allocation budget enforces limits',()=>{
 const escaped=method('Escape',[['ldc.i4.4'],['localloc'],['ret']],{returnType:'System.Int32*'});
 const runtime=compileAssembly(model([escaped]));const pointer=runtime.invoke('Escape',[],{raw:true});
 assert.throws(()=>runtime.indirectLoad(pointer,'ldind.i4'),e=>e.$type==='System.AccessViolationException');
 assert.throws(()=>compileAssembly(model([escaped]),{maxMemoryBytes:2}).invoke('Escape'),e=>e.$type==='System.OutOfMemoryException');
});
test('typed references retain exact type and writable managed address',()=>{
 const main=method('Main',[['ldc.i4.7'],['stloc.0'],['ldloca.s',0],['mkrefany',{name:'System.Int32'}],['stloc.1'],['ldloc.1'],['refanyval',{name:'System.Int32'}],['ldc.i4',42],['stind.i4'],['ldloc.0'],['ret']],{locals:['System.Int32','System.TypedReference']});
 assert.equal(compileAssembly(model([main]),{strict:true}).invoke('Main'),42);
 const bad=structuredClone(main);bad.body[6].operand.name='System.Int64';
 assert.throws(()=>compileAssembly(model([bad])).invoke('Main'),e=>e.$type==='System.InvalidCastException');
});
test('real Roslyn reflection and framework bridge execute emitted IL',()=>{
 const runtime=compileAssembly(fixture,{externals,strict:true});
 assert.equal(runtime.invoke('GenericAlgorithms::Reflect'),'42');
 assert.equal(runtime.invoke('GenericAlgorithms::GenericReflection'),42);
 assert.equal(runtime.invoke({declaringType:'GenericAlgorithms',name:'Literal',genericArguments:['System.Int32'],parameters:[]}), 'literal !0 !!0');
 assert.equal(runtime.invoke('GenericAlgorithms::Collections'),67);
 assert.equal(runtime.invoke('GenericAlgorithms::Ticks'),864000000000n);
});
test('portable static JS module preserves generic specialization without dynamic compiler',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'roslyn-il-v2-'));try{
 const path=join(dir,'fixture.mjs');await writeFile(path,generateModule(fixture,{externals,strict:true,runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href}));
 const {createAssembly}=await import(pathToFileURL(path));const runtime=createAssembly({externals});
 assert.equal(runtime.invoke('GenericAlgorithms::Main'),42);assert.equal(runtime.invoke('GenericAlgorithms::Arrays'),46);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('actual Roslyn unsafe IL uses local memory, managed function pointers and typed references',async()=>{
 const unsafe=JSON.parse(await readFile(new URL('./il-unsafe-fixture.json',import.meta.url),'utf8'));
 const runtime=compileAssembly(unsafe,{strict:true});
 assert.equal(runtime.invoke('Memory'),42);assert.equal(runtime.invoke('Indirect'),42);assert.equal(runtime.invoke('Typed'),42);assert.equal(runtime.invoke('TypedName'),'System.Int32');
 assert.equal(runtime.memoryBytes,0);
});

test('preflight includes unsupported operations inside linked dependencies',()=>{
 const callee=method('Unsupported',[['arglist'],['ret']],{declaringType:'Dependency'});
 const dependency={name:'DependencyAssembly',types:[{name:'Dependency',fields:[],methods:[callee]}]};
 const main=method('Main',[['call',{...callee,body:undefined,assemblyName:'DependencyAssembly'}],['ret']]);
 const report=analyzeAssembly(model([main]),{assemblies:[dependency]});
 assert.equal(report.supported,false);assert.ok(report.diagnostics.some(d=>d.code==='IL_UNSUPPORTED_OPCODE'&&d.method.startsWith('Dependency::')));
});

test('generic and nongeneric overloads with identical parameter lists remain distinct',()=>{
 const plain=method('Choose',[['ldc.i4.1'],['ret']]);
 const generic=method('Choose',[['ldc.i4.2'],['ret']],{token:0x06000002,genericParameters:['T']});
 const rt=compileAssembly(model([plain,generic]),{strict:true});
 assert.equal(rt.invoke({name:'Choose',declaringType:'Test',parameters:[]}),1);
 assert.equal(rt.invoke({name:'Choose',declaringType:'Test',parameters:[],genericArguments:['System.Int32']}),2);
 assert.throws(()=>rt.invoke('Choose'),/ambiguous/);
});
