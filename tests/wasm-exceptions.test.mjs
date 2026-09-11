import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Writer,op} from '../src/wasm/binary.mjs';
import {buildExceptionPlan,createExceptionFrame,dispatchException,leaveProtectedRegion,finishFinally,caughtException,rethrowException,requireExceptionTag} from '../src/wasm/exceptions.mjs';
const instructions=count=>Array.from({length:count},(_,offset)=>({offset,size:1,opcode:'nop'}));
const region=(kind,start,length,handler,handlerLength,catchType)=>({kind,tryOffset:start,tryLength:length,handlerOffset:handler,handlerLength,catchType});
const error=(type,message=type)=>Object.assign(new Error(message),{$type:type});
const plan=buildExceptionPlan({body:instructions(31),exceptionHandlers:[region('catch',0,10,10,10,'System.DivideByZeroException'),region('finally',0,20,20,10)]});

test('EH plans validate actual boundaries, handler stacks, malformed overlaps and unsupported filters',()=>{
 assert.deepEqual(plan.handlerEntries,[{offset:10,stack:['externref']},{offset:20,stack:[]}]);
 for(const exceptionHandlers of [[region('filter',0,5,5,5)],[region('catch',0,0,5,5)],[region('catch',0,15,10,5)],[region('catch',0,15,20,5),region('catch',5,15,25,5)]])assert.throws(()=>buildExceptionPlan({body:instructions(31),exceptionHandlers}),e=>e.code==='WASM_EXCEPTION_REGIONS');
});

test('catch selection preserves exception identity and finally executes once before leave',()=>{
 const frame=createExceptionFrame(plan),e=error('System.DivideByZeroException');
 assert.equal(dispatchException(frame,2,e),10);assert.equal(caughtException(frame),e);
 assert.equal(leaveProtectedRegion(frame,15,30),20);assert.equal(finishFinally(frame),30);assert.equal(frame.transfer,null);
});

test('unhandled exception runs finally then escapes its native catch wrapper without being caught again',()=>{
 const frame=createExceptionFrame(plan),e=error('System.InvalidOperationException');
 assert.equal(dispatchException(frame,2,e),20);
 let pending;try{finishFinally(frame);}catch(value){pending=value;}
 assert.ok(pending);assert.throws(()=>dispatchException(frame,25,pending),value=>value===e);
});

test('nested catch inside a finally preserves the pending outer leave continuation',()=>{
 const nested=buildExceptionPlan({body:instructions(61),exceptionHandlers:[region('finally',0,10,10,40),region('catch',15,5,20,10,'System.Exception')]});
 const frame=createExceptionFrame(nested),e=error('System.InvalidOperationException');
 assert.equal(leaveProtectedRegion(frame,2,60),10);assert.equal(dispatchException(frame,17,e),20);
 assert.equal(leaveProtectedRegion(frame,25,35),35);assert.equal(finishFinally(frame),60);
});

test('an exception in finally replaces the previous exception and goes to an enclosing catch',()=>{
 const nested=buildExceptionPlan({body:instructions(61),exceptionHandlers:[region('finally',0,10,10,10),region('catch',0,30,30,20,'System.ArgumentException')]});
 const frame=createExceptionFrame(nested),original=error('System.InvalidOperationException'),replacement=error('System.ArgumentException');
 assert.equal(dispatchException(frame,2,original),10);assert.equal(dispatchException(frame,15,replacement),30);assert.equal(caughtException(frame),replacement);assert.equal(frame.transfer,null);
});

test('fault runs only on exceptional unwind; rethrow uses the original catch exception',()=>{
 const fault=buildExceptionPlan({body:instructions(21),exceptionHandlers:[region('fault',0,10,10,10)]});
 assert.equal(leaveProtectedRegion(createExceptionFrame(fault),1,20),20);
 const frame=createExceptionFrame(fault),e=error('System.Exception');assert.equal(dispatchException(frame,1,e),10);
 const catcher=createExceptionFrame(plan),div=error('System.DivideByZeroException');dispatchException(catcher,2,div);assert.throws(()=>rethrowException(catcher,15),value=>value===div);assert.throws(()=>rethrowException(catcher,30),e=>e.code==='WASM_EXCEPTION_REGIONS');
});

test('host limits and cancellation bypass managed catch clauses',()=>{
 const all=buildExceptionPlan({body:instructions(21),exceptionHandlers:[region('catch',0,10,10,10,'System.Exception')]});
 for(const code of ['WASM_INSTRUCTION_LIMIT','WASM_RUNTIME_TRAP','DISPOSED','ABORTED','TIMEOUT']){const host=Object.assign(new Error(code),{code});assert.throws(()=>dispatchException(createExceptionFrame(all),2,host),error=>error===host);}
});

function nativeExceptionModule(){
 const module=new Writer().raw([0,97,115,109,1,0,0,0]);
 const types=[[['i32'],['i32']],[[],['externref']],[['i32'],[]],[['externref','i32','externref'],['i32']],[['externref','i32','i32'],['i32']],[['externref'],['i32']],[['externref'],[]]];
 const value={i32:0x7f,externref:0x6f};module.section(1,new Writer().vector(types,(w,[p,r])=>w.byte(0x60).vector(p,(w,t)=>w.byte(value[t])).vector(r,(w,t)=>w.byte(value[t]))));
 const descriptors=[['frame',1],['raise',2],['dispatch',3],['leave',4],['finish',5]];
 const imports=new Writer().u32(descriptors.length+1);for(const [name,type]of descriptors)imports.string('eh').string(name).byte(0).u32(type);imports.string('eh').string('tag').byte(4).byte(0).u32(6);module.section(2,imports);
 module.section(3,new Writer().u32(1).u32(0));module.section(6,new Writer().u32(1).raw([0x7f,1,0x41,0,0x0b]));module.section(7,new Writer().u32(2).string('run').byte(0).u32(5).string('finallyCount').byte(3).u32(0));
 // locals: argument0; frame1, exception2, pc3, result4, origin5.
 const body=new Writer().u32(2).u32(2).byte(0x6f).u32(3).byte(0x7f);const get=i=>body.byte(op.local_get).u32(i),set=i=>body.byte(op.local_set).u32(i),constant=n=>body.byte(op.i32_const).signed(n),call=i=>body.byte(op.call).u32(i);
 call(0);set(1);constant(0);set(3);body.raw([op.loop,0x40,0x06,0x40]);
 const block=(offset,action)=>{get(3);constant(offset);body.raw([op.i32_eq,op.if,0x40]);constant(offset);set(5);action();body.byte(op.br).u32(2).byte(op.end);};
 const leave=(origin,target)=>{get(1);constant(origin);constant(target);call(3);set(3);};
 block(0,()=>{get(0);call(1);constant(7);set(4);leave(0,30);});
 block(10,()=>{constant(42);set(4);leave(10,30);});
 block(20,()=>{body.byte(op.global_get).u32(0);constant(1);body.byte(op.i32_add).byte(op.global_set).u32(0);get(4);constant(1);body.byte(op.i32_add);set(4);get(1);call(4);set(3);});
 block(30,()=>{get(4);body.byte(op.return);});
 body.byte(op.unreachable).byte(0x07).u32(0);set(2);get(1);get(5);get(2);call(2);set(3);body.byte(op.end).byte(op.br).u32(0).byte(op.end).byte(op.unreachable).byte(op.end);
 module.section(10,new Writer().u32(1).u32(body.bytes.length).raw(body.bytes));return module.finish();
}

test('actual native WebAssembly try/catch dispatches managed errors and executes finally on all paths',async()=>{
 const bytes=nativeExceptionModule();assert.equal(WebAssembly.validate(bytes),true);
 const uncaught=error('System.ArgumentException');
 const {instance}=await WebAssembly.instantiate(bytes,{eh:{tag:requireExceptionTag(),frame:()=>createExceptionFrame(plan),raise(mode){if(mode===1)throw error('System.DivideByZeroException');if(mode===2)throw uncaught;},dispatch:dispatchException,leave:leaveProtectedRegion,finish:finishFinally}});
 assert.equal(instance.exports.run(0),8);assert.equal(instance.exports.finallyCount.value,1);
 assert.equal(instance.exports.run(1),43);assert.equal(instance.exports.finallyCount.value,2);
 assert.throws(()=>instance.exports.run(2),value=>value===uncaught);assert.equal(instance.exports.finallyCount.value,3);
});

test('genuine Roslyn IL compiles to native catch/finally with preserved static and unwind state',async()=>{
 const {readFile}=await import('node:fs/promises');
 const {compileWasm}=await import('../src/wasm/compiler.mjs');
 const {loadWasm}=await import('../src/wasm/runtime.mjs');
 const model=JSON.parse(await readFile(new URL('il-fixture.json',import.meta.url),'utf8'));
 const compiled=compileWasm(model,{exports:['Exceptions','NestedFinally','CatchInsideFinally'].map(method=>({type:'Comprehensive',method}))});
 assert.equal(WebAssembly.validate(compiled.bytes),true);
 assert.ok(compiled.imports.some(descriptor=>descriptor.kind==='exception_tag'));
 assert.ok(compiled.manifest.model.types.every(type=>type.methods.every(method=>!('body' in method))));
 const program=await loadWasm(compiled.bytes);
 assert.equal(program.invoke('Comprehensive::Exceptions',[0]),44);
 assert.equal(program.invoke('Comprehensive::Exceptions',[2]),53);
 assert.equal(program.invoke('Comprehensive::NestedFinally',[]),12);
 assert.throws(()=>program.invoke('Comprehensive::CatchInsideFinally',[]),error=>error.$type==='System.InvalidOperationException');
 assert.equal(program.invoke('Comprehensive::Exceptions',[1]),106);
 program.dispose();
});

test('genuine C# exception filter is rejected explicitly before native code generation',async()=>{
 const {readFile}=await import('node:fs/promises');const {compileWasm}=await import('../src/wasm/compiler.mjs');
 const model=JSON.parse(await readFile(new URL('il-fixture.json',import.meta.url),'utf8'));
 assert.throws(()=>compileWasm(model,{exports:[{type:'Comprehensive',method:'Filter'}]}),error=>error.code==='WASM_UNSUPPORTED'&&error.diagnostics.some(d=>d.code==='WASM_EXCEPTION_REGIONS'||d.message.includes('filter')));
});
