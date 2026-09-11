import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {compileWasm, loadWasm} from '../src/wasm/index.js';
import {decodeNativeValue, normalizeWasmScalar} from './wasm-native-values.mjs';

const model = JSON.parse(await readFile(new URL('./wasm-native-fixture.json', import.meta.url)));
const baseline = JSON.parse(await readFile(new URL('./wasm-native-baseline.json', import.meta.url)));
const peFixture = JSON.parse(await readFile(new URL('./wasm-native-pe.json', import.meta.url)));
const artifacts = new Map(), programs = new Map();
const selector = name => `NativeNumeric::${name}`;
function artifactFor(name) {
  if (!artifacts.has(name)) artifacts.set(name, compileWasm(model, {exports: [name, ...(name === 'ReflectedCall' ? ['Add'] : [])]}));
  return artifacts.get(name);
}
async function programFor(name) {
  if (!programs.has(name)) programs.set(name, loadWasm(artifactFor(name).bytes));
  return programs.get(name);
}

test('native differential fixture preserves genuine PE identity and exact source hash', async () => {
  const pe = Buffer.from(peFixture.peBase64, 'base64');
  assert.equal(pe.subarray(0, 2).toString(), 'MZ');
  assert.equal(createHash('sha256').update(pe).digest('hex'), baseline.assemblySha256);
  assert.equal(peFixture.assemblySha256, baseline.assemblySha256);
  assert.equal(createHash('sha256').update(await readFile(new URL('./wasm-native-fixture.cs', import.meta.url))).digest('hex'), baseline.sourceSha256);
  assert.equal(baseline.sdk, '10.0.100');
  assert.equal(baseline.roslynVersion, '5.0.0.0');
  assert.ok(model.types.flatMap(type => type.methods).some(method => method.body?.some(instruction => instruction.opcode === 'switch')));
});

for (const [index, item] of baseline.cases.entries()) {
  test(`actual C# → MSIL → native Wasm differential ${index + 1}: ${item.method}(${item.arguments.map(value => value.value).join(', ')})`, async () => {
    const artifact = artifactFor(item.method);
    assert.ok(artifact.bytes instanceof Uint8Array);
    assert.equal(WebAssembly.validate(artifact.bytes), true);
    const program = await programFor(item.method);
    assert.ok(program.module instanceof WebAssembly.Module);
    assert.ok(program.instance instanceof WebAssembly.Instance);
    const args = item.arguments.map(decodeNativeValue);
    if (item.exception) {
      assert.throws(() => program.invoke(selector(item.method), args), error => {
        assert.equal(error.type ?? error.managedType ?? error.$type, item.exception);
        return true;
      });
    } else {
      const actual = program.invoke(selector(item.method), args);
      assert.equal(actual, decodeNativeValue(item.result));
    }
  });
}

for (const item of baseline.unsupportedCases) {
  if(!['ExceptionFilter','DecimalValue'].includes(item.method)){
    test(`real CLR ${item.method} fixture is rejected before unsupported native storage`,()=>{
      assert.throws(()=>compileWasm(model,{exports:[{type:item.type,method:item.method}]}),error=>error.code==='WASM_UNSUPPORTED'&&error.diagnostics.some(d=>d.code==='WASM_UNSUPPORTED_TYPE'));
    });continue;
  }

  test(`formerly unsupported genuine C# ${item.method} executes direct native Wasm`,async()=>{
    const artifact=compileWasm(model,{exports:[{type:item.type,method:item.method}]});
    const program=await loadWasm(artifact.bytes);
    assert.equal(program.invoke(`${item.type}::${item.method}`),decodeNativeValue(item.nativeResult));program.dispose();
  });
}

for (const name of ['Add', 'Fibonacci', 'Loop', 'LongAdd', 'DoubleArithmetic', 'UnsignedDivide', 'DoubleToInt', 'DoubleToULong', 'DoubleRemainder', 'SingleRemainder', 'SquareRoot', 'RoundDouble', 'RoundSingle', 'MinSByte', 'MaxUInt']) {
  test(`portable numeric export ${name} instantiates and executes with no imports`, async () => {
    const artifact = artifactFor(name);
    const module = await WebAssembly.compile(artifact.bytes);
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    assert.equal(WebAssembly.Module.customSections(module, 'roslyn.web.manifest').length, 1);
    const method = artifact.manifest.methods.find(method => method.type === 'NativeNumeric' && method.name === name);
    assert.ok(method, `Missing export metadata for ${name}`);
    assert.ok(WebAssembly.Module.exports(module).some(value => value.name === method.exportName && value.kind === 'function'));
    const instance = await WebAssembly.instantiate(module, {});
    const example = baseline.cases.find(item => item.method === name && !item.exception);
    const actual = instance.exports[method.exportName](...example.arguments.map(decodeNativeValue));
    assert.equal(normalizeWasmScalar(actual, example.result), decodeNativeValue(example.result));
  });
}

test('saved portable Wasm executes in a fresh process with only the WebAssembly API', () => {
  const artifact = artifactFor('Fibonacci');
  const method = artifact.manifest.methods.find(method => method.name === 'Fibonacci');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const bytes = Buffer.from(process.argv[1], 'base64');
    if (!WebAssembly.validate(bytes)) throw new Error('Invalid Wasm');
    const {instance, module} = await WebAssembly.instantiate(bytes, {});
    if (WebAssembly.Module.imports(module).length) throw new Error('Unexpected imports');
    process.stdout.write(String(instance.exports[process.argv[2]](12)));
  `, Buffer.from(artifact.bytes).toString('base64'), method.exportName], {encoding: 'utf8', timeout: 10000});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '144');
});

test('CLR arrays are services while arithmetic loop bodies remain Wasm exports', async () => {
  const artifact = artifactFor('ArrayLoop'), module = await WebAssembly.compile(artifact.bytes);
  assert.ok(WebAssembly.Module.imports(module).length > 0);
  const method = artifact.manifest.methods.find(method => method.name === 'ArrayLoop');
  assert.ok(WebAssembly.Module.exports(module).some(value => value.name === method.exportName && value.kind === 'function'));
  const program = await loadWasm(artifact.bytes);
  assert.equal(program.invoke(selector('ArrayLoop'), [20]), 1290);
  program.dispose();
});

test('Console receives native function output with exact Int64 text and newlines', async () => {
  const program = await loadWasm(artifactFor('Main').bytes);
  assert.equal(program.invoke(selector('Main')), baseline.entryPoint.exitCode);
  assert.equal(program.stdout, baseline.entryPoint.stdout);
  program.dispose();
});
