import test from 'node:test';
import assert from 'node:assert/strict';
import {AssemblyCompilerHost} from '../src/compiler-cache.mjs';
import {JavaScriptCompilerHost} from '../src/javascript-host.mjs';
import {NativeWasmHost} from '../src/wasm/host.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const fixture = (value=42,name='ConcurrentFixture') => ({name,version:'1.0.0.0',culture:'',publicKeyToken:'',references:[],entryPoint:0x06000001,types:[{name:'Program',methods:[{name:'Main',declaringType:'Program',token:0x06000001,isStatic:true,parameters:[],returnType:'System.Int32',locals:[],body:[{offset:0,opcode:'ldc.i4',operand:value},{offset:5,opcode:'ret'}]}]}]});
const image = (name,base64=name) => ({name,base64,version:'1.0.0.0',culture:'',publicKeyToken:''});
const dependency = name => ({...image(name),references:[],types:[]});
const failManaged = () => {throw new Error('Unexpected managed call');};

for (const Host of [JavaScriptCompilerHost,NativeWasmHost]) {
  const label=Host===JavaScriptCompilerHost?'JavaScript':'native Wasm';
  test(`${label}: concurrent same-PE inspection shares one bridge call and owns every returned model`,async()=>{
    const bridge=deferred();let calls=0;
    const host=new Host(()=>{calls++;return bridge.promise;});
    const pending=Array.from({length:12},()=>host.inspect({peBase64:'same'}));
    await Promise.resolve();assert.equal(calls,1);assert.equal(host.pendingInspections.size,1);
    const original=fixture();bridge.resolve(original);
    const models=await Promise.all(pending);assert.equal(host.pendingInspections.size,0);
    models[0].types[0].methods[0].body[0].operand=99;original.name='caller mutation';
    assert.ok(models.slice(1).every(model=>model.types[0].methods[0].body[0].operand===42));
    assert.equal((await host.inspect({peBase64:'same'})).name,'ConcurrentFixture');
    assert.equal(calls,1);host.dispose();
  });
  test(`${label}: failed shared inspection is removed so a later attempt can retry`,async()=>{
    const bridge=deferred();let calls=0;
    const host=new Host(()=>{calls++;return calls===1?bridge.promise:fixture();});
    const first=host.inspect({peBase64:'retry'}),second=host.inspect({peBase64:'retry'});
    const outcome=Promise.allSettled([first,second]);bridge.resolve({success:false,error:{message:'bad image'}});
    for(const result of await outcome){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'WASM_INSPECTION');}
    assert.equal(host.pendingInspections.size,0);assert.equal(host.inspections.items.size,0);
    assert.equal((await host.inspect({peBase64:'retry'})).name,'ConcurrentFixture');assert.equal(calls,2);host.dispose();
  });
  test(`${label}: disposing a host rejects in-flight inspection promptly and prevents late cache writes`,async()=>{
    const bridge=deferred();const host=new Host(()=>bridge.promise);
    const first=host.emit({peBase64:'pending'}),second=host.inspect({peBase64:'pending'});
    const outcome=Promise.allSettled([first,second]);await Promise.resolve();host.dispose();
    for(const result of await outcome){assert.equal(result.status,'rejected');assert.equal(result.reason.code,'DISPOSED');}
    assert.equal(host.pendingInspections.size,0);bridge.resolve(fixture());await Promise.resolve();await Promise.resolve();
    assert.equal(host.inspections.items.size,0);assert.equal(host.preparations.items.size,0);
    assert.equal(Host===JavaScriptCompilerHost?host.modules.size:host.emissions.items.size,0);
    await assert.rejects(host.emit({model:fixture()}),error=>error.code==='DISPOSED');
  });
  test(`${label}: remembered inspection wins over an earlier unresolved bridge response`,async()=>{
    const bridge=deferred();const host=new Host(()=>bridge.promise);
    const pending=host.inspect({peBase64:'replacement'});await Promise.resolve();
    const newer=fixture(73);host.rememberInspection('replacement',newer);newer.types[0].methods[0].body[0].operand=99;
    assert.equal((await pending).types[0].methods[0].body[0].operand,73);
    bridge.resolve(fixture(42));await Promise.resolve();await Promise.resolve();
    assert.equal((await host.inspect({peBase64:'replacement'})).types[0].methods[0].body[0].operand,73);host.dispose();
  });
  test(`${label}: repeated PE emission skips inspection and linking after the first compilation`,async()=>{
    let managed=0,inspections=0,links=0;const host=new Host(()=>{managed++;return fixture();});
    const inspect=host.inspect.bind(host),link=host.link.bind(host);
    host.inspect=(...args)=>{inspections++;return inspect(...args);};host.link=(...args)=>{links++;return link(...args);};
    assert.equal((await host.emit({peBase64:'hot'})).cache.emitHit,false);
    for(let i=0;i<5;i++)assert.equal((await host.emit({peBase64:'hot'})).cache.emitHit,true);
    assert.deepEqual({managed,inspections,links},{managed:1,inspections:1,links:1});
    host.clearCompilations();assert.equal((await host.emit({peBase64:'hot'})).cache.emitHit,false);
    assert.deepEqual({managed,inspections,links},{managed:1,inspections:2,links:2});host.dispose();
  });
  test(`${label}: preparation memo validates relevant DLL changes and ignores unrelated registrations`,async()=>{
    const root={...fixture(),references:[{name:'Library',version:'1.0.0.0',culture:'',publicKeyToken:''}]};
    const images=new Map([['Library',image('Library','first')]]),requests=[];
    const host=new Host((_method,[pe])=>{requests.push(pe);return pe==='main'?root:dependency('Library');},images);
    assert.equal((await host.emit({peBase64:'main'})).cache.emitHit,false);
    images.set('Unrelated',image('Unrelated'));
    assert.equal((await host.emit({peBase64:'main'})).cache.emitHit,true);
    images.get('Library').base64='second';
    assert.equal((await host.emit({peBase64:'main'})).cache.emitHit,false);
    assert.deepEqual(requests,['main','first','second']);
    images.set('duplicate',image('Library','duplicate'));
    await assert.rejects(host.emit({peBase64:'main'}),error=>error.code==='WASM_ASSEMBLY_IDENTITY');host.dispose();
  });
  test(`${label}: a newly registered formerly unresolved reference invalidates preparation`,async()=>{
    const images=new Map(),root={...fixture(),references:[{name:'Later',version:'1.0.0.0'}]};
    const requests=[],host=new Host((_method,[pe])=>{requests.push(pe);return pe==='main'?root:dependency('Later');},images);
    assert.equal((await host.emit({peBase64:'main'})).cache.emitHit,false);
    images.set('Later',image('Later'));
    assert.equal((await host.emit({peBase64:'main'})).cache.emitHit,false);
    assert.deepEqual(requests,['main','Later']);host.dispose();
  });
  test(`${label}: remembered inspection invalidates its derived module and preserves unrelated modules`,async()=>{
    const host=new Host((_method,[pe])=>fixture(pe==='first'?42:17,pe));
    await host.emit({peBase64:'first'});await host.emit({peBase64:'second'});
    host.rememberInspection('first',fixture(73,'first'));
    assert.equal((await host.emit({peBase64:'second'})).cache.emitHit,true);
    assert.equal((await host.emit({peBase64:'first'})).cache.emitHit,false);
    assert.equal((await host.run({peBase64:'first'})).exitCode,73);
    host.rememberInspection('first',fixture(73,'first'));
    assert.equal((await host.emit({peBase64:'first'})).cache.emitHit,true);host.dispose();
  });
  test(`${label}: replacement still invalidates compiled code after inspection eviction`,async()=>{
    const host=new Host(()=>fixture());await host.emit({peBase64:'old'});
    host.inspections.clear();host.preparations.clear();
    host.rememberInspection('old',fixture(51));
    assert.equal((await host.emit({peBase64:'old'})).cache.emitHit,false);
    assert.equal((await host.run({peBase64:'old'})).exitCode,51);host.dispose();
  });
  test(`${label}: C# compilation snapshots emission settings and inline inspection preference before awaiting`,async()=>{
    const bridge=deferred(),request={source:'return 42;',includeInspection:false},options={optimize:false};
    const host=new Host((method,args)=>{assert.equal(method,'Compile');assert.equal(JSON.parse(args[0]).includeInspection,false);return bridge.promise;});
    const pending=host.compile(request,options);options.optimize=true;request.includeInspection=true;
    bridge.resolve({success:true,peBase64:'compiled',inspection:fixture()});const artifact=await pending;
    assert.equal(artifact.success,true);assert.equal(artifact.optimization.enabled,false);assert.equal(artifact.assembly.inspection,undefined);host.dispose();
  });
  test(`${label}: preparation metadata retains the same bounded LRU policy as emitted code`,async()=>{
    const host=new Host((_method,[pe])=>fixture(42,pe));
    for(let i=0;i<18;i++)await host.emit({peBase64:'assembly-'+i});
    assert.equal(host.preparations.items.size,16);assert.ok(host.preparations.bytes<=64*1024*1024);
    for(const [key,item]of host.preparations.items)assert.ok(item.size>=key.length*2+item.value.key.length*2);
    host.dispose();assert.equal(host.preparations.bytes,0);
  });
}

test('dependency registry is captured before a main PE inspection yields',async()=>{
  const bridge=deferred(),images=new Map([['Library',image('Library','original')]]),calls=[];
  const host=new AssemblyCompilerHost((_method,[pe])=>{calls.push(pe);return pe==='main'?bridge.promise:dependency('Library');},images);
  const pending=host.prepare({peBase64:'main'});
  images.get('Library').base64='replacement';bridge.resolve({...fixture(),references:['Library']});
  await pending;assert.deepEqual(calls,['main','original']);
  await host.prepare({peBase64:'main'});assert.deepEqual(calls,['main','original','replacement']);host.dispose();
});

test('replacement during an active preparation cannot reinsert stale derived code',async()=>{
  const host=new JavaScriptCompilerHost(failManaged);host.rememberInspection('main',fixture());
  const originalLink=host.link.bind(host),wait=deferred();
  host.link=async(...args)=>{await wait.promise;return originalLink(...args);};
  const pending=host.emit({peBase64:'main'});await Promise.resolve();await Promise.resolve();
  host.rememberInspection('main',fixture(81));wait.resolve();
  await assert.rejects(pending,error=>error.code==='COMPILATION_INVALIDATED');
  host.link=originalLink;assert.equal((await host.run({peBase64:'main'})).exitCode,81);host.dispose();
});


test('replacing an unrelated inspection does not invalidate a concurrent preparation',async()=>{
  const bridge=deferred(),host=new AssemblyCompilerHost(()=>bridge.promise);
  host.rememberInspection('unrelated',{name:'Other',version:'1.0.0.0',types:[]});
  const pending=host.prepare({peBase64:'main'});await Promise.resolve();
  host.rememberInspection('unrelated',{name:'Other',version:'2.0.0.0',types:[]});
  bridge.resolve(fixture());assert.equal((await pending).model.name,'ConcurrentFixture');host.dispose();
});

for (const Host of [JavaScriptCompilerHost,NativeWasmHost]) test(`${Host.name}: replacement between preparation and emission cannot cache stale code`,async()=>{
  const host=new Host(failManaged);host.rememberInspection('main',fixture());
  const original=host.prepare.bind(host);let changed=false;
  host.prepare=async(...args)=>{const result=await original(...args);if(!changed){changed=true;host.rememberInspection('main',fixture(93));}return result;};
  await assert.rejects(host.emit({peBase64:'main'}),error=>error.code==='COMPILATION_INVALIDATED');
  assert.equal(host.activePreparations.size,0);
  assert.equal((await host.run({peBase64:'main'})).exitCode,93);host.dispose();
});

for (const Host of [JavaScriptCompilerHost,NativeWasmHost]) test(`${Host.name}: replacing a PE across the hot preparation await boundary rejects stale artifacts`,async()=>{
  const host=new Host(()=>fixture());await host.emit({peBase64:'same'});
  const pending=host.emit({peBase64:'same'});host.rememberInspection('same',fixture(73));
  await assert.rejects(pending,error=>error.code==='COMPILATION_INVALIDATED');
  assert.equal(host.activePreparations.size,0);assert.equal((await host.run({peBase64:'same'})).exitCode,73);host.dispose();
});
