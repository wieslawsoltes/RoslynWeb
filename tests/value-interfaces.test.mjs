import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {compileWasm, loadWasm} from '../src/wasm/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {createRuntime,i4} from '../src/il/runtime.mjs';
import {invokeStandardValueBuiltin} from '../src/il/standard-values.mjs';
import {decodeNativeValue} from './wasm-native-values.mjs';

const model = JSON.parse(await readFile(new URL('./value-interfaces-fixture.json', import.meta.url)));
const baseline = JSON.parse(await readFile(new URL('./value-interfaces-baseline.json', import.meta.url)));
const pe = JSON.parse(await readFile(new URL('./value-interfaces-pe.json', import.meta.url)));
const programs = new Map();

// Preserve NaN's sign/payload as well as signed zero for bit-reinterpretation cases.
function decode(encoded) {
  if (encoded.bits !== undefined) {
    const view = new DataView(new ArrayBuffer(8));
    if (encoded.type === 'float') { view.setInt32(0, Number(encoded.bits), true); return view.getFloat32(0, true); }
    view.setBigInt64(0, BigInt(encoded.bits), true); return view.getFloat64(0, true);
  }
  if(encoded.type==='char')return Number(encoded.value);
  return decodeNativeValue(encoded);
}
async function runtimeFor(backend, optimize, method) {
  const key = `${backend}:${optimize}:${backend === 'wasm' ? method : 'assembly'}`;
  if (!programs.has(key)) {
    programs.set(key, backend === 'wasm'
      ? Promise.resolve().then(() => {
          const artifact = compileWasm(model, {exports: [{type: 'ValueInterfaces', method}], optimize});
          assert.equal(WebAssembly.validate(artifact.bytes), true);
          return loadWasm(artifact.bytes);
        })
      : Promise.resolve().then(() => compileAssembly({...model,types:model.types.map(type=>({...type,methods:type.methods.filter(m=>m.name!=='UnrelatedUnsupported'&&!(m.name==='GetHashCode'&&type.name==='ValueInterfaces')&&!m.parameters?.some(p=>p.type.includes('System.Span`1')))}))}, {optimize, strict: true})));
  }
  return programs.get(key);
}

test('value interfaces differential oracle authenticates exact real Roslyn source and PE', async () => {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bytes = Buffer.from(pe.peBase64, 'base64');
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  assert.equal(hash(bytes), baseline.assemblySha256);
  assert.equal(pe.assemblySha256, baseline.assemblySha256);
  assert.equal(hash(await readFile(new URL('./value-interfaces-fixture.cs', import.meta.url))), baseline.sourceSha256);
  assert.equal(baseline.sdk, '10.0.100');
  assert.equal(baseline.roslynVersion, '5.0.0.0');
  assert.ok(model.types.flatMap(type => type.methods).some(method => method.name==='UnrelatedUnsupported'));
});

for (const backend of ['javascript', 'wasm']) for (const optimize of backend === 'javascript' ? [false, 'blocks', true] : [false, true]) {
  for (const [index, item] of baseline.cases.entries()) {
    test(`value interfaces ${backend} optimize=${optimize} CLR oracle ${index + 1}: ${item.method}(${item.arguments.map(arg => arg.value).join(', ')})`, async () => {
      const program = await runtimeFor(backend, optimize, item.method);
      const args = item.arguments.map(decode);
      if (item.exception) {
        assert.throws(() => program.invoke(`ValueInterfaces::${item.method}`, args), error => {
          assert.equal(error.type ?? error.managedType ?? error.$type, item.exception);
          return true;
        });
      } else {
        assert.equal(program.invoke(`ValueInterfaces::${item.method}`, args), decode(item.result));
      }
    });
  }
}

test('native comparer callbacks retain exact closed implementations without unrelated unsupported overloads',()=>{
  const artifact=compileWasm(model,{exports:['StructuralExplicit','StructuralEqual','ManagedHashOverride']});
  assert.equal(WebAssembly.validate(artifact.bytes),true);
  assert.ok(artifact.manifest.methods.some(m=>m.type==='ExplicitComparer`1<System.Int32>'&&m.name.endsWith('.Equals')));
  assert.ok(!artifact.manifest.methods.some(m=>m.name==='UnrelatedUnsupported'||m.parameters?.some(p=>String(p.type??p).includes('System.Span`1'))));
  const methods=artifact.manifest.model.types.flatMap(type=>type.methods);
  assert.ok(methods.every(method=>!method.body&&!method.instructions));
});

test('static tuple hashing does not retain unused instance overrides on its containing class',()=>{
  const artifact=compileWasm(model,{exports:['SingleTupleHash']});
  assert.ok(!artifact.manifest.methods.some(m=>m.name==='GetHashCode'&&m.type==='ValueInterfaces'));
  assert.equal(WebAssembly.validate(artifact.bytes),true);
});

test('tuple hash combiner matches native CLR exactly with the recorded native random seed',()=>{
  const rt=createRuntime({name:'HashOracle',types:[]});rt.standardHashSeed=baseline.tupleHashes.seed;
  function tuple(values){if(!values.length)return rt.defaultValue('System.ValueTuple');const rest=values.length>7?tuple(values.slice(7)):null;const types=[...values.slice(0,7).map(()=>'System.Int32'),...(rest?[rest.$type]:[])],type='System.ValueTuple`'+types.length+'<'+types.join(',')+'>';const value=rt.defaultValue(type);for(let i=0;i<Math.min(7,values.length);i++)value.fields[type+'::Item'+(i+1)]=i4(values[i]);if(rest)value.fields[type+'::Rest']=rest;return value;}
  for(let length=0;length<baseline.tupleHashes.values.length;length++){const value=tuple(Array.from({length},(_,i)=>i+1));const actual=invokeStandardValueBuiltin(rt,{declaringType:value.$type,name:'GetHashCode',parameters:[]},[],value).value.value;assert.equal(actual,baseline.tupleHashes.values[length],'arity '+length);}
});

test.after(async () => {
  for (const promise of programs.values()) {
    const result = await promise.catch(() => null);
    result?.dispose?.();
  }
});
