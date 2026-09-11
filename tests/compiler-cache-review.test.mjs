import test from 'node:test';
import assert from 'node:assert/strict';
import {JavaScriptCompilerHost} from '../src/javascript-host.mjs';
const model=()=>({name:'Isolation',entryPoint:0x06000001,types:[{name:'Program',methods:[{name:'Main',token:0x06000001,isStatic:true,parameters:[],returnType:'System.Int32',body:[{offset:0,opcode:'ldc.i4.s',operand:42},{offset:1,opcode:'ret'}]}]}]});
const unexpected=()=>{throw new Error('Unexpected managed call');};
test('mutating execution analysis cannot poison cached emission or portable source',async()=>{
  const host=new JavaScriptCompilerHost(unexpected),input={model:model()};
  const result=await host.run(input);
  result.analysis.supported=false;
  result.analysis.diagnostics.push({severity:'error',message:'caller mutation'});
  const artifact=await host.emit(input,{optimize:undefined});
  assert.equal(artifact.cache.emitHit,true);
  assert.equal(artifact.analysis.supported,true);
  assert.deepEqual(artifact.analysis.diagnostics,[]);
  const fresh=new JavaScriptCompilerHost(unexpected);
  assert.equal((await fresh.run(artifact)).exitCode,42);
});
test('a portable artifact imported into a fresh host records source identity and bounded source storage',async()=>{
  const artifact=await new JavaScriptCompilerHost(unexpected).emit({model:model()});
  const host=new JavaScriptCompilerHost(unexpected);
  const first=await host.run(structuredClone(artifact));
  assert.equal(first.cache.moduleHit,false);
  assert.equal(host.sources.size,1);
  const retained=host.modules.get(host.sources.get(artifact.source));
  assert.equal(retained.source,artifact.source);
  assert.ok(retained.size>=artifact.source.length*2);
  const second=await host.run(structuredClone(artifact));
  assert.equal(second.cache.moduleHit,true);assert.equal(second.exitCode,42);
  assert.equal(host.sources.size,1);assert.equal(host.modules.size,1);
});

test('default emission and PE execution share normalized optimization and strictness cache keys',async()=>{
  let inspections=0;
  const host=new JavaScriptCompilerHost(async(method)=>{assert.equal(method,'InspectAssembly');inspections++;return model();});
  const artifact=await host.emit({peBase64:'fixture-pe'});
  assert.equal(artifact.cache.emitHit,false);
  const execution=await host.run({peBase64:'fixture-pe'});
  assert.equal(execution.cache.moduleHit,true);assert.equal(execution.exitCode,42);
  assert.equal(inspections,1);assert.equal(host.modules.size,1);
  assert.equal((await host.emit({peBase64:'fixture-pe'},{optimize:true,strict:true})).cache.emitHit,true);
});

test('a sparse input cannot reuse the key of a previously validated dense model',async()=>{
  const host=new JavaScriptCompilerHost(unexpected),input=model();
  input.types[0].methods[0].locals=[];
  const artifact=await host.emit({model:input});assert.equal(artifact.success,true);
  input.types[0].methods[0].locals.length=1;
  await assert.rejects(host.emit({model:input}),error=>error instanceof TypeError&&/sparse/.test(error.message));
  await assert.rejects(host.emit({model:model()},{marker:Array(1)}),error=>error instanceof TypeError&&/sparse/.test(error.message));
});
