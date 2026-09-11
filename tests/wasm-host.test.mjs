import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeWasmHost,rememberAssembly} from '../src/wasm/host.mjs';
import {loadWasm} from '../src/wasm/runtime.mjs';
const constantModel=(value=42,name='HostFixture')=>({name,version:'1.0.0.0',culture:'',publicKeyToken:'',references:[],entryPoint:0x06000001,types:[{name:'Program',methods:[{token:0x06000001,name:'Main',declaringType:'Program',assemblyName:name,isStatic:true,attributes:'Public, Static',parameters:[],returnType:'System.Int32',locals:[],exceptionHandlers:[],body:[{offset:0,size:2,opcode:'ldc.i4.s',operand:value},{offset:2,size:1,opcode:'ret'}]}]}]});
const valueOf=async artifact=>{const p=await loadWasm(artifact.bytes);try{return p.invoke('Program::Main',[]);}finally{p.dispose();}};
const noManaged=()=>{throw new Error('Unexpected managed bridge call');};

test('native emission cache owns returned artifacts and invalidates changed IL models',async()=>{
 const host=new NativeWasmHost(noManaged),model=constantModel();
 const first=await host.emit({model});assert.equal(first.cache.emitHit,false);assert.equal(await valueOf(first),42);
 first.bytes[0]=255;first.manifest.methods[0].name='corrupted';
 const second=await host.emit({model});assert.equal(second.cache.emitHit,true);assert.equal(second.bytes[0],0);assert.equal(second.manifest.methods[0].name,'Main');assert.equal(await valueOf(second),42);
 model.types[0].methods[0].body[0].operand=43;
 const changed=await host.emit({model});assert.equal(changed.cache.emitHit,false);assert.equal(await valueOf(changed),43);
 host.dispose();assert.equal(host.emissions.items.size,0);assert.equal(host.emissions.bytes,0);
});

test('native emission snapshots model and export options before asynchronous work',async()=>{
 const host=new NativeWasmHost(noManaged),model=constantModel(),options={exports:[{type:'Program',method:'Main'}]};
 const pending=host.emit({model},options);model.types[0].methods[0].body[0].operand=99;options.exports[0].method='Missing';
 const artifact=await pending;assert.equal(await valueOf(artifact),42);
});

test('binary option contents participate in cache identity and unsupported/cyclic options reject',async()=>{
 const host=new NativeWasmHost(noManaged),model=constantModel();
 const first=await host.emit({model},{marker:Uint8Array.of(1).buffer});assert.equal(first.cache.emitHit,false);
 assert.equal((await host.emit({model},{marker:Uint8Array.of(1).buffer})).cache.emitHit,true);
 assert.equal((await host.emit({model},{marker:Uint8Array.of(2).buffer})).cache.emitHit,false);
 assert.equal((await host.emit({model},{marker:Uint8Array.of(2)})).cache.emitHit,false);
 for(const options of [{marker:()=>{}},{marker:new Map()}])await assert.rejects(host.emit({model},options),TypeError);
 const cycle={};cycle.self=cycle;await assert.rejects(host.emit({model},cycle),/cycles/);
});

test('bounded emission cache counts metadata and complete shared typed-array backing storage',()=>{
 const host=new NativeWasmHost(noManaged),backing=new Uint8Array(2*1024*1024),metadata='x'.repeat(128*1024);
 host.emissions.set('large',{bytes:Uint8Array.of(0),manifest:{metadata,view:backing.subarray(0,1)}});
 assert.ok(host.emissions.bytes>=backing.byteLength+metadata.length*2);
 assert.equal(host.emissions.get('large').manifest.view.buffer.byteLength,backing.byteLength);
 for(let i=0;i<17;i++)host.emissions.set(String(i),{bytes:Uint8Array.of(i),manifest:{}});
 assert.equal(host.emissions.items.size,16);assert.equal(host.emissions.get('large'),undefined);
 assert.equal(host.emissions.get('0'),undefined);assert.equal(host.emissions.get('16').bytes[0],16);
});

test('inspection cache owns model snapshots and preserves structured inspection failures',async()=>{
 let calls=0;const host=new NativeWasmHost(async(_method,args)=>{calls++;return args[0]==='bad'?{success:false,error:{type:'BadImageFormatException',message:'bad PE'}}:constantModel();});
 const first=await host.inspect({peBase64:'valid'});first.name='changed';
 assert.equal((await host.inspect({peBase64:'valid'})).name,'HostFixture');assert.equal(calls,1);
 await assert.rejects(host.inspect({peBase64:'bad'}),e=>e.code==='WASM_INSPECTION'&&structuredClone(e.details).error.message==='bad PE');
});

const dependency=(name,version='1.0.0.0',culture='',publicKeyToken='')=>({name,version,culture,publicKeyToken,references:[],types:[]});
function registryHost(records){const images=new Map(),models=new Map();for(const [index,record]of records.entries()){const image='image'+index;rememberAssembly(images,{success:true,assemblyName:record.name,version:record.version,culture:record.culture,publicKeyToken:record.publicKeyToken,assemblyIdentity:`${record.name}, Version=${record.version}, Culture=${record.culture||'neutral'}, PublicKeyToken=${record.publicKeyToken||'null'}`},[record.name,image]);models.set(image,record);}return new NativeWasmHost(async(_method,[image])=>structuredClone(models.get(image)),images);}

test('registered DLL linkage selects exact version, culture and public key token transitively',async()=>{
 const first={...dependency('Library','1.0.0.0','','0011223344556677'),references:[{name:'Leaf',version:'2.0.0.0',culture:'',publicKeyToken:''}]};
 const host=registryHost([first,dependency('Library','2.0.0.0','','0011223344556677'),dependency('Leaf','2.0.0.0')]);
 const root={...constantModel(),references:[{name:'Library',version:'1.0.0.0',culture:'',publicKeyToken:'0011223344556677'}]};
 const linked=await host.link(root);assert.deepEqual(linked.map(m=>[m.name,m.version]),[['Library','1.0.0.0'],['Leaf','2.0.0.0']]);
});

test('registered DLL linkage rejects mismatched neutral culture, public key token and version',async()=>{
 const root={...constantModel(),references:[{name:'Library',version:'1.0.0.0',culture:'',publicKeyToken:'0011223344556677'}]};
 for(const record of [dependency('Library','2.0.0.0','','0011223344556677'),dependency('Library','1.0.0.0','pl','0011223344556677'),dependency('Library','1.0.0.0','','8899aabbccddeeff'),dependency('Library','1.0.0.0','','')])await assert.rejects(registryHost([record]).link(root),e=>e.code==='WASM_ASSEMBLY_IDENTITY');
 const unsigned={...root,references:[{name:'Library',version:'1.0.0.0',culture:'',publicKeyToken:''}]};await assert.rejects(registryHost([dependency('Library','1.0.0.0','','0011223344556677')]).link(unsigned),e=>e.code==='WASM_ASSEMBLY_IDENTITY');
});

test('linker detects incompatible transitive requests instead of silently keeping the first DLL',async()=>{
 const a={...dependency('A'),references:[{name:'Shared',version:'1.0.0.0'}]},b={...dependency('B'),references:[{name:'Shared',version:'2.0.0.0'}]};
 const host=registryHost([a,b,dependency('Shared'),dependency('Shared','2.0.0.0')]);
 await assert.rejects(host.link({...constantModel(),references:[{name:'A',version:'1.0.0.0'},{name:'B',version:'1.0.0.0'}]}),e=>e.code==='WASM_ASSEMBLY_IDENTITY');
});

test('explicit models override registered DLLs while declared identity mismatches reject',async()=>{
 const requested={name:'Library',version:'1.0.0.0'},root={...constantModel(),references:[requested]};
 const host=registryHost([dependency('Library','2.0.0.0')]),exact=dependency('Library');
 assert.equal((await host.link(root,[exact]))[0],exact);
 await assert.rejects(host.link(root,[dependency('Library','3.0.0.0')]),e=>e.code==='WASM_ASSEMBLY_IDENTITY');
 await assert.rejects(host.link(root,[constantModel()]),e=>e.code==='WASM_ASSEMBLY_IDENTITY');
 // Older explicitly supplied inspection models lack identity metadata: their named override is caller-selected.
 const legacy={name:'Library',types:[],references:[]};assert.equal((await host.link(root,[legacy]))[0],legacy);
});

test('C# failures and native diagnostics return structured-clone-safe stage envelopes',async()=>{
 const diagnostic={id:'CS1525',severity:'error',message:'Invalid expression',path:'Program.cs'};
 const invalid=new NativeWasmHost(async()=>({success:false,diagnostics:[diagnostic]}));
 const csharp=structuredClone(await invalid.compile({source:'invalid'}));assert.equal(csharp.stage,'csharp');assert.deepEqual(csharp.diagnostics,[diagnostic]);assert.equal(invalid.emissions.items.size,0);
 const model=constantModel();model.types[0].methods[0].body[0].opcode='unsupported.operation';
 const bad=new NativeWasmHost(async()=>({success:true,peBase64:'TVo=',assemblyId:'id',inspection:structuredClone(model)}));
 const native=structuredClone(await bad.compile({source:'valid'}));assert.equal(native.success,false);assert.equal(native.stage,'wasm');assert.equal(native.error.code,'WASM_UNSUPPORTED');assert.ok(native.diagnostics.length>0);assert.ok(native.assembly.pe instanceof Uint8Array);assert.equal(native.assembly.inspection,undefined);
});

test('host compile returns portable bytes and optional inspection, then runs emitted native module',async()=>{
 const host=new NativeWasmHost(async(method,args)=>{assert.equal(method,'Compile');assert.equal(JSON.parse(args[0]).includeInspection,true);return {success:true,peBase64:'TVo=',assemblyId:'id',inspection:constantModel()};});
 const artifact=await host.compile({source:'return42;',includeInspection:true});assert.equal(artifact.success,true);assert.equal(artifact.format,'wasm');assert.equal(artifact.assembly.inspection.name,'HostFixture');
 const result=await host.run(artifact);assert.equal(result.success,true);assert.equal(result.backend,'native-wasm');assert.equal(result.exitCode,42);assert.equal(typeof result.cache.moduleHit,'boolean');
});
