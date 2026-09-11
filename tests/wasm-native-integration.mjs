// Real Roslyn in .NET WASM, unchanged browser Worker protocol, and emitted native Wasm.
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/browser.js';
import {loadWasm} from '../src/wasm/index.js';
import {NodeBrowserWorker} from '../scripts/worker-adapter.mjs';

const previousWorker = globalThis.Worker;
globalThis.Worker = NodeBrowserWorker;
const checks = [];
let compiler, fatal;
async function check(name, action) {
  const start = performance.now();
  try {
    const evidence = await action();
    checks.push({name, passed: true, milliseconds: performance.now() - start, ...(evidence === undefined ? {} : {evidence})});
    console.log('PASS', name);
  } catch (error) {
    checks.push({name, passed: false, milliseconds: performance.now() - start, error: {name: error.name, code: error.code, message: error.message}});
    throw error;
  }
}
const source = `using System;
public static class NativeApi {
  public static int Add(int a, int b) => a + b;
  public static long LongAdd(long a, long b) => a + b;
  public static int Loop(int count) { int total = 0; for (int i = 0; i < count; i++) total += i * (i + 1); return total; }
  public static int Fibonacci(int n) => n < 2 ? n : Fibonacci(n - 1) + Fibonacci(n - 2);
  public static int Main(string[] args) { Console.WriteLine("Direct WebAssembly"); Console.WriteLine(Loop(20)); Console.WriteLine(Fibonacci(12)); if (args.Length > 0) Console.WriteLine(args[0]); return 7; }
}`;
const succeed = result => {assert.equal(result.success, true, JSON.stringify(result.error ?? result.diagnostics)); return result;};
const watchdog = setTimeout(() => {
  for (const worker of NodeBrowserWorker.instances) worker.terminate();
  console.error('Direct-Wasm integration exceeded the 180-second harness limit.');
  process.exitCode = 1;
}, 180000);
try {
  await check('Start actual .NET WebAssembly and Roslyn through the browser Worker protocol', async () => {
    compiler = await createRoslyn({baseUrl: new URL('../dist/', import.meta.url).href, startupTimeoutMs: 90000});
    assert.match(compiler.info.runtimeVersion, /^10\./);
    assert.match(compiler.info.roslynVersion, /^5\./);
    assert.ok(compiler.info.referenceCount >= 160);
    return compiler.info;
  });
  let compiled;
  await check('One-call C# → PE/MSIL → direct native Wasm returns both binary formats', async () => {
    compiled = succeed(await compiler.compileToWasm(source, {assemblyName: 'NativeApi'}));
    assert.equal(compiled.format, 'wasm');
    assert.ok(compiled.bytes instanceof Uint8Array);
    assert.deepEqual([...compiled.bytes.subarray(0, 4)], [0, 97, 115, 109]);
    assert.equal(WebAssembly.validate(compiled.bytes), true);
    assert.equal(Buffer.from(compiled.assembly.pe.subarray(0, 2)).toString(), 'MZ');
    assert.ok(compiled.timings.csharpMs >= 0);
    assert.ok(compiled.timings.inspectionMs >= 0);
    return {peBytes: compiled.assembly.pe.length, wasmBytes: compiled.bytes.length, timings: compiled.timings};
  });
  await check('Returned Wasm artifact executes with arguments and Console inside its Worker', async () => {
    const result = succeed(await compiler.run(compiled, {args: ['worker']}));
    assert.equal(result.backend, 'native-wasm');
    assert.equal(result.stdout, 'Direct WebAssembly\n2660\n144\nworker\n');
    assert.equal(result.exitCode, 7);
    return {backend: result.backend, stdout: result.stdout, exitCode: result.exitCode};
  });
  await check('Existing PE can emit direct Wasm and execute without C# recompilation', async () => {
    const artifact = succeed(await compiler.emitWasm(compiled.assembly));
    assert.equal(WebAssembly.validate(artifact.bytes), true);
    const result = succeed(await compiler.run(compiled.assembly, {backend: 'native-wasm', args: ['PE']}));
    assert.equal(result.stdout, 'Direct WebAssembly\n2660\n144\nPE\n');
    assert.equal(result.exitCode, 7);
    return {wasmBytes: artifact.bytes.length, cache: artifact.cache};
  });
  await check('Pure numerical export instantiates without imports and preserves 64-bit arithmetic', async () => {
    const artifact = succeed(await compiler.emitWasm(compiled.assembly, {exports: ['LongAdd']}));
    const module = await WebAssembly.compile(artifact.bytes);
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const instance = await WebAssembly.instantiate(module, {});
    const method = artifact.manifest.methods.find(method => method.name === 'LongAdd');
    assert.equal(instance.exports[method.exportName](9007199254740993n, 2n), 9007199254740995n);
    const portable = await loadWasm(artifact.bytes);
    assert.equal(portable.invoke('NativeApi::LongAdd', [9007199254740993n, 2n]), 9007199254740995n);
    portable.dispose();
    return {bytes: artifact.bytes.length, imports: 0, exactResult: '9007199254740995'};
  });
  await check('Repeated identical source uses compiler and native emission caches', async () => {
    const again = succeed(await compiler.compileToWasm(source, {assemblyName: 'NativeApi'}));
    assert.deepEqual(again.bytes, compiled.bytes);
    assert.equal(again.cache.emitHit, true);
    assert.notEqual(again.assembly.assemblyId, compiled.assembly.assemblyId);
    return {cache: again.cache, compilationPerformance: again.assembly.performance};
  });
  await check('Changed C# invalidates caches and changes native output', async () => {
    const changed = succeed(await compiler.compileToWasm(source.replace('"Direct WebAssembly"', '"Changed native code"'), {assemblyName: 'NativeApi'}));
    assert.equal(changed.cache.emitHit, false);
    assert.notDeepEqual(changed.bytes, compiled.bytes);
    assert.match(succeed(await compiler.run(changed)).stdout, /^Changed native code\n/);
    return {cache: changed.cache};
  });
  await check('Real compiled DLL dependencies link into native Wasm through addDll', async () => {
    const dependency = succeed(await compiler.compile('namespace NativeDependency; public static class Calc { public static long Twice(long value) => value * 2; }', {outputKind: 'library', assemblyName: 'NativeDependency', optimization: 'release', emitPdb: false}));
    await compiler.addDll('NativeDependency.dll', dependency.pe);
    const consumer = succeed(await compiler.compileToWasm('System.Console.WriteLine(NativeDependency.Calc.Twice(9007199254740993L)); return 11;', {assemblyName: 'NativeConsumer'}));
    const result = succeed(await compiler.run(consumer));
    assert.equal(result.stdout, '18014398509481986\n');
    assert.equal(result.exitCode, 11);
    return {peBytes: dependency.pe.length, stdout: result.stdout};
  });
  await check('Compiler diagnostics return before native emission for invalid C#', async () => {
    const invalid = await compiler.compileToWasm('int value = "invalid";');
    assert.equal(invalid.success, false);
    assert.ok((invalid.diagnostics ?? invalid.assembly?.diagnostics).some(item => item.id === 'CS0029'));
  });
  await check('Native execution reports checked overflow with its managed exception type', async () => {
    const artifact = succeed(await compiler.compileToWasm('int x = int.MaxValue; return checked(x + 1);', {assemblyName: 'NativeOverflow'}));
    const result = await compiler.run(artifact);
    assert.equal(result.success, false);
    assert.equal(result.error.type, 'System.OverflowException');
    return result.error;
  });
  await check('Native try/catch handles an exception thrown by a compiled callee', async () => {
    const artifact = succeed(await compiler.compileToWasm('using System; class Program { static int Add(int value) => checked(value + 1); public static int Main() { try { return Add(int.MaxValue); } catch (OverflowException) { Console.WriteLine("caught native overflow"); return 42; } } }', {assemblyName: 'NativeCatch'}));
    const result = succeed(await compiler.run(artifact));
    assert.equal(result.stdout, 'caught native overflow\n');
    assert.equal(result.exitCode, 42);
  });
  await check('Saved Wasm remains executable after its Roslyn Worker is disposed', async () => {
    const saved = compiled.bytes.slice();
    compiler.dispose();
    const program = await loadWasm(saved);
    const result = program.run(['portable']);
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.stdout, 'Direct WebAssembly\n2660\n144\nportable\n');
    assert.equal(result.exitCode, 7);
    program.dispose();
    return {roslynDisposed: compiler.disposed, backend: result.backend};
  });
} catch (error) {
  fatal = error; console.error(error); process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  compiler?.dispose();
  for (const worker of NodeBrowserWorker.instances) worker.terminate();
  await Promise.all(NodeBrowserWorker.instances.map(worker => worker.termination));
  if (previousWorker === undefined) delete globalThis.Worker; else globalThis.Worker = previousWorker;
  const report = {
    validatedAt: new Date().toISOString(), passed: !fatal,
    runtime: 'Actual .NET WebAssembly plus emitted direct WebAssembly in Node worker_threads',
    protocol: 'Unmodified browser Worker src/worker.js through the Node browser-worker adapter',
    browserEngineValidated: false,
    checks, passedChecks: checks.filter(check => check.passed).length, totalChecks: checks.length,
    nativeFixtureCases: JSON.parse(await readFile(new URL('./wasm-native-baseline.json', import.meta.url))).cases.length,
    note: 'The separate staged/deployed Chromium suite validates browser loading and interaction. Differential numeric/CLR-service tests execute genuine C# fixture PE/MSIL against native .NET expectations.',
  };
  await writeFile(new URL('../docs/direct-wasm-verification.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.passedChecks}/${checks.length} direct-Wasm API integration checks passed.`);
}
