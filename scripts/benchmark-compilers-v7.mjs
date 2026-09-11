// Measured compiler and execution costs for the exact C# PE authenticated by the v7 CLR oracle.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {compileWasm, loadWasm} from '../src/wasm/index.js';
import {compileJavaScriptModule, generateModule} from '../src/il/compiler.mjs';
import {decodeNativeValue} from '../tests/wasm-native-values.mjs';

const model = JSON.parse(await readFile(new URL('../tests/compiler-v7-fixture.json', import.meta.url)));
const baseline = JSON.parse(await readFile(new URL('../tests/compiler-v7-baseline.json', import.meta.url)));
const pe = JSON.parse(await readFile(new URL('../tests/compiler-v7-pe.json', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(Buffer.from(pe.peBase64, 'base64')), baseline.assemblySha256);
assert.equal(sha256(await readFile(new URL('../tests/compiler-v7-fixture.cs', import.meta.url))), baseline.sourceSha256);
const report = {
  measuredAt: new Date().toISOString(),
  environment: {node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalProcessors: cpus().length},
  methodology: 'All five configurations consume the same unchanged IlInspector model of an actual C# PE emitted by the pinned Roslyn SDK. Every expected result comes from independent native .NET execution of those exact PE bytes. Emission covers the whole numeric fixture; execution uses selected methods. Seven samples rotate configuration order after 25 warm-up calls; every invocation and aggregate result is checked. The reference configuration disables compiler optimization in this release and is not a historical release baseline. Emission, JS function construction, engine compilation and instantiation are separate. Same-byte WebAssembly.compile can benefit from V8 internal caching. Runtime invoke and assertion overhead are included in execution timings. This benchmark excludes browser download, Roslyn initialization and the C# compile pipeline, which remain covered by benchmark-compilers.mjs.',
  fixture: {sourceSha256: baseline.sourceSha256, assemblySha256: baseline.assemblySha256, peBytes: Buffer.from(pe.peBase64, 'base64').length, sdk: baseline.sdk, roslynVersion: baseline.roslynVersion, nativeRuntime: baseline.runtime, nativeCases: baseline.cases.length},
  phases: {}, backends: {}, workloads: [],
};
const programs = [];
const summarize = values => ({samples: values.length, samplesMs: values, minimumMs: Math.min(...values), medianMs: [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)], maximumMs: Math.max(...values)});
async function measure(name, count, action) {
  const values = []; let result;
  for (let index = 0; index < count; index++) { const start = performance.now(); result = await action(); values.push(performance.now() - start); }
  report.phases[name] = summarize(values);
  console.log(`${name}: ${report.phases[name].medianMs.toFixed(3)} ms median`);
  return result;
}
function codeSectionBytes(bytes) {
  let at = 8;
  const unsigned = () => { let value = 0, shift = 0, byte; do { byte = bytes[at++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128); return value; };
  while (at < bytes.length) { const id = bytes[at++], size = unsigned(); if (id === 10) return size; at += size; }
  return 0;
}
try {
  for (const optimize of [false, 'blocks', true]) {
    const label = optimize === 'blocks' ? 'blocks' : optimize ? 'optimized' : 'reference';
    const source = await measure(`javascript.${label}.emitESModule`, 7, () => generateModule(model, {strict: true, optimize}));
    const factory = await measure(`javascript.${label}.emitAndConstructFunctions`, 7, () => compileJavaScriptModule(model, {strict: true, optimize}));
    const runtime = await measure(`javascript.${label}.instantiateFreshRuntime`, 7, () => factory.createRuntime());
    report.backends[`javascript.${label}`] = {optimization: factory.optimization, esModuleUtf8Bytes: Buffer.byteLength(source), generatedMethodUtf8Bytes: Object.values(factory.compiledMethods).reduce((sum, method) => sum + Buffer.byteLength(String(method)), 0)};
    programs.push({key: `javascript.${label}`, runtime});
    if (optimize === 'blocks') continue;
    const artifact = await measure(`wasm.${label}.emitBinary`, 7, () => compileWasm(model, {optimize}));
    assert.equal(WebAssembly.validate(artifact.bytes), true);
    const module = await measure(`wasm.${label}.engineCompileSameBytes`, 7, () => WebAssembly.compile(artifact.bytes));
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const wasm = await measure(`wasm.${label}.instantiateModule`, 7, () => loadWasm(module));
    report.backends[`wasm.${label}`] = {optimization: artifact.optimization, wasmBytes: artifact.bytes.length, nativeCodeSectionBytes: codeSectionBytes(artifact.bytes), moduleImports: []};
    programs.push({key: `wasm.${label}`, runtime: wasm});
  }
  for (const method of ['IntPolynomial', 'LongPolynomial', 'LongRecurrence', 'ULongRecurrence', 'SingleLoop', 'DoubleLoop', 'MixedLoop', 'LongFibonacci', 'DoubleCalls', 'PredicateLoop', 'BitLoop', 'ClampLoop', 'SignLoop']) {
    const count = method === 'LongFibonacci' ? 12 : 500;
    const oracle = baseline.cases.find(item => item.method === method && item.arguments.at(-1)?.value === String(count));
    assert.ok(oracle, `Native .NET benchmark oracle for ${method}`);
    assert.equal(oracle.exception, undefined);
    const args = oracle.arguments.map(decodeNativeValue), expected = decodeNativeValue(oracle.result), calls = ['PredicateLoop', 'BitLoop', 'ClampLoop', 'SignLoop'].includes(method) ? 25 : 100;
    report.workloads.push({method, calls, arguments: oracle.arguments, nativeResult: oracle.result});
    for (const program of programs) for (let index = 0; index < 25; index++) assert.equal(program.runtime.invoke(`CompilerV7::${method}`, args), expected);
    let expectedAggregate = typeof expected === 'bigint' ? 0n : 0;
    for (let call = 0; call < calls; call++) expectedAggregate += expected;
    const times = new Map(programs.map(program => [program.key, []]));
    for (let sample = 0; sample < 7; sample++) for (let offset = 0; offset < programs.length; offset++) {
      const program = programs[(sample + offset) % programs.length];
      let aggregate = typeof expected === 'bigint' ? 0n : 0;
      const start = performance.now();
      for (let call = 0; call < calls; call++) {
        const actual = program.runtime.invoke(`CompilerV7::${method}`, args);
        assert.equal(actual, expected);
        aggregate += actual;
      }
      times.get(program.key).push(performance.now() - start);
      assert.equal(aggregate, expectedAggregate);
    }
    for (const [key, values] of times) {
      const phase = `${key}.execute.${method}`;
      report.phases[phase] = summarize(values);
      console.log(`${phase}: ${report.phases[phase].medianMs.toFixed(3)} ms median`);
    }
  }
  // Optional isolated historical source checkout. No fetching or checkout mutation occurs here.
  // Example: ROSLYNWEB_BASELINE_DIR=/tmp/roslynweb-v6 node scripts/benchmark-compilers-v7.mjs
  if (process.env.ROSLYNWEB_BASELINE_DIR) {
    const directory = resolve(process.env.ROSLYNWEB_BASELINE_DIR);
    const previous = await import(pathToFileURL(join(directory, 'src/wasm/index.js')).href);
    const packageInfo = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const provenance = JSON.parse(await readFile(join(directory, 'benchmark-baseline.json'), 'utf8'));
    const names = ['ClampLoop', 'SignLoop'];
    const kernel = {...model, types: model.types.map(type => ({...type, methods: type.methods.filter(method => names.includes(method.name))}))};
    report.historicalComparison = {baselineVersion: packageInfo.version, provenance, methods: names, methodology: 'The same two unmodified real-C# method bodies are selected from the native oracle model and compiled by the previous release source checkout and the current release, both with default optimization. Compilation order is previous/current; execution order alternates after warm-up. Previous native modules use explicit JavaScript managed-service imports; current modules have zero imports. All native results must match the independent CLR oracle.'};
    const historicalPrograms = [];
    for (const [label, api] of [['previous', previous], ['current', {compileWasm, loadWasm}]]) {
      const artifact = await measure(`historical.wasm.${label}.emitBinary`, 7, () => api.compileWasm(kernel));
      const module = await WebAssembly.compile(artifact.bytes);
      const runtime = await api.loadWasm(module);
      historicalPrograms.push({label, runtime});
      programs.push({key: `historical.${label}`, runtime});
      report.historicalComparison[label] = {optimization: artifact.optimization, wasmBytes: artifact.bytes.length, nativeCodeSectionBytes: codeSectionBytes(artifact.bytes), imports: WebAssembly.Module.imports(module)};
    }
    for (const method of names) {
      const oracle = baseline.cases.find(item => item.method === method && item.arguments.at(-1)?.value === '500');
      const args = oracle.arguments.map(decodeNativeValue), expected = decodeNativeValue(oracle.result), calls = 25;
      for (const {runtime} of historicalPrograms) for (let warm = 0; warm < 25; warm++) assert.equal(runtime.invoke(`CompilerV7::${method}`, args), expected);
      const times = new Map(historicalPrograms.map(program => [program.label, []]));
      for (let sample = 0; sample < 7; sample++) for (let offset = 0; offset < 2; offset++) {
        const program = historicalPrograms[(sample + offset) % 2];
        const start = performance.now();
        for (let call = 0; call < calls; call++) assert.equal(program.runtime.invoke(`CompilerV7::${method}`, args), expected);
        times.get(program.label).push(performance.now() - start);
      }
      for (const [label, values] of times) {
        const phase = `historical.wasm.${label}.execute.${method}`;
        report.phases[phase] = summarize(values);
        console.log(`${phase}: ${report.phases[phase].medianMs.toFixed(3)} ms median`);
      }
    }
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = {name: error.name, message: error.message, stack: error.stack};
  process.exitCode = 1;
  console.error(error);
} finally {
  for (const program of programs) program.runtime.dispose?.();
  await writeFile(new URL('../docs/compiler-performance-v7.json', import.meta.url), JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
}
