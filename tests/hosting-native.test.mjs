import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeModuleRegistry, LinearMemory } from '../src/hosting/index.js';
import { compileAssembly } from '../src/il/index.js';

const uleb = n => { const bytes = []; do { const b = n & 127; n >>>= 7; bytes.push(b | (n ? 128 : 0)); } while (n); return bytes; };
const vector = items => [...uleb(items.length), ...items.flat()];
const text = value => [...uleb(value.length), ...new TextEncoder().encode(value)];
const section = (id, bytes) => [id, ...uleb(bytes.length), ...bytes];
// A real wasm binary: add(i32,i32), add64(i64,i64), f32/f64 identity,
// pointer identity, mutate first buffer byte, trap. No JavaScript mock exports.
const functions = [
  { name: 'add', params: [127,127], result: [127], body: [32,0,32,1,106] },
  { name: 'add64', params: [126,126], result: [126], body: [32,0,32,1,124] },
  { name: 'float32', params: [125], result: [125], body: [32,0] },
  { name: 'float64', params: [124], result: [124], body: [32,0] },
  { name: 'identity', params: [127], result: [127], body: [32,0] },
  { name: 'setByte', params: [127,127], result: [], body: [32,0,32,1,58,0,0] },
  { name: 'trap', params: [127], result: [], body: [0] }
];
const wasm = new Uint8Array([
  0,97,115,109,1,0,0,0,
  ...section(1, vector(functions.map(f => [96, ...vector(f.params.map(p => [p])), ...vector(f.result.map(p => [p]))]))),
  ...section(3, vector(functions.map((_, i) => uleb(i)))),
  ...section(5, [1,0,1]),
  ...section(7, vector([...functions.map((f, i) => [...text(f.name), 0, ...uleb(i)]), [...text('memory'),2,0]])),
  ...section(10, vector(functions.map(f => { const body = [0, ...f.body,11]; return [...uleb(body.length), ...body]; })))
]);
const register = async () => { const registry = new NativeModuleRegistry(); await registry.register('fixture', wasm, { arena: { base: 1024, size: 4096 } }); return registry; };
const bind = (registry, entryPoint, parameters, result) => registry.bind({ library:'fixture', entryPoint, key:`Native::${entryPoint}`, parameters, result });

test('native registry instantiates genuine wasm numeric exports with exact i64 values', async () => {
  const registry = await register();
  assert.equal(bind(registry, 'add', ['i32','i32'], 'i32')(2147483647,1), -2147483648);
  assert.equal(bind(registry, 'add64', ['i64','i64'], 'i64')(9007199254740993n,2n),9007199254740995n);
  assert.equal(bind(registry, 'float32', ['f32'], 'f32')(1 / 3),Math.fround(1 / 3));
  assert.equal(bind(registry, 'float64', ['f64'], 'f64')(Math.PI),Math.PI);
  assert.throws(() => registry.externals.get('Native::add64')(9007199254740994,1), /safe integer/);
  assert.throws(() => registry.externals.get('Native::add')(0.5,1), /safe integer/);
  assert.throws(() => registry.externals.get('Native::add')(1), /Expected 2/);
});

test('native utf8 and utf16 marshalling round trips through wasm pointers and releases allocations', async () => {
  const registry = await register();
  const utf8 = registry.bind({ library:'fixture', entryPoint:'identity', key:'Utf8', parameters:['utf8'], result:'utf8' });
  const utf16 = registry.bind({ library:'fixture', entryPoint:'identity', key:'Utf16', parameters:['utf16'], result:'utf16' });
  for (const value of ['Zażółć gęślą jaźń 😃', '', '你好']) { assert.equal(utf8(value),value); assert.equal(utf16(value),value); }
  assert.equal(registry.modules.get('fixture').memory.allocations.size,0);
  assert.throws(() => utf8('a\0b'), /embedded null/);
  assert.throws(() => utf8(null), /cannot be null/);
  const nullable = registry.bind({ library:'fixture', entryPoint:'identity', key:'nullable', parameters:[{type:'utf8',nullable:true}], result:'utf8' });
  assert.equal(nullable(null),null);
});

test('native buffers copy out mutated bytes, clean up on wasm traps, and enforce bounds', async () => {
  const registry = await register(), entry = registry.modules.get('fixture');
  const mutate = bind(registry,'setByte',[{type:'bytes',direction:'inout'},'i32'],'void');
  const bytes = new Uint8Array([1,2,3]); mutate(bytes,99); assert.deepEqual([...bytes],[99,2,3]);
  const fail = bind(registry,'trap',['utf8'],'void'); assert.throws(() => fail('temporary'),WebAssembly.RuntimeError);
  assert.equal(entry.memory.allocations.size,0);
  assert.throws(() => entry.memory.read(65535,2), /out of bounds/);
  assert.throws(() => entry.memory.allocate(5000), /exhausted/);
  assert.throws(() => entry.memory.free(1024), /not an active/);
});

test('reserved arena coalesces allocations and reads refreshed memory after growth', () => {
  const memory = new WebAssembly.Memory({initial:1}), heap = new LinearMemory(memory,{arena:{base:1001,size:100}});
  const a = heap.allocate(30,8), b = heap.allocate(30,8); assert.equal(a % 8,0); assert.equal(b % 8,0);
  heap.free(a); heap.free(b); const all = heap.allocate(100,1); assert.equal(all,1001);
  memory.grow(1); heap.write(all,new Uint8Array([42])); assert.deepEqual([...heap.read(all,1)],[42]);
  heap.free(all); assert.throws(() => new LinearMemory(memory).allocate(1), /explicitly reserved/);
  assert.throws(() => new LinearMemory(memory,{arena:{base:0,size:10}}), /null pointer/);
  assert.throws(() => new LinearMemory(memory,{malloc:()=>10}), /matching free/);
});

test('wasm URL loading uses fetch and unload invalidates existing bindings', async () => {
  let fetched;
  const registry = new NativeModuleRegistry({ fetch: async url => { fetched = url; return new Response(wasm); } });
  await registry.register('fixture', 'https://example.test/native.wasm'); assert.equal(fetched,'https://example.test/native.wasm');
  const add = bind(registry,'add',['i32','i32'],'i32'); assert.equal(add(2,3),5);
  assert.throws(() => bind(registry,'missing',[],'void'), /not callable/);
  await assert.rejects(registry.register('fixture',wasm), /already registered/);
  registry.unregister('fixture'); assert.throws(() => add(2,3), /unloaded/); assert.equal(registry.externals.size,0);
  registry.dispose(); await assert.rejects(registry.register('later',wasm), /disposed/);
});

test('native registry accepts compiled WebAssembly.Module with real imported functions', async () => {
  const imported = new Uint8Array([0,97,115,109,1,0,0,0,
    ...section(1,[1,96,1,127,1,127]),
    ...section(2,[1,...text('env'),...text('bias'),0,0]),
    ...section(3,[1,0]),
    ...section(7,[1,...text('calculate'),0,1]),
    ...section(10,[1,6,0,32,0,16,0,11])]);
  const registry=new NativeModuleRegistry();
  await registry.register('imported',await WebAssembly.compile(imported),{imports:{env:{bias:x=>x+7}}});
  const calculate=registry.bind({library:'imported',entryPoint:'calculate',key:'Native::Calculate',parameters:['i32'],result:'i32'});
  assert.equal(calculate(35),42);
  const abort=new AbortController(); abort.abort();
  await assert.rejects(registry.register('aborted',imported,{signal:abort.signal}),{name:'AbortError'});
});

test('an explicit managed external invokes actual wasm from generated MSIL JavaScript', async () => {
  const registry = await register();
  const native = { declaringType:'Native',name:'Add',isStatic:true,parameters:[{type:'System.Int32'},{type:'System.Int32'}],returnType:'System.Int32' };
  registry.bind({ library:'fixture',entryPoint:'add',managed:{type:'Native',name:'Add',parameters:['System.Int32','System.Int32']},parameters:['i32','i32'],result:'i32' });
  const method = { token:1,name:'Main',declaringType:'Program',isStatic:true,parameters:[],returnType:'System.Int32',locals:[],exceptionHandlers:[],body:[{offset:0,opcode:'ldc.i4',operand:19},{offset:1,opcode:'ldc.i4',operand:23},{offset:2,opcode:'call',operand:native},{offset:3,opcode:'ret'}] };
  const model = {name:'NativeTest',entryPoint:1,types:[{name:'Program',fields:[],methods:[method]}]};
  assert.equal(compileAssembly(model,{externals:registry.externals,strict:true}).run(),42);
});

test('managed byte-array inout bindings retain CLR array identity across actual wasm writes', async () => {
  const registry=await register();
  registry.bind({library:'fixture',entryPoint:'setByte',managed:{type:'Native',name:'Set',parameters:['System.Byte[]','System.Int32']},parameters:[{type:'bytes',direction:'inout'},'i32'],result:'void'});
  const native={declaringType:'Native',name:'Set',isStatic:true,parameters:[{type:'System.Byte[]'},{type:'System.Int32'}],returnType:'System.Void'};
  const instructions=[['ldc.i4.1'],['newarr',{name:'System.Byte'}],['stloc.0'],['ldloc.0'],['ldc.i4',255],['call',native],['ldloc.0'],['ldc.i4.0'],['ldelem.u1'],['ret']];
  const method={token:1,name:'Main',declaringType:'Program',isStatic:true,parameters:[],returnType:'System.Int32',locals:['System.Byte[]'],exceptionHandlers:[],body:instructions.map(([opcode,operand],offset)=>({offset,opcode,operand}))};
  const model={name:'NativeArrayTest',entryPoint:1,types:[{name:'Program',fields:[],methods:[method]}]};
  assert.equal(compileAssembly(model,{externals:registry.externals,strict:true}).run(),255);
  assert.equal(registry.modules.get('fixture').memory.allocations.size,0);
});

test('native results reject unterminated strings without reading beyond declared bounds', () => {
  const memory = new WebAssembly.Memory({initial:1}), heap = new LinearMemory(memory,{arena:{base:100,size:20}});
  new Uint8Array(memory.buffer).fill(65,100,120);
  assert.throws(() => heap.readString(100,'utf8',20), /Unterminated/);
  assert.throws(() => heap.readString(100,'utf16',20), /Unterminated/);
  assert.throws(() => heap.readString(100,'utf8',-1), /nonnegative/);
});
