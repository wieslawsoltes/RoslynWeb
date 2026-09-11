// Exercise new compiler capabilities through real Roslyn WASM and Worker transport.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {createRoslyn} from '../src/browser.js';
import {loadWasm} from '../src/wasm/index.js';
import {NodeBrowserWorker} from '../scripts/worker-adapter.mjs';
import {compilerExamples} from '../demo/compiler-examples.js';

const originalWorker = globalThis.Worker;
globalThis.Worker = NodeBrowserWorker;
const checks = [];
let compiler;
const ok = result => {assert.equal(result.success, true, JSON.stringify({error:result.error,diagnostics:result.diagnostics})); return result;};
async function check(name, action) {
  const start = performance.now();
  const evidence = await action();
  checks.push({name, passed:true, milliseconds:performance.now()-start, evidence});
  console.log('PASS', name);
}
const timeout = setTimeout(() => {
  for (const worker of NodeBrowserWorker.instances) worker.terminate();
  process.exitCode = 1;
  console.error('Compiler v7 integration exceeded 180 seconds.');
}, 180000);
const modes = [['javascript',false], ['javascript','blocks'], ['javascript',true], ['native-wasm',false], ['native-wasm',true]];
async function compile(source, backend, optimize, extra = {}) {
  return ok(await compiler[backend === 'javascript' ? 'compileToJavaScript' : 'compileToWasm'](source, {
    ...extra,
    ...(backend === 'javascript' ? {javascript:{optimize,runtimeImport:new URL('../src/il/runtime.mjs',import.meta.url).href}} : {wasm:{optimize}})
  }));
}
try {
  await check('Initialize Roslyn and compile genuine baseline assemblies in its Worker', async () => {
    compiler = await createRoslyn({baseUrl:new URL('../dist/',import.meta.url).href,startupTimeoutMs:90000});
    assert.match(compiler.info.roslynVersion,/^5\./);
    return compiler.info;
  });
  for (const example of compilerExamples) await check(`${example.name}: every compiler mode matches .NET WASM`, async () => {
    const assembly = ok(await compiler.compile(example.source, {optimization:'release',emitPdb:false}));
    const expected = ok(await compiler.run(assembly,{backend:'wasm'}));
    const results = [];
    for (const [backend,optimize] of modes) {
      const artifact = await compile(example.source,backend,optimize);
      const actual = ok(await compiler.run(artifact));
      assert.equal(actual.stdout,expected.stdout,`${backend}, optimize=${optimize}`);
      assert.equal(actual.exitCode,expected.exitCode);
      if (example === compilerExamples[0] && backend === 'javascript' && optimize === true) assert(artifact.optimization.numericMethods >= 3);
      results.push({backend,optimize,optimization:artifact.optimization});
    }
    return {stdout:expected.stdout,results};
  });
  await check('Native numeric classification and clamp emit an import-free standalone Wasm module', async () => {
    const source = `public static class NumericV7 {
      public static int Classify(double value) => (double.IsFinite(value)?1:0)+(double.IsSubnormal(value)?2:0)+(double.IsNegative(value)?4:0);
      public static long Clamp(long value,long min,long max) => System.Math.Clamp(value,min,max);
      public static int Sign(double value) => System.Math.Sign(value);
    }`;
    const artifact = await compile(source,'native-wasm',true,{outputKind:'library'});
    const program = await loadWasm(artifact.bytes);
    try {
      assert.deepEqual(WebAssembly.Module.imports(program.module),[]);
      assert.equal(program.invoke('NumericV7::Classify',[-Number.MIN_VALUE]),7);
      assert.equal(program.invoke('NumericV7::Classify',[NaN]),0);
      assert.equal(program.invoke('NumericV7::Clamp',[9223372036854775807n,-10n,10n]),10n);
      assert.equal(program.invoke('NumericV7::Sign',[-0]),0);
      assert.throws(()=>program.invoke('NumericV7::Clamp',[0n,2n,1n]),error=>error.$type === 'System.ArgumentException');
      assert.throws(()=>program.invoke('NumericV7::Sign',[NaN]),error=>error.$type === 'System.ArithmeticException');
      assert.equal(program.invoke('NumericV7::Sign',[42]),1);
      return {imports:0,optimization:artifact.optimization,bytes:artifact.bytes.length};
    } finally {program.dispose();}
  });
  await check('Numeric intrinsic exceptions remain catchable and execute finally on both backends', async () => {
    const source = `using System; public static class Program { public static void Main() {
      try { Console.WriteLine(Math.Clamp(0,2,1)); } catch(ArgumentException) { Console.WriteLine("clamp"); } finally {Console.WriteLine("finally");}
      try { Console.WriteLine(Math.Sign(double.NaN)); } catch(ArithmeticException) { Console.WriteLine("sign"); }
    } }`;
    const reference = ok(await compiler.run(ok(await compiler.compile(source)),{backend:'wasm'}));
    for (const [backend,optimize] of modes) assert.equal(ok(await compiler.run(await compile(source,backend,optimize))).stdout,reference.stdout);
    return {stdout:reference.stdout,modes:modes.length};
  });
  await check('Concurrent PE emission retains cache isolation and produces executable artifacts', async () => {
    const assembly = ok(await compiler.compile(compilerExamples[0].source,{assemblyName:'ConcurrentV7',optimization:'release',emitPdb:false}));
    for (const method of ['emitJavaScript','emitWasm']) {
      const outputs = await Promise.all(Array.from({length:4},()=>compiler[method](assembly)));
      assert(outputs.slice(1).every(result=>result.cache.emitHit));
      outputs[0].analysis.supported = false;
      assert.equal(outputs[1].analysis.supported,true);
      for (const artifact of outputs.slice(1)) assert.match(ok(await compiler.run(artifact)).stdout,/333833500/);
    }
    return {concurrentPerBackend:4,isolated:true};
  });
} catch(error) {
  checks.push({name:'Failure',passed:false,error:{message:error.message,stack:error.stack}});
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  compiler?.dispose();
  for (const worker of NodeBrowserWorker.instances) worker.terminate();
  await Promise.all(NodeBrowserWorker.instances.map(worker=>worker.termination));
  if (originalWorker === undefined) delete globalThis.Worker; else globalThis.Worker = originalWorker;
  await writeFile(new URL('../docs/compiler-v7-worker-verification.json',import.meta.url),JSON.stringify({testedAt:new Date().toISOString(),checks,passed:checks.every(check=>check.passed)},null,2)+'\n');
  console.log(`${checks.filter(check=>check.passed).length} compiler v7 Worker checks passed`);
}
