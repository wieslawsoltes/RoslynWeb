import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoslyn} from '../src/browser.js';
import {JavaScriptCompilerHost} from '../src/javascript-host.mjs';
import {NativeWasmHost} from '../src/wasm/host.mjs';
const unexpected=()=>{throw new Error('Unexpected managed inspection for explicit models');};
const model=(name='FacadeReview',value=42)=>({name,entryPoint:0x06000001,types:[{name:'Program',methods:[{name:'Main',token:0x06000001,isStatic:true,parameters:[],returnType:'System.Int32',body:[{offset:0,opcode:'ldc.i4.s',operand:value},{offset:1,opcode:'ret'}]}]}]});
class CompilerWorker {
  javascript=new JavaScriptCompilerHost(unexpected);
  wasm=new NativeWasmHost(unexpected);
  postMessage(request){const {id,method,args}=structuredClone(request);queueMicrotask(async()=>{
    try{const result=method==='$init'?{referenceCount:167}:method==='$javascript'?await this.javascript.call(...args):method==='$nativeWasm'?await this.wasm.call(...args):unexpected();this.onmessage?.({data:{id,result}});}
    catch(error){this.onmessage?.({data:{id,error:{name:error.name,message:error.message,code:error.code}}});}
  });}
  terminate(){this.javascript.dispose();this.wasm.dispose();}
}
async function withCompiler(action){const previous=globalThis.Worker;globalThis.Worker=CompilerWorker;let compiler;try{compiler=await createRoslyn();return await action(compiler);}finally{compiler?.dispose();if(previous===undefined)delete globalThis.Worker;else globalThis.Worker=previous;}}

test('public emitters accept the declared raw AssemblyModel input',async()=>withCompiler(async compiler=>{
  const javascript=await compiler.emitJavaScript(model());assert.equal(javascript.success,true);
  const wasm=await compiler.emitWasm(model());assert.equal(wasm.success,true);assert.equal(WebAssembly.validate(wasm.bytes),true);
}));
test('JavaScript artifact execution with caller externals retains linked implementation assemblies',async()=>{
  const dependency=model('Implementation',42);dependency.entryPoint=null;dependency.types[0].name='Library';dependency.types[0].methods[0].name='Value';
  const root=model();root.references=[{name:'Implementation'}];root.types[0].methods[0].body=[{offset:0,opcode:'call',operand:{declaringType:'Library',name:'Value',assemblyName:'Implementation',isStatic:true,parameters:[],returnType:'System.Int32'}},{offset:1,opcode:'ret'}];
  const artifact=await new JavaScriptCompilerHost(unexpected).emit({model:root},{assemblies:[dependency]});
  await withCompiler(async compiler=>{const result=await compiler.run(artifact,{externals:{}});assert.equal(result.success,true,result.error?.message);assert.equal(result.exitCode,42);});
});
test('JavaScript artifact source verification also applies with caller externals',async()=>{
  const artifact=await new JavaScriptCompilerHost(unexpected).emit({model:model()});
  await withCompiler(async compiler=>{await assert.rejects(compiler.run({...artifact,source:artifact.source+'\n// changed'},{externals:{}}),error=>error.code==='JAVASCRIPT_ARTIFACT_CHANGED');});
});

test('artifact external callbacks execute in the caller realm and disposal aborts the pending call',async()=>{
  const input=model(),reference={declaringType:'HostHooks',name:'Value',isStatic:true,parameters:[],returnType:'System.Int32'};
  input.types[0].methods[0].body=[{offset:0,opcode:'call',operand:reference},{offset:1,opcode:'ret'}];
  const artifact=await new JavaScriptCompilerHost(unexpected).emit({model:input},{strict:false});
  await withCompiler(async compiler=>{
    let calls=0;
    const result=await compiler.run(artifact,{externals:{'HostHooks::Value':()=>{calls++;return 17;}}});
    assert.equal(result.success,true,result.error?.message);assert.equal(result.exitCode,17);assert.equal(calls,1);
    await assert.rejects(compiler.run(artifact,{externals:{'HostHooks::Value':()=>{calls++;compiler.dispose();return 42;}}}),error=>error.code==='DISPOSED');
    assert.equal(calls,2);
    await assert.rejects(compiler.run(artifact,{externals:{}}),error=>error.code==='DISPOSED');
  });
});
