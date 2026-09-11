import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRoslyn} from '../src/browser.js';
import {executeJavaScript} from '../src/execution.js';

const model = (body = [{offset:0,opcode:'ldc.i4',operand:42},{offset:1,opcode:'ret'}]) => ({name:'FacadeFixture',entryPoint:1,types:[{name:'Program',fields:[],methods:[{token:1,name:'Main',declaringType:'Program',isStatic:true,returnType:'System.Int32',parameters:[],locals:[],exceptionHandlers:[],body}]}]});
const assembly = body => ({success:true,pe:new Uint8Array([77,90]),inspection:model(body)});
class ProtocolWorker {
  static calls=[]; static requests=[];
  postMessage(request) {
    ProtocolWorker.calls.push(request.method); ProtocolWorker.requests.push(request);
    queueMicrotask(() => { if (!this.closed) this.onmessage?.({data:{id:request.id,result:request.method==='$init'?{referenceCount:167}:{success:true,exitCode:0,stdout:'',stderr:''}}}); });
  }
  terminate(){this.closed=true;}
}
async function withCompiler(options, action) {
  const previous=globalThis.Worker;globalThis.Worker=ProtocolWorker;ProtocolWorker.calls=[];ProtocolWorker.requests=[];
  let compiler;
  try {compiler=await createRoslyn(options);await action(compiler);}
  finally {compiler?.dispose();if(previous===undefined)delete globalThis.Worker;else globalThis.Worker=previous;}
}

test('lifetime abort prevents JavaScript execution through caller-provided externals',async()=>{
  const controller=new AbortController();
  await withCompiler({signal:controller.signal},async compiler=>{
    controller.abort();assert.equal(compiler.disposed,true);
    await assert.rejects(compiler.run(assembly(),{backend:'javascript',externals:{}}),error=>error.code==='ABORTED');
    assert.deepEqual(ProtocolWorker.calls,['$init']);
  });
});
test('abort also blocks an execution already waiting in the serialization queue',async()=>{
  const controller=new AbortController();
  await withCompiler({signal:controller.signal},async compiler=>{
    const pending=compiler.run(assembly(),{backend:'javascript',externals:{}});
    controller.abort();await assert.rejects(pending,error=>error.code==='ABORTED');
  });
});
test('WebAssembly file options encode UTF-8 and binary input through the managed file ABI',async()=>{
  await withCompiler({},async compiler=>{
    await compiler.run(assembly(),{virtualFiles:{'input.txt':'π','binary.bin':new Uint8Array([0,255])},captureVirtualFiles:true,workingDirectory:'work'});
    assert.deepEqual(ProtocolWorker.calls,['$init','RunWithFiles']);
    const request=JSON.parse(ProtocolWorker.requests.at(-1).args[2]);
    assert.equal(request.files[0].base64,Buffer.from('π').toString('base64'));
    assert.equal(request.files[1].base64,'AP8=');assert.equal(request.workingDirectory,'work');
  });
});
test('automatic compatibility fallback forwards relative files before WASM execution',async()=>{
  const unsupported=assembly([{offset:0,opcode:'unsupported-operation'},{offset:1,opcode:'ret'}]);
  await withCompiler({},async compiler=>{
    const result=await compiler.run(unsupported,{backend:'auto',virtualFiles:{'input.txt':'seed'}});
    assert.equal(result.backend,'wasm');assert.equal(result.fallback.supported,false);
    assert.deepEqual(ProtocolWorker.calls,['$init','RunWithFiles']);
  });
});
test('absolute managed input paths are rejected before execution and persistent auto mode selects WASM',async()=>{
  await withCompiler({},async compiler=>{
    await assert.rejects(compiler.run(assembly(),{virtualFiles:{'/input.txt':'seed'}}),error=>error.code==='INVALID_WORKSPACE_PATH');
    await assert.rejects(compiler.run(assembly(),{backend:'javascript',workspaceId:'existing'}),error=>error.code==='WORKSPACE_REQUIRES_WASM');
    assert.deepEqual(ProtocolWorker.calls,['$init']);
    await compiler.run(assembly(),{backend:'auto',workspaceId:'existing'});
    assert.deepEqual(ProtocolWorker.calls,['$init','RunWithFiles']);
  });
});
test('snapshot preserves and copies seeded files even if compiled code never accesses System.IO',async()=>{
  const binary=new Uint8Array([0,128,255]);
  const result=await executeJavaScript(model(),{virtualFiles:{'/text.txt':'hello','/binary.bin':binary},captureVirtualFiles:true});
  assert.equal(result.success,true);assert.equal(result.result,42);
  assert.equal(new TextDecoder().decode(result.virtualFiles['/text.txt']),'hello');
  assert.deepEqual(result.virtualFiles['/binary.bin'],binary);
  result.virtualFiles['/binary.bin'][0]=42;assert.equal(binary[0],0);
});
test('virtual-file quotas apply to seeds even if compiled code never accesses System.IO',async()=>{
  await assert.rejects(executeJavaScript(model(),{virtualFiles:{'/input.txt':'too large'},captureVirtualFiles:true,maxVirtualFileBytes:2}),/quota/);
});

test('direct-host startup and lifetime abort reject pending calls and prevent subsequent execution',()=>{
  // Only the host module is mocked. This exercises the public facade and its real
  // asynchronous startup/lifetime handling, without claiming to execute .NET here.
  const hostSource=`export async function bootManaged(){await new Promise(r=>setTimeout(r,globalThis.bootDelay||0));return {info:{referenceCount:167},async call(){globalThis.directCalls++;await new Promise(r=>setTimeout(r,60));return {success:true,result:42};},dispose(){globalThis.directDisposals++;}};}`;
  const hostUrl='data:text/javascript,'+encodeURIComponent(hostSource);
  const loader='data:text/javascript,'+encodeURIComponent(`export async function resolve(specifier,context,next){if(specifier==='./host.js'&&context.parentURL?.endsWith('/src/browser.js'))return {url:${JSON.stringify(hostUrl)},shortCircuit:true};return next(specifier,context);}`);
  const source=`import assert from 'node:assert/strict';
import {createRoslyn} from ${JSON.stringify(new URL('../src/browser.js',import.meta.url).href)};
globalThis.directCalls=0;globalThis.directDisposals=0;globalThis.bootDelay=60;
const first=new AbortController();const starting=createRoslyn({worker:false,signal:first.signal});setTimeout(()=>first.abort(),5);
await assert.rejects(starting,e=>e.code==='ABORTED');await new Promise(r=>setTimeout(r,80));assert.equal(globalThis.directDisposals,1);
globalThis.bootDelay=0;const controller=new AbortController();const compiler=await createRoslyn({worker:false,signal:controller.signal});
const pending=compiler.invoke('assembly','Type','Method');setTimeout(()=>controller.abort(),5);await assert.rejects(pending,e=>e.code==='ABORTED');
assert.equal(compiler.disposed,true);assert.equal(globalThis.directCalls,1);
await assert.rejects(compiler.invoke('assembly','Type','Method'),e=>e.code==='ABORTED');
await assert.rejects(compiler.run(new Uint8Array([77,90]),{backend:'javascript',externals:{}}),e=>e.code==='ABORTED');
assert.equal(globalThis.directCalls,1);assert.equal(globalThis.directDisposals,2);`;
  const result=spawnSync(process.execPath,['--no-warnings','--experimental-loader',loader,'--input-type=module'],{input:source,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||result.error?.message||result.stdout);
});
