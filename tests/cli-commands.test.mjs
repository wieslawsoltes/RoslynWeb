import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCommand, prepareCompiler } from '../src/cli/commands.mjs';
import { loadProject, writeVirtualFiles } from '../src/cli/projects.mjs';
import { runArtifact } from '../src/cli/artifact-runner.mjs';

async function directory(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'roslyn-cli-commands-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('reference DLLs and compiler extensions register execution and compilation images in order', async t => {
  const cwd = await directory(t), calls = [];
  await writeFile(join(cwd, 'Library.dll'), Uint8Array.of(77, 90, 1));
  await writeFile(join(cwd, 'Analyzer.dll'), Uint8Array.of(77, 90, 2));
  const compiler = Object.fromEntries(['loadCompilerReferences', 'loadTaskReferences', 'addDll', 'addAssembly', 'addCompilerExtension'].map(method => [method, async (...args) => { calls.push([method, ...args]); }]));
  await prepareCompiler(compiler, { compilerReferences: true, taskReferences: true, reference: ['Library.dll'], extension: ['Analyzer.dll'] }, { cwd });
  assert.deepEqual(calls.map(call => call[0]), ['loadCompilerReferences', 'loadTaskReferences', 'addDll', 'addAssembly', 'addCompilerExtension']);
  assert.deepEqual(calls[2].slice(1), ['Library.dll', Uint8Array.of(77, 90, 1)]);
  assert.deepEqual(calls[4].slice(1), ['Analyzer.dll', Uint8Array.of(77, 90, 2)]);
});

test('managed invoke preserves Int64 JSON arguments and exact overload/generic type selectors', async t => {
  const cwd = await directory(t), calls = [];
  await writeFile(join(cwd, 'Library.dll'), Uint8Array.of(77, 90, 3));
  const compiler = { async invoke(...args) { calls.push(args); return { success: true, result: 9007199254740995n }; } };
  const result = await executeCommand('invoke', ['Library.dll'], {
    type: 'Numbers', method: 'Add', arguments: '[{"$bigint":"9007199254740993"},2]',
    parameters: '["System.Int64","System.Int32"]', genericArguments: '["System.Int64"]', timeoutMs: 1234,
    runOptions: '{"checkOverflow":true}',
  }, { cwd, getCompiler: async () => compiler });
  assert.deepEqual(calls[0], ['TVoD', 'Numbers', 'Add', [9007199254740993n, 2], {
    checkOverflow: true, timeoutMs: 1234, parameterTypes: ['System.Int64', 'System.Int32'], genericArguments: ['System.Int64'],
  }]);
  assert.equal(result.output, '{"$bigint":"9007199254740995"}\n');
  assert.equal(result.exitCode, 0);
});

test('project artifacts reload transitive DLLs, NuGet assets and satellite assemblies before execution', async t => {
  const cwd = await directory(t), calls = [];
  const image = name => ({ success: true, assemblyName: name, pe: { $bytes: 'TVo=' } });
  const artifact = {
    success: true, compileResult: image('App'),
    projectReferences: [{ compileResult: image('First'), projectReferences: [{ compileResult: image('Second') }] }],
    packages: { compileAssets: [], runtimeAssets: [] },
    satelliteAssemblies: [{ path: 'pl/App.resources.dll', pe: { $bytes: 'TVoB' } }],
  };
  await writeFile(join(cwd, 'build.json'), JSON.stringify(artifact));
  const compiler = {
    async addDll(...args) { calls.push(['dll', ...args]); },
    async addAssembly(...args) { calls.push(['assembly', ...args]); },
    async loadPackages(...args) { calls.push(['packages', ...args]); },
    async run(...args) { calls.push(['run', ...args]); return { success: true, exitCode: 0, stdout: 'linked' }; },
  };
  const result = await executeCommand('run', ['build.json'], {}, { cwd, getCompiler: async () => compiler });
  assert.deepEqual(calls.map(call => call[0]), ['dll', 'dll', 'packages', 'assembly', 'run']);
  assert.equal(calls[0][1], 'Second.dll');
  assert.equal(calls[1][1], 'First.dll');
  assert.equal(calls[3][1], 'pl/App.resources.dll');
  assert.deepEqual(calls[4][1].pe, Uint8Array.of(77, 90));
  assert.equal(calls[4][2].backend, 'auto');
  assert.equal(result.output, 'linked');
});

test('source compilation merges explicit flags over JSON and writes requested binary/debug outputs', async t => {
  const cwd = await directory(t), calls = [];
  await writeFile(join(cwd, 'Main.cs'), 'class Main {}');
  const compiler = { async compile(sources, settings) { calls.push({ sources, settings }); return { success: true, pe: Uint8Array.of(77, 90), pdb: Uint8Array.of(66, 83), xmlDocumentation: '<doc/>' }; } };
  const result = await executeCommand('compile', ['Main.cs'], {
    output: 'output/Main.dll', pdb: 'output/Main.pdb', xml: 'output/Main.xml', name: 'ExplicitName', kind: 'library',
    nullable: 'enable', define: ['CLI'], noCache: true, options: '{"assemblyName":"JsonName","defines":["JSON"],"optimization":"debug"}',
  }, { cwd, getCompiler: async () => compiler });
  assert.equal(calls[0].settings.assemblyName, 'ExplicitName');
  assert.equal(calls[0].settings.outputKind, 'library');
  assert.equal(calls[0].settings.optimization, 'debug');
  assert.deepEqual(calls[0].settings.defines, ['JSON', 'CLI']);
  assert.equal(calls[0].settings.emitPdb, true);
  assert.equal(calls[0].settings.emitXmlDocumentation, true);
  assert.equal(calls[0].settings.useCompilationCache, false);
  assert.deepEqual(new Uint8Array(await readFile(join(cwd, 'output/Main.dll'))), Uint8Array.of(77, 90));
  assert.deepEqual(new Uint8Array(await readFile(join(cwd, 'output/Main.pdb'))), Uint8Array.of(66, 83));
  assert.equal(await readFile(join(cwd, 'output/Main.xml'), 'utf8'), '<doc/>');
  assert.equal(result.exitCode, 0);
});

test('output aliases and output/input collisions reject before compilation without modifying source', async t => {
  const cwd = await directory(t);
  await writeFile(join(cwd, 'Main.cs'), 'original source');
  await symlink(join(cwd, 'Main.cs'), join(cwd, 'source-alias.cs'));
  let starts = 0;
  const ctx = { cwd, getCompiler: async () => { starts++; throw new Error('compiler must not initialize'); } };
  for (const options of [{ output: 'Main.cs' }, { output: 'source-alias.cs' }, { output: 'result.dll', pdb: './result.dll' }, { output: 'result.dll', artifact: 'result.dll' }]) {
    await assert.rejects(executeCommand('compile', ['Main.cs'], options, ctx), { code: 'OUTPUT_PATH' });
  }
  assert.equal(starts, 0);
  assert.equal(await readFile(join(cwd, 'Main.cs'), 'utf8'), 'original source');
  await assert.rejects(readFile(join(cwd, 'result.dll')), { code: 'ENOENT' });
});

test('irrelevant compiler backend flags reject instead of being silently ignored', async t => {
  const cwd = await directory(t);
  let starts = 0;
  const ctx = { cwd, getCompiler: async () => { starts++; throw new Error('compiler must not initialize'); } };
  for (const options of [{ optimize: 'true' }, { wasmOptions: '{}' }, { javascriptOptions: '{}' }, { manifest: 'module.json' }]) {
    await assert.rejects(executeCommand('compile', ['Main.cs'], { target: 'il', ...options }, ctx), { code: 'CLI_USAGE' });
  }
  assert.equal(starts, 0);
});

test('JSON options reject transport values that cannot represent an options object', async t => {
  const cwd = await directory(t);
  await writeFile(join(cwd, 'Main.cs'), 'class Main {}');
  let calls = 0;
  const ctx = { cwd, getCompiler: async () => ({ compile() { calls++; throw new Error('invalid options must not compile'); } }) };
  for (const options of ['{"$map":[["optimization","debug"]]}', '{"$bytes":"","$type":"ArrayBuffer"}']) {
    await assert.rejects(executeCommand('compile', ['Main.cs'], { options }, ctx), { code: 'CLI_USAGE' });
  }
  assert.equal(calls, 0);
});

test('project mounting rejects escaping symlinks, cycles and resource-limit breaches', async t => {
  const cwd = await directory(t);
  await mkdir(join(cwd, 'project'));
  await writeFile(join(cwd, 'project/App.csproj'), '<Project/>');
  await writeFile(join(cwd, 'outside.cs'), 'outside');
  await symlink(join(cwd, 'outside.cs'), join(cwd, 'project/escape.cs'));
  await assert.rejects(loadProject('project/App.csproj', { cwd }), { code: 'PROJECT_ROOT' });
  await rm(join(cwd, 'project/escape.cs'));
  await symlink(join(cwd, 'project'), join(cwd, 'project/cycle'));
  await assert.rejects(loadProject('project/App.csproj', { cwd }), { code: 'PROJECT_ROOT' });
  await rm(join(cwd, 'project/cycle'));
  await assert.rejects(loadProject('project/App.csproj', { cwd, maxBytes: 1 }), { code: 'PROJECT_INPUT_LIMIT' });
  await writeFile(join(cwd, 'project/Program.cs'), 'class Program {}');
  const mounted = await loadProject('project/App.csproj', { cwd });
  assert.equal(mounted.projectPath, '/App.csproj');
  assert.equal(new TextDecoder().decode(mounted.files.get('/Program.cs')), 'class Program {}');
});

test('virtual file exports validate every path before writing and refuse existing symbolic links', async t => {
  const cwd = await directory(t);
  await mkdir(join(cwd, 'outside'));
  await mkdir(join(cwd, 'output'));
  await assert.rejects(writeVirtualFiles('output', { 'valid.txt': 'valid', '../outside/escaped.txt': 'escaped' }, { cwd }), { code: 'OUTPUT_PATH' });
  await assert.rejects(readFile(join(cwd, 'output/valid.txt')), { code: 'ENOENT' });
  await symlink(join(cwd, 'outside'), join(cwd, 'output/link'));
  await assert.rejects(writeVirtualFiles('output', { 'link/escaped.txt': 'escaped' }, { cwd }), { code: 'OUTPUT_PATH' });
  await assert.rejects(readFile(join(cwd, 'outside/escaped.txt')), { code: 'ENOENT' });
  await writeVirtualFiles('output', new Map([['/generated/value.bin', Uint8Array.of(1, 2)]]), { cwd });
  assert.deepEqual(new Uint8Array(await readFile(join(cwd, 'output/generated/value.bin'))), Uint8Array.of(1, 2));
});

test('standalone artifact execution honors timeout and abort without booting Roslyn', async t => {
  const cwd = await directory(t);
  const file = join(cwd, 'infinite.mjs');
  await writeFile(file, 'export function createAssembly(){return {run(){while(true){}}}}');
  await assert.rejects(runArtifact(file, {}, { kind: 'javascript', timeoutMs: 100 }), { code: 'TIMEOUT' });
  const controller = new AbortController();
  const pending = runArtifact(file, {}, { kind: 'javascript', signal: controller.signal, timeoutMs: 30000 });
  controller.abort(Object.assign(new Error('cancelled'), { code: 'ABORTED' }));
  await assert.rejects(pending, { code: 'ABORTED' });
});

test('standalone JavaScript method invocation preserves argument types and file snapshots on success and failure', async t => {
  const cwd = await directory(t), file = join(cwd, 'library.mjs');
  await writeFile(file, `export function createAssembly(options) {
    return {
      run() { throw new Error('library has no entry point'); },
      invoke(selector, args) {
        if (selector.declaringType !== 'Counter' || selector.name !== 'Add' || selector.parameters[0] !== 'System.Int64') throw new Error('selector mismatch');
        options.output('invoked', {newline:true});
        options.virtualFileSystem.writeFile('result.txt', 'saved before returning');
        if (args[1]) throw Object.assign(new Error('managed failure'), {code:'EXPECTED_FAILURE'});
        return args[0] + 2n;
      },
    };
  }`);
  const options = { method: 'Add', type: 'Counter', parameterTypes: ['System.Int64', 'System.Boolean'], arguments: [9007199254740993n, false], captureVirtualFiles: true };
  const success = await runArtifact(file, options, { kind: 'javascript' });
  assert.equal(success.success, true);
  assert.equal(success.result, 9007199254740995n);
  assert.equal(success.exitCode, 0);
  assert.equal(success.stdout, 'invoked\n');
  assert.equal(new TextDecoder().decode(success.virtualFiles['/result.txt']), 'saved before returning');
  const failure = await runArtifact(file, { ...options, arguments: [1n, true] }, { kind: 'javascript' });
  assert.equal(failure.success, false);
  assert.equal(failure.error.code, 'EXPECTED_FAILURE');
  assert.equal(failure.stdout, 'invoked\n');
  assert.equal(new TextDecoder().decode(failure.virtualFiles['/result.txt']), 'saved before returning');
});
