// Measured phase timings, not a cross-machine or browser performance guarantee.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import {compileWasm, loadWasm} from '../src/wasm/index.js';

const source = `public static class NativeBenchmark {
  public static int Add(int a, int b) => a + b;
  public static long Sum(int count) { long total = 0; for (int i = 0; i < count; i++) total += (long)i * (i + 1); return total; }
  public static int Fibonacci(int n) => n < 2 ? n : Fibonacci(n - 1) + Fibonacci(n - 2);
}`;
const options = {outputKind: 'library', assemblyName: 'NativeBenchmark', optimization: 'release', emitPdb: false};
const report = {
  measuredAt: new Date().toISOString(),
  environment: {runtime: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalProcessors: cpus().length},
  methodology: 'Real C# compilation in the bundled .NET WebAssembly runtime hosted by Node, followed by genuine IL-to-Wasm emission and native WebAssembly execution. Timings are sequential wall-clock measurements in this environment, with warm-up identified explicitly. Browser loading and other devices can differ. Cached work is reported separately from actual compilation.',
  source, sourceSha256: createHash('sha256').update(source).digest('hex'),
  phases: {},
};
const samples = values => ({samples: values.length, firstMs: values[0], minimumMs: Math.min(...values), medianMs: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)], maximumMs: Math.max(...values), totalMs: values.reduce((a, b) => a + b, 0)});
async function measure(name, count, action) {
  const values = []; let result;
  for (let i = 0; i < count; i++) { const start = performance.now(); result = await action(i); values.push(performance.now() - start); }
  report.phases[name] = samples(values);
  console.log(`${name}: ${report.phases[name].medianMs.toFixed(3)} ms median (${count} samples)`);
  return result;
}
const assertCompilation = result => {assert.equal(result.success, true, JSON.stringify(result.error ?? result.diagnostics)); return result;};
let compiler, program;
try {
  const {createRoslyn} = await import('../src/browser.js');
  compiler = await measure('roslynRuntimeStartup', 1, () => createRoslyn({worker: false, baseUrl: new URL('../dist/', import.meta.url).href}));
  report.managedRuntime = compiler.info;
  const cold = assertCompilation(await measure('coldCSharpToPE', 1, () => compiler.compile(source, {...options, useCompilationCache: false})));
  report.coldRoslynPerformance = cold.performance ?? null;
  report.peBytes = cold.pe.length;
  const model = await measure('inspectPEToILModel', 5, () => compiler.inspect(cold));
  const emitted = await measure('uncachedILToWasmBinary', 10, () => compileWasm(model));
  assert.equal(WebAssembly.validate(emitted.bytes), true);
  report.wasmBytes = emitted.bytes.length;
  report.compilerTimings = emitted.timings;
  const module = await measure('webAssemblyCompileSameBytes', 10, () => WebAssembly.compile(emitted.bytes));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  report.noteOnEngineCache = 'Repeated WebAssembly.compile receives identical bytes; V8 may reuse its internal code cache. The first call and repeated distribution are reported without claiming forced cold engine compilation.';
  report.phases.webAssemblyCompileSameBytes.firstCallIncluded = true;
  program = await measure('portableModuleInstantiation', 1, () => loadWasm(module));
  assert.equal(program.invoke('NativeBenchmark::Sum', [1000]), 333333000n);
  assert.equal(program.invoke('NativeBenchmark::Fibonacci', [12]), 144);
  const warm = assertCompilation(await measure('warmCSharpToPEWithoutCompilationCache', 5, () => compiler.compile(source, {...options, useCompilationCache: false})));
  report.warmRoslynPerformance = warm.performance ?? null;
  assertCompilation(await compiler.compile(source, options));
  const cached = assertCompilation(await measure('exactRepeatedCSharpCompilationCache', 10, () => compiler.compile(source, options)));
  report.cachedRoslynPerformance = cached.performance ?? null;
  const changed = assertCompilation(await measure('changedSourceCSharpToPE', 1, () => compiler.compile(source.replace('a + b', 'a + b + 1'), options)));
  assert.notDeepEqual(changed.pe, cold.pe);
  report.changedRoslynPerformance = changed.performance ?? null;
  if (typeof compiler.emitWasm === 'function') {
    await compiler.emitWasm(cold);
    const cachedEmission = await measure('publicRepeatedEmitWasmCache', 10, () => compiler.emitWasm(cold));
    assert.equal(WebAssembly.validate(cachedEmission.bytes), true);
    report.publicEmissionPerformance = cachedEmission.performance ?? cachedEmission.timings ?? null;
  }
  if (typeof compiler.compileToWasm === 'function') {
    const pipelineOptions = {...options, assemblyName: 'NativeBenchmarkPipeline'};
    const first = await measure('publicCSharpToWasmPipelineFirst', 1, () => compiler.compileToWasm(source, pipelineOptions));
    const pipeline = await measure('publicCSharpToWasmPipelineCached', 10, () => compiler.compileToWasm(source, pipelineOptions));
    const bytes = pipeline.bytes ?? pipeline.wasm?.bytes;
    assert.equal(WebAssembly.validate(bytes), true);
    report.publicPipelinePerformance = pipeline.performance ?? pipeline.timings ?? pipeline.wasm?.timings ?? null;
    report.publicPipelineFirstPerformance = first.performance ?? first.timings ?? first.wasm?.timings ?? null;
  }
  const method = emitted.manifest.methods.find(value => value.type === 'NativeBenchmark' && value.name === 'Sum');
  assert.ok(method);
  // Warm the same numerical workload before measuring; every result remains observable.
  for (let i = 0; i < 100; i++) assert.equal(program.invoke('NativeBenchmark::Sum', [100]), 333300n);
  const executions = 1000, expected = 333300n * BigInt(executions);
  await measure('nativeExport1000CallsEach100Iterations', 5, () => {
    const fuel = program.instance.exports.__fuel;
    if (fuel instanceof WebAssembly.Global) fuel.value = 1000000000n;
    let result = 0n;
    for (let i = 0; i < executions; i++) result += program.instance.exports[method.exportName](100);
    assert.equal(result, expected);
  });
  await measure('managedFacade1000CallsEach100Iterations', 5, () => {
    let result = 0n;
    for (let i = 0; i < executions; i++) result += program.invoke('NativeBenchmark::Sum', [100]);
    assert.equal(result, expected);
  });
  report.executionWorkload = {callsPerSample: executions, csharpLoopIterationsPerCall: 100, expectedAggregate: expected.toString(), resultType: 'System.Int64', moduleImports: WebAssembly.Module.imports(module)};
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = {name: error.name, message: error.message, stack: error.stack};
  process.exitCode = 1; console.error(error);
} finally {
  program?.dispose(); compiler?.dispose();
  await writeFile(new URL('../docs/direct-wasm-performance.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
}
