// Actual .NET WASM and browser-worker protocol test in Node worker_threads.
// This exercises src/worker.js unchanged; it does not certify a browser engine.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createRoslyn } from '../src/index.js';

import { NodeBrowserWorker } from './worker-adapter.mjs';

const started = performance.now();
const previousWorker = globalThis.Worker;
globalThis.Worker = NodeBrowserWorker;
const checks = [], events = [];
let compiler, fatal;
const check = async (name, action) => {
  const start = performance.now();
  try {
    const evidence = await action();
    checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - start), ...(evidence === undefined ? {} : { evidence }) });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, passed: false, milliseconds: Math.round(performance.now() - start), error: { name: error.name, code: error.code, message: error.message, details: error.details } });
    throw error;
  }
};
const succeed = compilation => {
  assert.equal(compilation.success, true, JSON.stringify(compilation.diagnostics || compilation.error));
  assert.ok(compilation.pe instanceof Uint8Array && compilation.pe.length > 512);
  return compilation;
};
const watchdog = setTimeout(() => {
  for (const worker of NodeBrowserWorker.instances) worker.terminate();
  console.error('Worker verification exceeded its 180-second harness limit.');
  process.exitCode = 1;
}, 180000);
try {
  await check('Default worker startup loads actual .NET WebAssembly and Roslyn', async () => {
    compiler = await createRoslyn({
      baseUrl: new URL('../dist/', import.meta.url).href,
      startupTimeoutMs: 90000,
      timeoutMs: 30000,
      onEvent: event => events.push(event),
    });
    assert.equal(NodeBrowserWorker.instances.length, 1);
    assert.ok(compiler.info.roslynVersion);
    assert.ok(compiler.info.referenceCount > 50);
    assert.ok(events.some(event => event.stage === 'ready'));
    return compiler.info;
  });
  let arithmetic;
  await check('C# compilation returns PE and portable PDB through the worker', async () => {
    arithmetic = succeed(await compiler.compile('int total = 0; for (int i = 0; i < 7; i++) total += i * 2; System.Console.WriteLine(total); return 7;', { includeInspection: true }));
    assert.ok(arithmetic.pdb instanceof Uint8Array && arithmetic.pdb.length > 100);
    return { peBytes: arithmetic.pe.length, pdbBytes: arithmetic.pdb.length };
  });
  await check('Emitted MSIL executes in the worker .NET WASM runtime', async () => {
    const result = await compiler.run(arithmetic);
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.backend, 'wasm');
    assert.equal(result.stdout.trim(), '42');
    assert.equal(result.exitCode, 7);
    return { backend: result.backend, stdout: result.stdout, exitCode: result.exitCode };
  });
  await check('MSIL-to-JavaScript backend executes inside the same worker protocol', async () => {
    const result = await compiler.run(arithmetic, { backend: 'javascript' });
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.backend, 'javascript');
    assert.equal(result.stdout.trim(), '42');
    assert.equal(result.exitCode, 7);
    assert.ok(NodeBrowserWorker.instances[0].sent.some(entry => entry.method === '$runJS'));
    return { backend: result.backend, stdout: result.stdout, exitCode: result.exitCode };
  });
  await check('Asynchronous C# Main yields and resumes without blocking the worker', async () => {
    const assembly = succeed(await compiler.compile('using System; using System.Threading.Tasks; await Task.Yield(); Console.WriteLine("async-worker"); return 9;'));
    const result = await compiler.run(assembly, { timeoutMs: 5000 });
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.stdout.trim(), 'async-worker');
    assert.equal(result.exitCode, 9);
    return { stdout: result.stdout, exitCode: result.exitCode };
  });
  await check('Roslyn diagnostics preserve source identity and position across messages', async () => {
    const result = await compiler.compile([{ path: 'WorkerSyntax.cs', text: 'class Broken { static void Main() { int value = ; } }' }]);
    assert.equal(result.success, false);
    const error = result.diagnostics.find(diagnostic => diagnostic.severity === 'error');
    assert.ok(error && /^CS\d+$/.test(error.id));
    assert.ok(error.path.endsWith('WorkerSyntax.cs'));
    assert.ok(error.startLine >= 1 && error.startColumn > 1);
    return error;
  });
  await check('Invalid DLL references and runtime assemblies reject with structured errors', async () => {
    const errors = [];
    for (const method of ['addReference', 'addAssembly']) {
      await assert.rejects(() => compiler[method]('Invalid.dll', new Uint8Array([1, 2, 3, 4])), error => {
        assert.equal(error.code, 'MANAGED_ERROR');
        assert.equal(error.details?.success, false);
        assert.ok(error.details?.error?.message);
        errors.push({ method, code: error.code, managedType: error.details.error.type });
        return true;
      });
    }
    await assert.rejects(() => compiler.inspect(new Uint8Array([1, 2, 3, 4])), error => error.code === 'MANAGED_ERROR');
    return errors;
  });
  await check('Official Newtonsoft.Json NuGet DLL compiles and executes in the worker', async () => {
    const bytes = new Uint8Array(await readFile(new URL('../tests/fixtures/newtonsoft.json.13.0.3.nupkg', import.meta.url)));
    const pkg = await compiler.importPackage(bytes, { targetFramework: 'net10.0' });
    assert.equal(pkg.id, 'Newtonsoft.Json');
    assert.equal(pkg.version, '13.0.3');
    const assembly = succeed(await compiler.compile('using Newtonsoft.Json; System.Console.WriteLine(JsonConvert.SerializeObject(new { Name = "worker", Value = 42 }));'));
    const result = await compiler.run(assembly, { timeoutMs: 10000 });
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.deepEqual(JSON.parse(result.stdout.trim()), { Name: 'worker', Value: 42 });
    return { package: `${pkg.id} ${pkg.version}`, assembly: pkg.runtimeAssets[0].path, stdout: result.stdout };
  });
  await check('Managed execution exceptions retain their error type and message', async () => {
    const assembly = succeed(await compiler.compile('throw new System.InvalidOperationException("worker-failure");'));
    const result = await compiler.run(assembly);
    assert.equal(result.success, false);
    assert.match(result.error.type, /InvalidOperationException/);
    assert.equal(result.error.message, 'worker-failure');
    return result.error;
  });
  await check('Worker preserves Int64 arguments and results as BigInt', async () => {
    const c = succeed(await compiler.compile('public static class LongApi{public static long Echo(long value)=>value;}', {outputKind:'library'}));
    const value = 9007199254740993n;
    const result = await compiler.invoke(c.assemblyId, 'LongApi', 'Echo', [value]);
    assert.equal(result.success, true, JSON.stringify(result.error));
    assert.equal(result.result, value);
    return {value: result.result.toString(), jsType: typeof result.result};
  });
  await check('Timeout terminates actual runaway C# code in its worker', async () => {
    const assembly = succeed(await compiler.compile('while (true) { }'));
    const start = performance.now();
    await assert.rejects(() => compiler.run(assembly, { timeoutMs: 100 }), error => error.code === 'TIMEOUT');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 3000, `Worker termination took ${elapsed} ms`);
    assert.equal(compiler.disposed, true);
    assert.equal(NodeBrowserWorker.instances[0].closed, true);
    await NodeBrowserWorker.instances[0].termination;
    return { requestedTimeoutMs: 100, observedMilliseconds: Math.round(elapsed), workerExitCode: NodeBrowserWorker.instances[0].exitCode };
  });
  await check('Calls after worker termination reject as disposed', async () => {
    await assert.rejects(() => compiler.compile('System.Console.WriteLine(1);'), error => error.code === 'DISPOSED');
    compiler.dispose();
    await assert.rejects(() => compiler.references(), error => error.code === 'DISPOSED');
    return { disposed: compiler.disposed };
  });
} catch (error) {
  fatal = error;
  process.exitCode = 1;
  console.error(error);
} finally {
  clearTimeout(watchdog);
  compiler?.dispose();
  for (const worker of NodeBrowserWorker.instances) worker.terminate();
  await Promise.all(NodeBrowserWorker.instances.map(worker => worker.termination));
  if (previousWorker === undefined) delete globalThis.Worker;
  else globalThis.Worker = previousWorker;
  const report = {
    validatedAt: new Date().toISOString(),
    passed: !fatal,
    runtime: 'Actual .NET WebAssembly running in Node worker_threads',
    protocol: 'Unmodified src/worker.js with scripts/node-worker.mjs browser-worker adapter',
    browserEngineValidated: false,
    elapsedMilliseconds: Math.round(performance.now() - started),
    checks,
    workerMessages: NodeBrowserWorker.instances.map(worker => ({ sent: worker.sent, received: worker.received })),
    boundary: 'This validates actual WASM execution, worker message serialization, JavaScript backend dispatch, and termination. Browser engine loading, CSP, and visual UI remain separate checks.',
  };
  await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
  await writeFile(new URL('../docs/worker-verification.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(`${checks.filter(check => check.passed).length}/${checks.length} worker checks passed.`);
}
