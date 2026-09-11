import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JavaScriptCompilerHost} from '../src/javascript-host.mjs';
const model=(value=42)=>({name:'JsHostFixture',version:'1.0.0.0',references:[],entryPoint:0x06000001,types:[{name:'Program',methods:[{token:0x06000001,name:'Main',declaringType:'Program',assemblyName:'JsHostFixture',isStatic:true,attributes:'Public, Static',parameters:[],returnType:'System.Int32',locals:[],exceptionHandlers:[],body:[{offset:0,size:2,opcode:'ldc.i4.s',operand:value},{offset:2,size:1,opcode:'ret'}]}]}]});
const unexpected=()=>{throw new Error('Unexpected managed call');};
test('JavaScript emission owns artifact metadata; model/options changes invalidate cache',async()=>{
 const host=new JavaScriptCompilerHost(unexpected),input=model();
 const first=await host.emit({model:input});assert.equal(first.cache.emitHit,false);
 first.model.types[0].methods[0].body[0].operand=99;first.optimization.mode='corrupted';
 const second=await host.emit({model:input});assert.equal(second.cache.emitHit,true);
 assert.equal((await host.run(second)).exitCode,42);assert.notEqual(second.optimization.mode,'corrupted');
 input.types[0].methods[0].body[0].operand=43;
 const changed=await host.emit({model:input});assert.equal(changed.cache.emitHit,false);assert.equal((await host.run(changed)).exitCode,43);
 assert.equal((await host.emit({model:input},{optimize:false})).cache.emitHit,false);
 host.dispose();assert.equal(host.modules.size,0);assert.equal(host.sources.size,0);assert.equal(host.bytes,0);
});
test('JavaScript emission snapshots caller-owned model and options before awaiting',async()=>{
 const host=new JavaScriptCompilerHost(unexpected),input=model(),options={optimize:false};
 const pending=host.emit({model:input},options);input.types[0].methods[0].body[0].operand=99;options.optimize=true;
 const artifact=await pending;assert.equal((await host.run(artifact)).exitCode,42);assert.equal(artifact.javascriptOptions.optimize,false);
});
test('portable JavaScript artifacts run in a fresh host and reject changed source',async()=>{
 const firstHost=new JavaScriptCompilerHost(unexpected);const artifact=structuredClone(await firstHost.emit({model:model()}));firstHost.dispose();
 const secondHost=new JavaScriptCompilerHost(unexpected);
 assert.equal((await secondHost.run(artifact)).exitCode,42);
 await assert.rejects(secondHost.run({...artifact,source:artifact.source+' // edited'}),error=>error.code==='JAVASCRIPT_ARTIFACT_CHANGED');
});
test('PE inspection and compiled functions are reused independently of run budgets',async()=>{
 let calls=0;const host=new JavaScriptCompilerHost(async(method)=>{assert.equal(method,'InspectAssembly');calls++;return model();});
 const first=await host.run({peBase64:'TVo='});assert.equal(first.success,true);assert.equal(first.cache.moduleHit,false);
 const small=await host.run({peBase64:'TVo='},{maxInstructions:1});assert.equal(small.success,false);assert.equal(small.cache.moduleHit,true);
 const next=await host.run({peBase64:'TVo='});assert.equal(next.exitCode,42);assert.equal(next.cache.moduleHit,true);assert.equal(calls,1);
});
test('bounded JavaScript cache evicts old modules and their emitted source identities',async()=>{
 const host=new JavaScriptCompilerHost(unexpected),first=await host.emit({model:model(0)});
 for(let i=1;i<=16;i++)await host.emit({model:model(i)});
 assert.equal(host.modules.size,16);assert.equal(host.sources.has(first.source),false);
 assert.equal((await host.emit({model:model(0)})).cache.emitHit,false);
});
test('compileToJavaScript failure envelopes preserve C# and IL diagnostics',async()=>{
 const invalid=new JavaScriptCompilerHost(async()=>({success:false,diagnostics:[{id:'CS1002',message:'Expected semicolon'}]}));
 assert.equal((await invalid.compile({source:'bad'})).stage,'csharp');
 const broken=model();broken.types[0].methods[0].body[0].opcode='unsupported.operation';
 const unsupported=new JavaScriptCompilerHost(async()=>({success:true,peBase64:'TVo=',inspection:broken}));
 const failure=structuredClone(await unsupported.compile({source:'valid'}));
 assert.equal(failure.success,false);assert.equal(failure.stage,'javascript');assert.ok(failure.diagnostics.length);assert.ok(failure.assembly.pe instanceof Uint8Array);
});
