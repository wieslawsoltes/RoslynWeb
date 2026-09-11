import test from 'node:test';
import assert from 'node:assert/strict';
import { compileWasm } from '../src/wasm/compiler.mjs';
import { loadWasm, clearWasmModuleCache, wasmModuleCacheStats } from '../src/wasm/runtime.mjs';

const I='System.Int32', L='System.Int64', U='System.UInt64', S='System.String', V='System.Void';
const method=(name,parameters,returnType,body,token=0x06000001)=>({name,token,isStatic:true,parameters:parameters.map(type=>({type})),returnType,locals:[],body:body.map((instruction,offset)=>({offset,...instruction}))});
const model=(methods,entryPoint=null)=>({name:'RuntimeFixture',entryPoint,types:[{name:'Program',methods}]});
const identity=(type,name='Identity',token)=>method(name,[type],type,[{opcode:'ldarg.0'},{opcode:'ret'}],token);

test('portable numeric modules instantiate without imports and retain real native exports',async()=>{
  const artifact=compileWasm(model([method('Add',[I,I],I,[{opcode:'ldarg.0'},{opcode:'ldarg.1'},{opcode:'add'},{opcode:'ret'}])]));
  const executable=await loadWasm(artifact);
  assert.equal(WebAssembly.Module.imports(executable.module).length,0);
  assert.equal(executable.invoke('Program::Add',[20,22]),42);
  assert.equal(executable.exports[artifact.exports[0].exportName](12,13),25);
  assert.equal(JSON.stringify(executable.manifest).includes('"body"'),false);
  assert.equal(executable.instance instanceof WebAssembly.Instance,true);
  executable.dispose();assert.throws(()=>executable.invoke('Add',[1,2]),error=>error.code==='DISPOSED');
});

test('native exports preserve signed and unsigned 64-bit boundaries and reject lossy input',async()=>{
  const artifact=compileWasm(model([identity(L,'Signed'),identity(U,'Unsigned',0x06000002)]));
  const executable=await loadWasm(artifact.bytes);
  assert.equal(executable.invoke('Signed',[-(1n<<63n)]),-(1n<<63n));
  assert.equal(executable.invoke('Signed',[(1n<<63n)-1n]),(1n<<63n)-1n);
  assert.equal(executable.invoke('Unsigned',[(1n<<64n)-1n]),(1n<<64n)-1n);
  assert.throws(()=>executable.invoke('Signed',[Number.MAX_SAFE_INTEGER+1]),error=>error.code==='WASM_ARGUMENT_RANGE');
  assert.throws(()=>executable.invoke('Signed',[1n<<63n]),error=>error.code==='WASM_ARGUMENT_RANGE');
  assert.throws(()=>executable.invoke('Unsigned',[-1n]),error=>error.code==='WASM_ARGUMENT_RANGE');
  assert.throws(()=>executable.invoke('Signed',[]),error=>error.code==='WASM_ARGUMENT_COUNT');
});

test('native IL budgets reset for each invocation and report instruction limits',async()=>{
  const artifact=compileWasm(model([identity(I)]));
  const executable=await loadWasm(artifact.bytes,{maxInstructions:2});
  for(let i=0;i<20;i++)assert.equal(executable.invoke('Identity',[i]),i);
  const limited=await loadWasm(artifact.bytes,{maxInstructions:1});
  assert.throws(()=>limited.invoke('Identity',[42]),error=>error.code==='WASM_INSTRUCTION_LIMIT');
});

test('standalone loading uses bounded native module caching and independent instances',async()=>{
  clearWasmModuleCache();
  const artifact=compileWasm(model([identity(I)]));
  const first=await loadWasm(artifact.bytes), second=await loadWasm(artifact.bytes.slice());
  assert.equal(first.stats.cacheHit,false);assert.equal(second.stats.cacheHit,true);
  assert.equal(first.module,second.module);assert.notEqual(first.instance,second.instance);
  assert.equal(wasmModuleCacheStats().entries,1);
  const uncached=await loadWasm(artifact.bytes,{cache:false});assert.equal(uncached.stats.cacheHit,false);
  clearWasmModuleCache();assert.equal(wasmModuleCacheStats().entries,0);assert.equal(first.invoke('Identity',[9]),9);
});

test('pre-aborted module loading rejects and native instances honor lifetime cancellation',async()=>{
  const artifact=compileWasm(model([identity(I)])),abort=new AbortController();abort.abort();
  await assert.rejects(loadWasm(artifact.bytes,{signal:abort.signal}),error=>error.code==='ABORTED');
  const lifetime=new AbortController(),executable=await loadWasm(artifact.bytes,{signal:lifetime.signal});
  assert.equal(executable.invoke('Identity',[2]),2);lifetime.abort();assert.throws(()=>executable.invoke('Identity',[2]),error=>error.code==='ABORTED');
});

test('native BCL imports capture output while managed method bodies remain native Wasm',async()=>{
  const write={declaringType:'System.Console',name:'WriteLine',isStatic:true,parameters:[{type:S}],returnType:V};
  const main=method('Main',[],I,[{opcode:'ldstr',operand:'Direct WASM'},{opcode:'call',operand:write},{opcode:'ldc.i4.s',operand:42},{opcode:'ret'}]);
  const artifact=compileWasm(model([main],main.token)),executable=await loadWasm(artifact.bytes);
  assert.ok(WebAssembly.Module.imports(executable.module).length>0);
  assert.deepEqual(executable.run(),{success:true,backend:'native-wasm',result:42,exitCode:42,stdout:'Direct WASM\n',stderr:''});
  assert.equal(executable.run().stdout,'Direct WASM\n');assert.equal(executable.stdout,'Direct WASM\nDirect WASM\n');
});

test('unsupported and malformed portable Wasm modules fail closed',async()=>{
  await assert.rejects(loadWasm(new Uint8Array([0,97,115,109,1,0,0,0])),error=>error.code==='WASM_MANIFEST_MISSING');
  await assert.rejects(loadWasm(new Uint8Array([1,2,3])),error=>error.code==='WASM_VALIDATION_FAILED');
});

for(const [file,type,name,expected] of [
  ['il-fixture.json','Comprehensive','Array',15],
  ['il-fixture.json','Comprehensive','ByRef',21],
  ['il-fixture.json','Comprehensive','Virtual',14],
  ['il-v2-fixture.json','GenericAlgorithms','Main',42],
  ['il-fixture.json','Comprehensive','Delegate',42],
  ['il-fixture.json','Comprehensive','Struct',20],
  ['il-fixture.json','Comprehensive','NestedFinally',12],
])test(`existing Roslyn DLL ${type}.${name} executes through native method exports`,async()=>{
  const {readFile}=await import('node:fs/promises');
  const inspected=JSON.parse(await readFile(new URL(file,import.meta.url),'utf8'));
  const artifact=compileWasm(inspected,{exports:[{type,name}]}),executable=await loadWasm(artifact.bytes);
  assert.equal(executable.invoke(`${type}::${name}`),expected);
  for(const descriptor of artifact.manifest.methods)assert.equal(typeof executable.exports[descriptor.exportName],'function');
  executable.dispose();
});

test('native module cache evicts old entries while their existing instances remain executable',async()=>{
  clearWasmModuleCache();let retained;
  for(let index=0;index<20;index++){
    const artifact=compileWasm(model([method('Constant',[],I,[{opcode:'ldc.i4',operand:index},{opcode:'ret'}])]));
    const executable=await loadWasm(artifact.bytes);retained??=executable;
    assert.equal(executable.invoke('Constant'),index);
  }
  const stats=wasmModuleCacheStats();assert.equal(stats.entries,stats.maxEntries);assert.ok(stats.bytes<=stats.maxBytes);
  assert.equal(retained.invoke('Constant'),0);clearWasmModuleCache();
});

test('exported CLR ref parameters update a JavaScript reference box through native Wasm stores',async()=>{
  const {readFile}=await import('node:fs/promises');
  const inspected=JSON.parse(await readFile(new URL('./il-fixture.json',import.meta.url),'utf8'));
  const artifact=compileWasm(inspected,{exports:[{type:'Comprehensive',name:'Increment'}]}),executable=await loadWasm(artifact.bytes);
  const reference={value:41};
  assert.equal(executable.invoke('Comprehensive::Increment',[reference]),undefined);
  assert.equal(reference.value,42);
  assert.throws(()=>executable.invoke('Comprehensive::Increment',[41]),error=>error.code==='WASM_ARGUMENT_TYPE');
});

test('externref string identity validates its public CLR argument type',async()=>{
  const artifact=compileWasm(model([identity(S)])),executable=await loadWasm(artifact.bytes);
  assert.equal(executable.invoke('Identity',['native text']),'native text');
  assert.equal(executable.invoke('Identity',[null]),null);
  assert.throws(()=>executable.invoke('Identity',[42]),error=>error.code==='WASM_ARGUMENT_TYPE');
});

test('linked PE metadata tokens are scoped by assembly and empty Module rows do not collide',async()=>{
  const dependency={name:'Dependency',types:[{name:'<Module>',methods:[]},{name:'Library',methods:[method('Value',[],I,[{opcode:'ldc.i4.s',operand:42},{opcode:'ret'}])]}]};
  const call={declaringType:'Library',assemblyName:'Dependency',name:'Value',token:0x06000001,isStatic:true,parameters:[],returnType:I};
  const write={declaringType:'System.Console',name:'WriteLine',isStatic:true,parameters:[{type:I}],returnType:V};
  const main=method('Main',[],I,[{opcode:'call',operand:call},{opcode:'call',operand:write},{opcode:'ldc.i4.0'},{opcode:'ret'}]);
  const inspected=model([main],main.token);inspected.types.unshift({name:'<Module>',methods:[]});
  const executable=await loadWasm(compileWasm(inspected,{assemblies:[dependency]}));
  assert.equal(executable.run().stdout,'42\n');
  assert.equal(executable.invoke(0x06000001),0);
  assert.equal(executable.invoke(0x06000001,[],{assembly:'Dependency'}),42);
});

test('unsigned enum exports retain the range and sign of their CLR underlying type',async()=>{
  for(const [enumName,underlying,value]of [['Unsigned32','System.UInt32',4294967295],['Unsigned64','System.UInt64',(1n<<64n)-1n]]){
    const inspected=model([identity(enumName)]);
    inspected.types.push({name:enumName,isEnum:true,isValueType:true,baseType:'System.Enum',fields:[{name:'value__',type:underlying,isStatic:false}],methods:[]});
    const executable=await loadWasm(compileWasm(inspected));
    assert.equal(executable.invoke('Identity',[value]),value);
    assert.throws(()=>executable.invoke('Identity',[-1]),error=>error.code==='WASM_ARGUMENT_RANGE');
  }
});
