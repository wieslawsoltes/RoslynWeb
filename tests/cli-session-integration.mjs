import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRoslyn } from '../src/node/index.js';
import { createApiSession } from '../src/cli/session.mjs';
import { decodeJson } from '../src/cli/codec.mjs';

const checks = [];
let compiler, starts = 0;
const session = createApiSession({ getCompiler: async () => { starts++; return compiler = await createRoslyn({ startupTimeoutMs: 90000 }); } });
const watchdog = setTimeout(() => { compiler?.dispose(); process.exitCode = 1; console.error('CLI session integration exceeded 120 seconds'); }, 120000);
const dispatch = async request => {
  const envelope = await session.dispatch(request);
  assert.equal(envelope.success, true, JSON.stringify(envelope.error));
  return decodeJson(envelope.result);
};
async function check(name, action) {
  const start = performance.now();
  const evidence = await action();
  checks.push({ name, passed: true, milliseconds: performance.now() - start, evidence });
  console.log('PASS', name);
}

try {
  await check('JSON API boots Roslyn once, emits PE/PDB, and runs result references on all four backends', async () => {
    const info = await dispatch({ id: 'info', method: 'info' });
    assert.match(info.roslynVersion, /^5\./);
    const compiled = await dispatch({ id: 'program', method: 'compile', args: ['System.Console.WriteLine("session:" + (6 * 7)); return 2;', { assemblyName: 'CliSessionProgram' }] });
    assert(compiled.pe.byteLength > 512);
    assert(compiled.pdb.byteLength > 100);
    const outputs = [];
    for (const backend of ['wasm', 'javascript', 'native-wasm', 'auto']) {
      const result = await dispatch({ id: `run-${backend}`, method: 'run', args: [{ $ref: 'program' }, { backend }] });
      assert.equal(result.stdout.trim(), 'session:42');
      assert.equal(result.exitCode, 2);
      outputs.push({ requested: backend, selected: result.backend, exitCode: result.exitCode });
    }
    assert.equal(starts, 1);
    return { info, peBytes: compiled.pe.byteLength, pdbBytes: compiled.pdb.byteLength, outputs };
  });

  await check('Compiled function target invocation and managed object references retain exact Int64 values', async () => {
    const fn = await dispatch({ id: 'increment', method: 'compileFunction', args: [{ returnType: 'long', parameters: [{ name: 'value', type: 'long' }], body: 'return value + 2;' }] });
    assert.equal('invoke' in fn, false);
    const invoked = await dispatch({ id: 'sum', target: 'increment', method: 'invoke', args: [{ $bigint: '9007199254740993' }] });
    assert.equal(invoked.result, 9007199254740995n);
    await dispatch({ id: 'library', method: 'compile', args: ['public class Counter { public long Value { get; set; } public Counter(long value) { Value=value; } public long Add(long value) => Value += value; }', { outputKind: 'library' }] });
    await dispatch({ id: 'counter', method: 'createObject', args: [{ $ref: 'library.assemblyId' }, 'Counter', [{ $bigint: '9007199254740993' }]] });
    assert.equal(await dispatch({ id: 'value', method: 'getProperty', args: [{ $ref: 'counter' }, 'Value'] }), 9007199254740993n);
    assert.equal((await dispatch({ id: 'added', method: 'invokeObject', args: [{ $ref: 'counter' }, 'Add', [{ $bigint: '4' }]] })).result, 9007199254740997n);
    await dispatch({ id: 'release', method: 'releaseObject', args: [{ $ref: 'counter' }] });
    return { compiledFunctionResult: String(invoked.result), managedObjectValue: '9007199254740997' };
  });

  await check('Workspace files, byte markers and API references persist through multiple JSON requests', async () => {
    await dispatch({ id: 'workspace', method: 'createWorkspace', args: [{ files: { 'input.txt': 'persistent CLI workspace' } }] });
    await dispatch({ id: 'files-program', method: 'compile', args: ['using System.IO; File.WriteAllText("output.txt", File.ReadAllText("input.txt").ToUpperInvariant());'] });
    await dispatch({ id: 'files-run', method: 'run', args: [{ $ref: 'files-program.pe' }, { workspaceId: { $ref: 'workspace.workspaceId' } }] });
    const files = await dispatch({ id: 'files-read', method: 'readWorkspace', args: [{ $ref: 'workspace.workspaceId' }, ['output.txt']] });
    assert.equal(new TextDecoder().decode(files.files['output.txt']), 'PERSISTENT CLI WORKSPACE');
    await dispatch({ id: 'files-write', method: 'writeWorkspace', args: [{ $ref: 'workspace.workspaceId' }, { 'binary.bin': { $bytes: 'AAH/' } }] });
    const binary = await dispatch({ id: 'binary-read', method: 'readWorkspace', args: [{ $ref: 'workspace.workspaceId' }, ['binary.bin']] });
    assert.deepEqual(binary.files['binary.bin'], Uint8Array.of(0, 1, 255));
    await dispatch({ id: 'files-dispose', method: 'disposeWorkspace', args: [{ $ref: 'workspace.workspaceId' }] });
    return { text: 'PERSISTENT CLI WORKSPACE', binaryBytes: 3 };
  });

  await check('Compiler diagnostics and malformed requests remain recoverable within the same session', async () => {
    const failed = await session.dispatch({ id: 'broken', method: 'compile', args: ['this is not C#;'] });
    assert.equal(failed.success, false);
    assert.equal(failed.error.code, 'COMPILE_FAILED');
    assert(failed.error.diagnostics.length > 0);
    const malformed = await session.dispatch({ method: 'constructor' });
    assert.equal(malformed.error.code, 'UNKNOWN_METHOD');
    assert.equal((await dispatch({ id: 'recovered', method: 'evaluate', args: ['21 * 2', { returnType: 'int' }] })).result, 42);
    assert.equal(starts, 1);
    return { diagnosticIds: failed.error.diagnostics.map(item => item.id), recoveredResult: 42, starts };
  });

  await check('Runaway managed execution times out without replacing the persistent compiler', async () => {
    await dispatch({ id: 'infinite', method: 'compile', args: ['while (true) { }'] });
    const result = await session.dispatch({ id: 'timeout', method: 'run', args: [{ $ref: 'infinite' }, { timeoutMs: 100 }] });
    assert.equal(result.error.code, 'TIMEOUT');
    assert.equal((await session.dispatch({ method: 'references' })).error.code, 'DISPOSED');
    assert.equal((await dispatch({ method: 'disposed' })), true);
    assert.equal(starts, 1);
    await dispatch({ method: 'dispose' });
    assert.equal(session.resultCount, 0);
    return { timeoutCode: result.error.code, disposed: session.disposed, compilerInstances: starts };
  });
} catch (error) {
  checks.push({ name: 'Failure', passed: false, error: { message: error.message, stack: error.stack, code: error.code } });
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  await session.dispose();
  await writeFile(new URL('../docs/cli-session-verification.json', import.meta.url), JSON.stringify({ testedAt: new Date().toISOString(), runtime: process.version, passed: checks.every(check => check.passed), checks }, null, 2) + '\n');
  console.log(`${checks.filter(check => check.passed).length} CLI session integration checks passed`);
}
