import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {compileWasm, loadWasm} from '../src/wasm/index.js';
import {compileAssembly} from '../src/il/compiler.mjs';
import {decodeNativeValue} from './wasm-native-values.mjs';

const model = JSON.parse(await readFile(new URL('./compiler-v6-fixture.json', import.meta.url)));
const baseline = JSON.parse(await readFile(new URL('./compiler-v6-baseline.json', import.meta.url)));
const pe = JSON.parse(await readFile(new URL('./compiler-v6-pe.json', import.meta.url)));
const programs = new Map();

// Preserve NaN's sign/payload as well as signed zero for bit-reinterpretation cases.
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
  if (!programs.has(key)) {
    programs.set(key, backend === 'wasm'
      ? Promise.resolve().then(() => {
          const artifact = compileWasm(model, {exports: [{type: 'CompilerV6', method}], optimize});
          assert.equal(WebAssembly.validate(artifact.bytes), true);
          return loadWasm(artifact.bytes);
        })
      : Promise.resolve().then(() => compileAssembly(model, {optimize, strict: true})));
  }
  return programs.get(key);
}

test('v6 differential oracle authenticates exact real Roslyn source and PE', async () => {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const bytes = Buffer.from(pe.peBase64, 'base64');
  assert.equal(bytes.subarray(0, 2).toString(), 'MZ');
  assert.equal(hash(bytes), baseline.assemblySha256);
  assert.equal(pe.assemblySha256, baseline.assemblySha256);
  assert.equal(hash(await readFile(new URL('./compiler-v6-fixture.cs', import.meta.url))), baseline.sourceSha256);
  assert.equal(baseline.sdk, '10.0.100');
  assert.equal(baseline.roslynVersion, '5.0.0.0');
  assert.ok(model.types.flatMap(type => type.methods).some(method => method.exceptionHandlers?.some(region => region.kind === 'filter')));
});

for (const backend of ['javascript', 'wasm']) for (const optimize of backend === 'javascript' ? [false, 'blocks', true] : [false, true]) {
  for (const [index, item] of baseline.cases.entries()) {
    test(`v6 ${backend} optimize=${optimize} CLR oracle ${index + 1}: ${item.method}(${item.arguments.map(arg => arg.value).join(', ')})`, async () => {
      const program = await runtimeFor(backend, optimize, item.method);
      const args = item.arguments.map(decode);
      if (item.exception) {
        assert.throws(() => program.invoke(`CompilerV6::${item.method}`, args), error => {
          assert.equal(error.type ?? error.managedType ?? error.$type, item.exception);
          return true;
        });
      } else {
        assert.equal(program.invoke(`CompilerV6::${item.method}`, args), decode(item.result));
      }
    });
  }
}

for (const optimize of [false, true]) {
  test(`v6 optimized=${optimize} numerical Wasm executes in a fresh process without runtime imports`, () => {
    const artifact = compileWasm(model, {exports: ['Polynomial', 'LongPolynomial', 'NestedControl', 'Irreducible'], optimize});
    const exportName = name => artifact.manifest.methods.find(method => method.name === name).exportName;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const bytes = Buffer.from(process.argv[1], 'base64');
      if (!WebAssembly.validate(bytes)) throw new Error('Invalid Wasm');
      const {instance, module} = await WebAssembly.instantiate(bytes, {});
      if (WebAssembly.Module.imports(module).length) throw new Error('Unexpected runtime import');
      const names = JSON.parse(process.argv[2]);
      process.stdout.write(JSON.stringify(names.map(name => String(instance.exports[name](31)))));
    `, Buffer.from(artifact.bytes).toString('base64'), JSON.stringify(['Polynomial', 'LongPolynomial', 'NestedControl', 'Irreducible'].map(exportName))], {encoding: 'utf8', timeout: 10000});
    assert.equal(child.status, 0, child.stderr);
    const expected = ['Polynomial', 'LongPolynomial', 'NestedControl', 'Irreducible'].map(method => baseline.cases.find(item => item.method === method && item.arguments[0]?.value === '31').result.value);
    assert.deepEqual(JSON.parse(child.stdout), expected);
  });
}

test.after(async () => {
  for (const promise of programs.values()) {
    const result = await promise.catch(() => null);
    result?.dispose?.();
  }
});
