import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {compileWasm, loadWasm} from '../src/wasm/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {decodeNativeValue, normalizeWasmScalar} from './wasm-native-values.mjs';

const model = JSON.parse(await readFile(new URL('./compiler-v7-fixture.json', import.meta.url)));
const baseline = JSON.parse(await readFile(new URL('./compiler-v7-baseline.json', import.meta.url)));
const pe = JSON.parse(await readFile(new URL('./compiler-v7-pe.json', import.meta.url)));
const programs = new Map();
const casesByMethod = Map.groupBy(baseline.cases, item => item.method);

// Keep signed zero and native NaN inputs when crossing the JSON fixture boundary.
function decode(encoded) {
  if (encoded.bits !== undefined) {
    const view = new DataView(new ArrayBuffer(8));
    if (encoded.type === 'float') { view.setInt32(0, Number(encoded.bits), true); return view.getFloat32(0, true); }
    view.setBigInt64(0, BigInt(encoded.bits), true); return view.getFloat64(0, true);
  }
  return decodeNativeValue(encoded);
}
async function runtimeFor(backend, optimize, method) {
  const key = `${backend}:${optimize}:${backend === 'wasm' ? method : 'assembly'}`;
  if (!programs.has(key)) programs.set(key, backend === 'wasm'
    ? Promise.resolve().then(() => {
      const artifact = compileWasm(model, {exports: [{type: 'CompilerV7', method}], optimize});
      assert.equal(WebAssembly.validate(artifact.bytes), true, `${method} emitted valid Wasm`);
      return loadWasm(artifact.bytes);
    })
    : Promise.resolve().then(() => compileAssembly(model, {optimize, strict: true})));
  return programs.get(key);
}

test('v7 differential oracle authenticates exact real Roslyn source and PE', async () => {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bytes = Buffer.from(pe.peBase64, 'base64');
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  assert.equal(hash(bytes), baseline.assemblySha256);
  assert.equal(pe.assemblySha256, baseline.assemblySha256);
  assert.equal(hash(await readFile(new URL('./compiler-v7-fixture.cs', import.meta.url))), baseline.sourceSha256);
  assert.equal(baseline.sdk, '10.0.100');
  assert.equal(baseline.roslynVersion, '5.0.0.0');
  assert.match(baseline.runtime, /^10\.0\.\d+$/);
  assert.ok(baseline.cases.length > 1500);
  assert.ok(baseline.cases.some(item => item.exception === 'System.OverflowException'));
  assert.ok(baseline.cases.some(item => item.exception === 'System.DivideByZeroException'));
  assert.ok(baseline.cases.some(item => item.exception === 'System.ArgumentException'));
  assert.ok(baseline.cases.some(item => item.arguments.some(arg => arg.value === '-0')));
});

for (const backend of ['javascript', 'wasm']) for (const optimize of backend === 'javascript' ? [false, 'blocks', true] : [false, true]) {
  for (const [method, cases] of casesByMethod) {
    test(`v7 ${backend} optimize=${optimize}: ${method}, ${cases.length} independent CLR cases`, async () => {
      const program = await runtimeFor(backend, optimize, method);
      for (const item of cases) {
        const args = item.arguments.map(decode);
        const context = `${method}(${item.arguments.map(arg => arg.value).join(', ')})`;
        if (item.exception) {
          assert.throws(() => program.invoke(`CompilerV7::${method}`, args), error => {
            assert.equal(error.type ?? error.managedType ?? error.$type, item.exception, context);
            return true;
          }, context);
        } else {
          assert.equal(program.invoke(`CompilerV7::${method}`, args), decode(item.result), context);
        }
      }
    });
  }
}

for (const optimize of [false, true]) {
  test(`v7 optimize=${optimize}: actual numeric loops, recursion and intrinsics execute with zero Wasm imports`, () => {
    const selected = ['IntPolynomial', 'LongPolynomial', 'LongRecurrence', 'ULongRecurrence', 'SingleLoop', 'DoubleLoop', 'MixedLoop', 'LongFibonacci', 'DoubleCalls', 'PredicateLoop', 'BitLoop', 'ClampLoop', 'SignLoop'];
    const cases = selected.map(method => {
      const candidates = casesByMethod.get(method).filter(item => !item.exception);
      return candidates.find(item => item.arguments.at(-1)?.value === '500') ?? candidates.at(-1);
    });
    const artifact = compileWasm(model, {exports: selected, optimize});
    const exported = cases.map(item => ({...item, name: artifact.manifest.methods.find(method => method.name === item.method).exportName}));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const bytes = Buffer.from(process.argv[1], 'base64');
      if (!WebAssembly.validate(bytes)) throw new Error('Invalid Wasm');
      const {instance, module} = await WebAssembly.instantiate(bytes, {});
      if (WebAssembly.Module.imports(module).length) throw new Error('Unexpected runtime import');
      const cases = JSON.parse(process.argv[2]);
      const outputs = cases.map(item => {
        const args = item.arguments.map(arg => arg.type === 'long' || arg.type === 'ulong' ? BigInt(arg.value) : Number(arg.value));
        const value = instance.exports[item.name](...args);
        return typeof value === 'bigint' ? (item.result.type === 'ulong' ? BigInt.asUintN(64, value) : value).toString() : Object.is(value, -0) ? '-0' : String(value);
      });
      process.stdout.write(JSON.stringify(outputs));
    `, Buffer.from(artifact.bytes).toString('base64'), JSON.stringify(exported)], {encoding: 'utf8', timeout: 10000});
    assert.equal(child.status, 0, child.stderr);
    const expected = cases.map(item => {
      const value = normalizeWasmScalar(decode(item.result), item.result);
      return Object.is(value, -0) ? '-0' : String(value);
    });
    assert.deepEqual(JSON.parse(child.stdout), expected);
  });
}

test.after(async () => {
  for (const promise of programs.values()) (await promise.catch(() => null))?.dispose?.();
});
