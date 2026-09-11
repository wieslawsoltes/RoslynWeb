// Public executable integration: every compiler invocation is a separate real
// Node subprocess using the production Worker host and bundled Roslyn WASM.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = join(root, 'bin/roslynweb.mjs');
const temporary = await mkdtemp(join(tmpdir(), 'roslynweb-cli-'));
const checks = [], children = new Set();
const started = performance.now();
const watch = setTimeout(() => {
  for (const child of children) child.kill('SIGKILL');
  console.error('CLI integration exceeded its 12-minute harness limit.');
  process.exitCode = 1;
}, 720000);
const json = value => JSON.stringify(value);
const source = 'System.Console.WriteLine("cli:42"); return 0;';
const librarySource = 'public static class WideApi { public static long Echo(long value) => value; public static int Add(int a, int b) => a + b; }';
async function put(name, value) {
  const path = join(temporary, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === 'string' || value instanceof Uint8Array ? value : json(value));
  return path;
}
async function processRun(command, args, { input = '', cwd = temporary, timeoutMs = 120000, env = {}, signalAfter, signal = 'SIGINT' } = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '', expired = false;
  const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeoutMs);
  const signalTimer = signalAfter === undefined ? null : setTimeout(() => child.kill(signal), signalAfter);
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  try {
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(expired, false, `Subprocess timed out: ${args.join(' ')}\n${stderr.slice(-3000)}`);
    return result;
  } finally { clearTimeout(timer); clearTimeout(signalTimer); children.delete(child); }
}
const cli = (args, options) => processRun(process.execPath, [binary, ...args], options);
function code(result, expected = 0) {
  assert.equal(result.code, expected, `Exit ${result.code}, expected ${expected}\nstdout: ${result.stdout.slice(-2500)}\nstderr: ${result.stderr.slice(-2500)}`);
  return result;
}
function parsed(result, expected = 0) {
  code(result, expected);
  try { return JSON.parse(result.stdout); }
  catch (error) { throw new Error(`stdout must contain exactly one JSON value: ${result.stdout.slice(0, 1000)}`, { cause: error }); }
}
async function check(name, action) {
  const start = performance.now();
  try {
    const evidence = await action();
    checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - start), ...(evidence === undefined ? {} : { evidence }) });
    console.log('PASS', name);
  } catch (error) {
    checks.push({ name, passed: false, milliseconds: Math.round(performance.now() - start), error: { message: error.message, stack: error.stack } });
    console.error('FAIL', name, error.message);
    throw error;
  }
}
async function session(requests, extra = []) {
  const response = code(await cli(['session', ...extra], { input: requests.map(json).join('\n') + '\n' }));
  const lines = response.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(lines.length, requests.length, response.stdout.slice(-2500));
  for (let index = 0; index < requests.length; index++) {
    assert.equal(lines[index].id, requests[index].id);
    assert.equal(lines[index].success, true, json(lines[index]));
  }
  return Object.fromEntries(lines.map(line => [line.id, line.result]));
}
const ref = value => ({ $ref: value });
const bytesFile = value => ({ $file: value });
let feed;
try {
  await put('Program.cs', source);
  await put('Library.cs', librarySource);
  await put('compile-library.json', { outputKind: 'library', assemblyName: 'WideLibrary', emitPdb: false });
  await check('Help, version and malformed options work without loading runtime assets', async () => {
    const help = code(await cli(['--help', '--runtime', 'missing-runtime']));
    assert.match(help.stdout, /compile/);
    assert.match(help.stdout, /session/);
    const version = code(await cli(['--version', '--runtime', 'missing-runtime']));
    assert.match(version.stdout, /\d+\.\d+\.\d+/);
    const usage = await cli(['compile', '--not-a-real-option', '--json']);
    code(usage, 2);
    assert.match(usage.stdout + usage.stderr, /unknown|unrecognized|option/i);
  });
  await check('Compiler information loads actual Roslyn and the complete bundled reference set', async () => {
    const result = parsed(await cli(['info', '--json']));
    const info = result.info || result.result || result;
    assert.match(info.roslynVersion, /^5\./);
    assert.match(info.runtimeVersion, /^10\./);
    assert(info.referenceCount >= 160);
    return info;
  });
  await check('C# compiles to genuine PE, portable PDB and XML documentation', async () => {
    const result = parsed(await cli(['compile', 'Program.cs', '--output', 'program.dll', '--pdb', 'program.pdb', '--xml', 'program.xml', '--artifact', 'program.json', '--json']));
    assert.notEqual(result.success, false, json(result));
    assert.deepEqual([...((await readFile(join(temporary, 'program.dll'))).subarray(0, 2))], [77, 90]);
    assert.equal((await readFile(join(temporary, 'program.pdb'))).subarray(0, 4).toString(), 'BSJB');
    assert.match(await readFile(join(temporary, 'program.xml'), 'utf8'), /<doc>/);
    JSON.parse(await readFile(join(temporary, 'program.json'), 'utf8'));
  });
  for (const backend of ['wasm', 'javascript', 'native-wasm', 'auto']) {
    await check(`An existing PE executes through the ${backend} backend`, async () => {
      const result = parsed(await cli(['run', 'program.dll', '--backend', backend, '--json']));
      assert.equal(result.success, true, json(result));
      assert.equal(result.stdout, 'cli:42\n');
      assert.equal(result.exitCode, 0);
      assert.equal(result.backend, backend === 'auto' ? 'javascript' : backend);
      return { backend: result.backend, stdout: result.stdout };
    });
  }
  await check('C# source and a saved tagged artifact are accepted as execution inputs', async () => {
    for (const input of ['Program.cs', 'program.json']) {
      const result = parsed(await cli(['run', input, '--backend', 'javascript', '--json']));
      assert.equal(result.stdout, 'cli:42\n');
    }
  });
  await check('Reference listing, PE inspection and both compatibility analyzers expose their public results', async () => {
    const references = parsed(await cli(['references', '--json']));
    assert(references.length >= 160);
    assert(references.some(reference => /System\.Runtime/.test(reference.name)));
    const model = parsed(await cli(['inspect', 'program.dll', '--output', 'program-model.json', '--json']));
    assert(model.types.length > 0);
    assert.equal(JSON.parse(await readFile(join(temporary, 'program-model.json'), 'utf8')).name, model.name);
    for (const backend of ['javascript', 'native-wasm']) {
      const analysis = parsed(await cli(['analyze', 'program.dll', '--backend', backend, '--json']));
      assert.equal(analysis.supported, true, json(analysis));
    }
  });
  await check('C# emits reusable JavaScript and native Wasm artifacts', async () => {
    for (const [target, output] of [['javascript', 'direct.mjs'], ['wasm', 'direct.wasm']]) {
      const result = parsed(await cli(['compile', 'Program.cs', '--target', target, '--output', output, '--json']));
      assert.notEqual(result.success, false, json(result));
    }
    assert.equal(WebAssembly.validate(await readFile(join(temporary, 'direct.wasm'))), true);
    assert.match(await readFile(join(temporary, 'direct.mjs'), 'utf8'), /export/);
    for (const input of ['direct.mjs', 'direct.wasm']) {
      const result = parsed(await cli(['run', input, '--runtime', 'deliberately-missing-runtime', '--json']));
      assert.equal(result.stdout, 'cli:42\n');
      assert.equal(result.exitCode, 0);
    }
    return { standaloneArtifactsExecuteWithoutDotnet: true };
  });
  await check('Existing PE images emit executable JavaScript and Wasm', async () => {
    for (const [command, output] of [['emit-js', 'emitted.mjs'], ['emit-wasm', 'emitted.wasm']]) {
      parsed(await cli([command, 'program.dll', '--output', output, '--json']));
      assert.equal(parsed(await cli(['run', output, '--runtime', 'missing-runtime', '--json'])).stdout, 'cli:42\n');
    }
  });
  await check('Standard input compiles and program arguments remain separate from CLI arguments', async () => {
    parsed(await cli(['compile', '-', '--output', 'stdin.dll', '--json'], { input: 'System.Console.WriteLine(string.Join("|", args)); return 7;' }));
    const result = parsed(await cli(['run', 'stdin.dll', '--backend', 'wasm', '--json', '--', '--json', 'argument with spaces']), 7);
    assert.equal(result.stdout, '--json|argument with spaces\n');
    assert.equal(result.exitCode, 7);
  });
  await check('Roslyn diagnostics retain file coordinates and compilation failures exit one', async () => {
    await put('Broken.cs', 'class Broken { static void Main() { int value = ; } }');
    const result = parsed(await cli(['compile', 'Broken.cs', '--output', 'broken.dll', '--json']), 1);
    assert.equal(result.success, false);
    const diagnostic = result.diagnostics?.find(item => item.severity === 'error');
    assert(diagnostic, json(result));
    assert.match(diagnostic.id, /^CS\d+$/);
    assert.match(diagnostic.path, /Broken.cs$/);
    assert(diagnostic.startLine >= 1 && diagnostic.startColumn > 1);
    await assert.rejects(stat(join(temporary, 'broken.dll')), { code: 'ENOENT' });
  });
  await check('Typed managed invocation preserves integers above JavaScript safe precision', async () => {
    parsed(await cli(['compile', 'Library.cs', '--options', 'compile-library.json', '--output', 'library.dll', '--json']));
    const result = parsed(await cli(['invoke', 'library.dll', '--type', 'WideApi', '--method', 'Echo', '--arguments', '[{"$bigint":"9007199254740993"}]', '--parameters', '["System.Int64"]', '--json']));
    assert.deepEqual(result.result, { $bigint: '9007199254740993' });
    const sum = parsed(await cli(['invoke', 'library.dll', '--type', 'WideApi', '--method', 'Add', '--arguments', '[20,22]', '--json']));
    assert.equal(sum.result, 42);
  });
  await check('Expression and dynamic function commands compile and invoke real C#', async () => {
    assert.equal(parsed(await cli(['eval', '20 + 22', '--return-type', 'int', '--json'])).result, 42);
    await put('function.json', { returnType: 'long', parameters: [{ name: 'value', type: 'long' }], body: 'return value * 2;' });
    const result = parsed(await cli(['compile-function', '--spec', 'function.json', '--invoke', '--arguments', '[{"$bigint":"9007199254740993"}]', '--json']));
    assert.deepEqual(result.result, { $bigint: '18014398509481986' });
  });
  await check('Single requests, batch files and scripts expose the same managed compiler API', async () => {
    const single = parsed(await cli(['api'], { input: json({ id: 'one', method: 'evaluate', args: ['6 * 7', { returnType: 'int' }] }) }));
    assert.equal(single.success, true);
    assert.equal(single.result.result, 42);
    await put('batch.json', [{ id: 'compile', method: 'compile', args: [source] }, { id: 'run', method: 'run', args: [ref('compile'), { backend: 'javascript' }] }]);
    const batch = code(await cli(['batch', 'batch.json'])).stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(batch.length, 2);
    assert(batch.every(result => result.success));
    assert.equal(batch[1].result.stdout, 'cli:42\n');
    await put('script.mjs', 'export default async ({ compiler, args, signal, cwd }) => { const events=[]; const off=compiler.onEvent(event=>events.push(event)); try { const result=await compiler.evaluate("20 + 22", {returnType:"int"}); return {success:result.success,value:result.result,args,alive:!signal.aborted,hasCwd:typeof cwd === "string"}; } finally { off(); } };');
    const scripted = parsed(await cli(['script', 'script.mjs', '--json', '--', 'script-argument']));
    assert.deepEqual(scripted, { success: true, value: 42, args: ['script-argument'], alive: true, hasCwd: true });
  });
  await check('DLL references are available to source compilation and runtime linking', async () => {
    await put('Reference.cs', 'System.Console.WriteLine(WideApi.Add(20, 22));');
    for (const backend of ['wasm', 'javascript', 'native-wasm']) {
      const result = parsed(await cli(['run', 'Reference.cs', '--reference', 'library.dll', '--backend', backend, '--json']));
      assert.equal(result.stdout, '42\n');
    }
  });
  await check('One session retains results, compilation caches, dynamic functions and CLR object handles', async () => {
    const requests = [
      { id: 'a', method: 'compile', args: [source, { emitPdb: false }] },
      { id: 'b', method: 'compile', args: [source, { emitPdb: false }] },
      { id: 'js1', method: 'emitJavaScript', args: [ref('a')] },
      { id: 'js2', method: 'emitJavaScript', args: [ref('a')] },
      { id: 'jsrun', method: 'run', args: [ref('js2')] },
      { id: 'lib', method: 'compile', args: ['public class Counter { public int Value {get;set;} public Counter(int value) {Value=value;} public int Add(int x)=>Value+=x; }', { outputKind: 'library' }] },
      { id: 'counter', method: 'createObject', args: [ref('lib.assemblyId'), 'Counter', [10]] },
      { id: 'set', method: 'setProperty', args: [ref('counter'), 'Value', 20] },
      { id: 'get', method: 'getProperty', args: [ref('counter'), 'Value'] },
      { id: 'add', method: 'invokeObject', args: [ref('counter'), 'Add', [22]] },
      { id: 'release', method: 'releaseObject', args: [ref('counter')] },
      { id: 'fn', method: 'compileFunction', args: [{ returnType: 'long', parameters: [{ name: 'value', type: 'long' }], body: 'return value * 2;' }] },
      { id: 'fnresult', target: 'fn', method: 'invoke', args: [{ $bigint: '9007199254740993' }] },
      { id: 'eval', method: 'evaluate', args: ['value + 2', { returnType: 'int', parameters: [{ name: 'value', type: 'int' }], arguments: [40] }] },
    ];
    const result = await session(requests);
    assert.equal(result.b.performance.cache.compilationReused, true);
    assert.equal(result.js2.cache.emitHit, true);
    assert.equal(result.jsrun.stdout, 'cli:42\n');
    assert.equal(result.get, 20);
    assert.equal(result.add.result, 42);
    assert.deepEqual(result.fnresult.result, { $bigint: '18014398509481986' });
    assert.equal(result.eval.result, 42);
    return { requests: requests.length, compilationReused: true, emissionReused: true };
  });
  await check('Sessions support persistent managed files and explicit workspace disposal', async () => {
    const result = await session([
      { id: 'workspace', method: 'createWorkspace', args: [{ files: { 'input.txt': '41' } }] },
      { id: 'assembly', method: 'compile', args: ['using System; using System.IO; var n = int.Parse(File.ReadAllText("input.txt")); File.WriteAllText("output.txt", (n+1).ToString()); Console.WriteLine(n+1);'] },
      { id: 'run', method: 'run', args: [ref('assembly'), { backend: 'wasm', workspaceId: ref('workspace.workspaceId') }] },
      { id: 'files', method: 'readWorkspace', args: [ref('workspace.workspaceId'), ['output.txt']] },
      { id: 'dispose', method: 'disposeWorkspace', args: [ref('workspace.workspaceId')] },
    ]);
    assert.equal(result.run.stdout, '42\n');
    assert.equal(result.dispose.disposed, true);
    assert(result.files.files['output.txt'], json(result.files));
  });
  await check('Real MSBuild project evaluation and build honor references, generated sources and resources', async () => {
    await put('project/lib/Library.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Library</OutputType></PropertyGroup></Project>');
    await put('project/lib/Library.cs', 'public static class ProjectValue { public static int Value => 42; }');
    await put('project/app/App.csproj', '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><RootNamespace>CliProject</RootNamespace></PropertyGroup><ItemGroup><ProjectReference Include="../lib/Library.csproj"/></ItemGroup><Target Name="Generate" BeforeTargets="CoreCompile"><WriteLinesToFile File="obj/Generated.cs" Lines="public static class Generated { public static string Text =&gt; &quot;$(Message)&quot;%3B }" Overwrite="true"/><ItemGroup><Compile Include="obj/Generated.cs"/></ItemGroup></Target></Project>');
    await put('project/app/Program.cs', 'using System; using System.Resources; using System.Reflection; Console.WriteLine(ProjectValue.Value); Console.WriteLine(Generated.Text); Console.WriteLine(new ResourceManager("CliProject.Strings", Assembly.GetExecutingAssembly()).GetString("Greeting"));');
    await put('project/app/Strings.resx', '<root><data name="Greeting"><value>resource:42</value></data></root>');
    const evaluation = parsed(await cli(['evaluate-project', 'project/app/App.csproj', '--root', 'project', '--property', 'Message=generated:42', '--json']));
    assert.notEqual(evaluation.success, false, json(evaluation));
    assert.match(json(evaluation), /generated:42/);
    const built = parsed(await cli(['build', 'project/app/App.csproj', '--root', 'project', '--property', 'Message=generated:42', '--no-restore', '--output', 'project.dll', '--artifact', 'project-build.json', '--json']));
    assert.notEqual(built.success, false, json(built));
    assert.deepEqual([...((await readFile(join(temporary, 'project.dll'))).subarray(0, 2))], [77, 90]);
    const executed = parsed(await cli(['run', 'project-build.json', '--backend', 'wasm', '--json']));
    assert.equal(executed.stdout, '42\ngenerated:42\nresource:42\n');
    const direct = parsed(await cli(['run', 'project/app/App.csproj', '--root', 'project', '--property', 'Message=direct:42', '--no-restore', '--backend', 'wasm', '--json']));
    assert.equal(direct.stdout, '42\ndirect:42\nresource:42\n');
  });
  await check('Resource creation and actual native WASI commands are accessible through the public protocol', async () => {
    const wasi = JSON.parse(await readFile(join(root, 'tests/fixtures/wasi-command.json'), 'utf8'));
    await put('native-tool.wasm', Buffer.from(wasi.base64, 'base64'));
    const result = await session([
      { id: 'resources', method: 'createResources', args: [[{ name: 'Answer', type: 'System.Int32', value: 42 }]] },
      { id: 'resx', method: 'convertResx', args: ['<root><data name="Greeting"><value>hello</value></data></root>'] },
      { id: 'native', method: 'addNativeCommand', args: ['native-tool', bytesFile('native-tool.wasm')] },
      { id: 'run', method: 'runNativeCommand', args: ['native-tool', { args: ['generate', 'input.txt', 'Generated.cs'], env: { OFFSET: '2' }, workingDirectory: '/project', files: { 'input.txt': '40' } }] },
      { id: 'remove', method: 'removeNativeCommand', args: ['native-tool'] },
    ]);
    assert.equal(result.resources.success, true);
    assert.equal(result.resx.success, true);
    assert.equal(result.run.exitCode, 0);
    assert.match(result.run.stdout, /Generated Generated.cs with value 42/);
    assert.equal(result.remove, true);
  });
  await check('Resource and native command conveniences write genuine binaries and captured files', async () => {
    await put('resources.json', [{ name: 'Answer', type: 'System.Int32', value: 42 }]);
    await put('Strings.resx', '<root><data name="Greeting"><value>hello</value></data></root>');
    for (const [command, input, output] of [['resources', 'resources.json', 'value.resources'], ['resx', 'Strings.resx', 'strings.resources']]) {
      assert.equal(parsed(await cli([command, input, '--output', output, '--json'])).success, true);
      assert.equal((await readFile(join(temporary, output))).readUInt32LE(), 0xbeefcace);
    }
    await put('native-request.json', { env: { OFFSET: '2' }, workingDirectory: '/project', files: { 'input.txt': '40' } });
    const native = parsed(await cli(['native', 'native-tool.wasm', '--request', 'native-request.json', '--files-out', 'native-files', '--runtime', 'missing-runtime', '--json', '--', 'generate', 'input.txt', 'Generated.cs']));
    assert.equal(native.exitCode, 0);
    assert.match(await readFile(join(temporary, 'native-files/project/Generated.cs'), 'utf8'), /Value => 42/);
  });
  await check('Compiler extension DLLs run real Roslyn source generators and analyzers from CLI flags', async () => {
    const { compilerExtensionSource, workflowExamples } = await import('../demo/workflows.js');
    await put('Extension.cs', compilerExtensionSource);
    await put('ExtensionProgram.cs', workflowExamples.find(example => example.kind === 'extensions').source);
    parsed(await cli(['compile', 'Extension.cs', '--kind', 'library', '--compiler-references', '--output', 'extension.dll', '--json']));
    const compilation = parsed(await cli(['compile', 'ExtensionProgram.cs', '--extension', 'extension.dll', '--output', 'extension-program.dll', '--json']));
    assert(compilation.generatedSources.some(item => item.text.includes('GeneratedValues')));
    assert(compilation.diagnostics.some(item => item.id === 'LAB001' && item.severity === 'warning'));
    const result = parsed(await cli(['run', 'extension-program.dll', '--backend', 'wasm', '--json']));
    assert.match(result.stdout, /Hello from a real Roslyn source generator!/);
  });
  await check('Managed MSBuild tasks compile and execute with typed inputs and outputs', async () => {
    await put('Task.cs', 'using Microsoft.Build.Framework; using Microsoft.Build.Utilities; public sealed class DoubleTask : Task { [Required] public int Input {get;set;} [Output] public int Value {get;private set;} public override bool Execute() { Value=Input*2; return true; } }');
    await put('task-request.json', { parameters: { Input: 21 }, outputProperties: ['Value'] });
    parsed(await cli(['compile', 'Task.cs', '--kind', 'library', '--task-references', '--output', 'task.dll', '--json']));
    const result = parsed(await cli(['task', 'task.dll', '--type', 'DoubleTask', '--request', 'task-request.json', '--json']));
    assert.equal(result.success, true);
    assert.equal(result.outputs.Value, 42);
  });
  await check('An official local NuGet package compiles and executes using the managed backend', async () => {
    const nupkg = join(root, 'tests/fixtures/newtonsoft.json.13.0.3.nupkg');
    const metadata = parsed(await cli(['package', nupkg, '--json']));
    assert.equal(metadata.id, 'Newtonsoft.Json');
    await put('Json.cs', 'using Newtonsoft.Json; System.Console.WriteLine(JsonConvert.SerializeObject(new { Answer=42 }));');
    const result = parsed(await cli(['run', 'Json.cs', '--nupkg', nupkg, '--backend', 'wasm', '--json']));
    assert.deepEqual(JSON.parse(result.stdout), { Answer: 42 });
  });
  await check('NuGet restore resolves a genuine package from a local v3 HTTP feed', async () => {
    const bytes = await readFile(join(root, 'tests/fixtures/newtonsoft.json.13.0.3.nupkg'));
    let base;
    const fetched = [];
    feed = createServer((request, response) => {
      fetched.push(request.url);
      if (request.url === '/v3/index.json') response.end(json({ version: '3.0.0', resources: [{ '@id': `${base}/flat/`, '@type': 'PackageBaseAddress/3.0.0' }] }));
      else if (request.url === '/flat/newtonsoft.json/index.json') response.end(json({ versions: ['13.0.3'] }));
      else if (request.url === '/flat/newtonsoft.json/13.0.3/newtonsoft.json.13.0.3.nupkg') response.end(bytes);
      else { response.statusCode = 404; response.end(); }
    });
    await new Promise(resolve => feed.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${feed.address().port}`;
    const args = ['restore', 'Newtonsoft.Json@13.0.3', '--feed', `${base}/v3/index.json`, '--cache-dir', 'nuget-cache', '--json'];
    const result = parsed(await cli(args));
    assert.equal(result.packages[0].id, 'Newtonsoft.Json');
    assert.equal(result.packages[0].version, '13.0.3');
    assert(fetched.some(path => path.endsWith('.nupkg')));
    await new Promise(resolve => feed.close(resolve));
    feed = undefined;
    const offline = parsed(await cli([...args, '--offline']));
    assert.equal(offline.packages[0].id, 'Newtonsoft.Json');
    assert.equal(offline.packages[0].version, '13.0.3');
    const apiArgs = ['api', '--feed', `${base}/v3/index.json`, '--offline'];
    const request = { id: 'restore', method: 'restore', args: [[{ id: 'Newtonsoft.Json', version: '13.0.3' }]] };
    const restored = parsed(await cli([...apiArgs, '--cache-dir', 'nuget-cache'], { input: json(request) }));
    assert.equal(restored.success, true);
    assert.equal(restored.result.packages[0].id, 'Newtonsoft.Json');
    const missing = parsed(await cli([...apiArgs, '--cache-dir', 'empty-cache'], { input: json(request) }), 1);
    assert.equal(missing.error.code, 'OFFLINE_CACHE_MISS');
    return { requests: fetched.length, externalNetwork: false, cachedRestoreWithFeedStopped: true, apiHonorsOffline: true };
  });
  await check('Execution errors and bounded execution are machine-readable and terminate workers', async () => {
    await put('Throw.cs', 'throw new System.InvalidOperationException("cli-failure");');
    const failure = parsed(await cli(['run', 'Throw.cs', '--backend', 'wasm', '--json']), 1);
    assert.equal(failure.success, false);
    assert.match(failure.error.message, /cli-failure/);
    await put('Loop.cs', 'while (true) {}');
    parsed(await cli(['compile', 'Loop.cs', '--output', 'loop.dll', '--json']));
    const timeout = await cli(['run', 'loop.dll', '--backend', 'wasm', '--timeout-ms', '200', '--json'], { timeoutMs: 30000 });
    const result = parsed(timeout, 124);
    assert.match(json(result), /timeout|timed out/i);
    return { timeoutExitCode: timeout.code, workerTerminated: true };
  });
  await check('Standalone generated JavaScript and Wasm honor execution timeouts without Roslyn', async () => {
    await put('unbounded-wasm.json', { instructionBudget: false });
    for (const [target, output] of [['javascript', 'loop.mjs'], ['wasm', 'loop.wasm']]) {
      const flags = target === 'wasm' ? ['--wasm-options', 'unbounded-wasm.json'] : [];
      parsed(await cli(['compile', 'Loop.cs', '--target', target, '--output', output, ...flags, '--json']));
      const budget = target === 'javascript' ? ['--max-instructions', '9007199254740991'] : [];
      const result = parsed(await cli(['run', output, '--runtime', 'missing-runtime', '--timeout-ms', '200', ...budget, '--json'], { timeoutMs: 10000 }), 124);
      assert.equal(result.error.code, 'TIMEOUT');
    }
  });
  await check('SIGINT stops a session and disposes its compiler worker', async () => {
    // A deliberately non-ending stdin keeps a normal session alive until SIGINT.
    const child = spawn(process.execPath, [binary, 'session', '--json'], { cwd: temporary, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) child.kill('SIGINT'); });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    child.stdin.write(json({ id: 'ready', method: 'info', args: [] }) + '\n');
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    try {
      const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
      assert.equal(exit.code, 130, stdout + stderr);
      assert.equal(JSON.parse(stdout.trim().split('\n')[0]).success, true);
    } finally { clearTimeout(timer); children.delete(child); }
  });
  if (!process.argv.includes('--skip-pack')) await check('npm tarball installs offline and its executable loads all bundled compiler assets', async () => {
    const pack = code(await processRun(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root, timeoutMs: 180000 }));
    const manifest = JSON.parse(pack.stdout)[0];
    const entries = new Set(manifest.files.map(file => file.path));
    assert(![...entries].some(file => /^managed\/(?:.*\/)?(?:bin|obj|publish|RoslynPatched)\//.test(file)), 'Tarball must exclude intermediate managed build outputs.');
    for (const required of ['bin/roslynweb.mjs', 'src/node/index.js', 'src/node/worker-bootstrap.js', 'dist/_framework/dotnet.js']) assert(entries.has(required), `Tarball lacks ${required}`);
    assert([...entries].some(file => /^dist\/_framework\/dotnet\.native\..*\.wasm$/.test(file)));
    const installation = await put('installed/package.json', { private: true, type: 'module' });
    code(await processRun(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, manifest.filename)], { cwd: dirname(installation), timeoutMs: 180000 }));
    const installedRoot = join(dirname(installation), 'node_modules/@roslynweb/core');
    const installedBinary = join(installedRoot, 'bin/roslynweb.mjs');
    const info = parsed(await processRun(process.execPath, [installedBinary, 'info', '--json'], { cwd: dirname(installation) }));
    assert.match((info.info || info.result || info).roslynVersion, /^5\./);
    const result = parsed(await processRun(process.execPath, [installedBinary, 'run', join(temporary, 'Program.cs'), '--backend', 'javascript', '--json'], { cwd: dirname(installation) }));
    assert.equal(result.stdout, 'cli:42\n');
    const command = join(dirname(installation), 'node_modules/.bin/roslynweb' + (process.platform === 'win32' ? '.cmd' : ''));
    code(await processRun(command, ['--version'], { cwd: dirname(installation) }));
    return { files: manifest.files.length, packedBytes: manifest.size, version: manifest.version, installedOffline: true };
  });
} catch (error) {
  if (!checks.some(item => !item.passed)) checks.push({ name: 'Harness setup', passed: false, error: { message: error.message, stack: error.stack } });
  process.exitCode = 1;
} finally {
  clearTimeout(watch);
  for (const child of children) child.kill('SIGKILL');
  if (feed) await new Promise(resolve => feed.close(resolve));
  const report = { testedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, compiler: 'Bundled Roslyn/.NET WebAssembly in the production Node Worker host', subprocess: true }, milliseconds: Math.round(performance.now() - started), passed: checks.filter(item => item.passed).length, failed: checks.filter(item => !item.passed).length, checks };
  await writeFile(join(root, 'docs/cli-verification.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
  console.log(`${report.passed} CLI integration checks passed; ${report.failed} failed`);
}
