import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable, PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { parseCli, helpText, COMMANDS } from '../src/cli/options.mjs';
import { collectSources, readInputBytes, readJsonFile, readStdin } from '../src/cli/io.mjs';
import { runCli, exitCodeFor } from '../src/cli/main.mjs';
import { watchCommand } from '../src/cli/watch.mjs';
import { startServer } from '../src/cli/serve.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const executable = join(projectRoot, 'bin/roslynweb.mjs');

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'roslynweb-cli-front-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function capture({ slow = false } = {}) {
  let text = '';
  const stream = new Writable({
    highWaterMark: 8,
    write(chunk, encoding, callback) {
      text += chunk.toString();
      if (slow) setTimeout(callback, 1); else callback();
    },
  });
  return { stream, get text() { return text; } };
}

async function invoke(args, { stdin = '', cwd = projectRoot, slow = false, signal } = {}) {
  const out = capture({ slow }), err = capture();
  const code = await runCli(args, {
    cwd, stdin: typeof stdin === 'string' ? Readable.from([stdin]) : stdin,
    stdout: out.stream, stderr: err.stream, signal, signals: false,
  });
  return { code, stdout: out.text, stderr: err.text };
}

function child(args, t) {
  const process = spawn(globalThis.process.execPath, [executable, ...args], {
    cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  let stdout = '', stderr = '';
  process.stdout.setEncoding('utf8'); process.stderr.setEncoding('utf8');
  process.stdout.on('data', chunk => { stdout += chunk; });
  process.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise((yes, no) => {
    process.once('error', no);
    process.once('close', (code, signal) => yes({ code, signal, stdout, stderr }));
  });
  return { process, completed, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function eventually(predicate, message, timeout = 2000) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > end) assert.fail(message);
    await delay(10);
  }
}

test('CLI help and version work without a runtime directory', async () => {
  const pkg = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
  for (const args of [[], ['help'], ['--help']]) {
    const result = await invoke([...args, '--runtime', '/does/not/exist']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: roslynweb/);
    assert.equal(result.stderr, '');
  }
  const result = await invoke(['--version', '--json', '--runtime', '/does/not/exist']);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).version, pkg.version);
  assert.equal(result.stderr, '');
});

test('Every declared CLI command has help without loading the compiler', async () => {
  for (const command of Object.keys(COMMANDS)) {
    const parsed = parseCli(['help', command]);
    assert.equal(parsed.command, command);
    assert.equal(parsed.options.help, true);
    assert.match(helpText(command), new RegExp(`roslynweb ${command}`));
  }
});

test('CLI parsing preserves repeatable flags and exact program arguments', () => {
  const parsed = parseCli(['watch', 'run', 'input.cs', '-r', 'a.dll', '--reference=b.dll', '--backend', 'native-wasm', '--poll-ms', '10', '--', '--help', 'a b', '-1']);
  assert.equal(parsed.command, 'watch');
  assert.equal(parsed.watchCommand, 'run');
  assert.deepEqual(parsed.positionals, ['input.cs']);
  assert.deepEqual(parsed.options.reference, ['a.dll', 'b.dll']);
  assert.deepEqual(parsed.options.args, ['--help', 'a b', '-1']);
  assert.equal(parsed.options.pollMs, 10);
});

test('CLI rejects unknown, misspelled, inapplicable and contradictory options', () => {
  for (const args of [
    ['complie', 'p.cs'], ['compile', '--unknown'], ['info', '--target', 'wasm'],
    ['compile', 'p.cs', '--', 'extra'], ['watch', 'inspect', 'p.dll'],
    ['compile', 'p.cs', '--pdb', 'p.pdb', '--no-pdb'], ['compile', '--target', 'aot'],
    ['run', '--backend', 'native'], ['compile', '--optimize', 'fast'],
    ['run', '--timeout-ms', '0'], ['session', '--max-line-bytes', '1.5'],
    ['serve', '--port', '65536'], ['watch', 'run', 'p.cs', '--poll-ms', '-1'],
  ]) assert.throws(() => parseCli(args), { code: 'CLI_USAGE' }, args.join(' '));
  assert.equal(parseCli(['serve', '--port', '0']).options.port, 0);
});

test('CLI JSON usage failures stay machine readable on stdout', async () => {
  for (const args of [['unknown', '--json'], ['compile', '--json', '--typo'], ['run', '--json', '--timeout-ms', '0']]) {
    const result = await invoke(args);
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).success, false, args.join(' '));
    assert.equal(JSON.parse(result.stdout).error.code, 'CLI_USAGE');
    assert.equal(result.stderr, '');
  }
});

test('Exit statuses preserve managed failures, CLI errors, cancellation and program codes', () => {
  assert.equal(exitCodeFor({ success: false }), 1);
  assert.equal(exitCodeFor({ success: true, exitCode: 7 }), 7);
  assert.equal(exitCodeFor({ exitCode: -1 }), 255);
  assert.equal(exitCodeFor({ exitCode: 258 }), 2);
  assert.equal(exitCodeFor(Object.assign(new Error('bad input'), { code: 'CLI_USAGE' })), 2);
  assert.equal(exitCodeFor({ error: { code: 'TIMEOUT' } }), 124);
  assert.equal(exitCodeFor({ error: { code: 'ABORTED' } }), 130);
});

test('Source collection recurses deterministically, excludes generated folders and avoids symlink recursion', async t => {
  const cwd = await temporary(t);
  await mkdir(join(cwd, 'src/nested'), { recursive: true });
  await mkdir(join(cwd, 'src/obj'), { recursive: true });
  await writeFile(join(cwd, 'src/b.cs'), '// b');
  await writeFile(join(cwd, 'src/A.CS'), '// a');
  await writeFile(join(cwd, 'src/nested/c.cs'), '// c');
  await writeFile(join(cwd, 'src/obj/generated.cs'), '// ignored');
  await writeFile(join(cwd, 'src/readme.txt'), 'ignored');
  await symlink(join(cwd, 'src'), join(cwd, 'src/nested/loop'));
  const sources = await collectSources(['src', 'src/b.cs'], { cwd });
  assert.deepEqual(sources.map(source => source.path), ['src/A.CS', 'src/b.cs', 'src/nested/c.cs']);
  assert.deepEqual(sources.map(source => source.text), ['// a', '// b', '// c']);
});

test('Source stdin is consumed exactly once and empty directories fail clearly', async t => {
  const cwd = await temporary(t);
  let reads = 0;
  const stdinText = async () => { reads++; return '// source'; };
  assert.deepEqual(await collectSources(['-'], { cwd, stdinText }), [{ path: 'stdin.cs', text: '// source' }]);
  assert.equal(reads, 1);
  await assert.rejects(collectSources(['-', '-'], { cwd, stdinText }), /only be used once/);
  await assert.rejects(collectSources(['.'], { cwd }), /No C# source files/);
  await assert.rejects(readInputBytes('.', cwd), /Expected a file/);
});

test('JSON options decode explicit binary values and reject malformed documents', async t => {
  const cwd = await temporary(t);
  await writeFile(join(cwd, 'valid.json'), '{"number":{"$bigint":"9007199254740993"},"data":{"$bytes":"AAH/"}}');
  const value = await readJsonFile('valid.json', cwd);
  assert.equal(value.number, 9007199254740993n);
  assert.deepEqual([...value.data], [0, 1, 255]);
  await writeFile(join(cwd, 'invalid.json'), '{"bad":}');
  await assert.rejects(readJsonFile('invalid.json', cwd), { code: 'INVALID_JSON' });
});

test('Stdin collection handles split UTF-8 and enforces its byte budget', async () => {
  const encoded = Buffer.from('a\u{1f600}b');
  assert.equal(await readStdin(Readable.from([encoded.subarray(0, 3), encoded.subarray(3)])), 'a\u{1f600}b');
  await assert.rejects(readStdin(Readable.from(['123', '456']), { limit: 5 }), { code: 'INPUT_LIMIT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readStdin(new PassThrough(), { signal: controller.signal }), { code: 'ABORTED' });
});

test('Session accepts chunked JSON lines, CRLF, empty lines and a final unterminated request', async () => {
  const requests = '\r\n{"id":"a😀","method":"disposed"}\r\n \n{"id":2,"method":"disposed"}';
  const bytes = Buffer.from(requests), chunks = [...bytes].map(byte => Buffer.from([byte]));
  const result = await invoke(['session'], { stdin: Readable.from(chunks) });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse), [
    { id: 'a😀', success: true, result: false }, { id: 2, success: true, result: false },
  ]);
});

test('Session continues after malformed requests and stop-on-error stops before the next request', async () => {
  const stdin = '{bad}\n{"id":"ok","method":"disposed"}\n';
  const result = await invoke(['session'], { stdin });
  assert.equal(result.code, 2);
  const lines = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].error.code, 'INVALID_JSON');
  assert.equal(lines[1].id, 'ok');
  const stopped = await invoke(['session', '--stop-on-error'], { stdin });
  assert.equal(stopped.code, 2);
  assert.equal(stopped.stdout.trim().split('\n').length, 1);
});

test('Session enforces byte rather than character line limits and tolerates output backpressure', async () => {
  const tooLarge = await invoke(['session', '--max-line-bytes', '4'], { stdin: '😀😀\n' });
  assert.equal(tooLarge.code, 1);
  assert.equal(JSON.parse(tooLarge.stdout).error.code, 'INPUT_LIMIT');
  const requests = Array.from({ length: 40 }, (_, id) => JSON.stringify({ id, method: 'disposed' })).join('\n');
  const result = await invoke(['session'], { stdin: requests, slow: true });
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line).id), Array.from({ length: 40 }, (_, index) => index));
});

test('Session rejects an already-aborted signal without waiting for stdin', { timeout: 2000 }, async () => {
  const controller = new AbortController(); controller.abort();
  const stdin = new PassThrough();
  const timer = setTimeout(() => stdin.end(), 500);
  try {
    const start = performance.now();
    const result = await invoke(['session'], { stdin, signal: controller.signal });
    assert.equal(result.code, 130);
    assert(performance.now() - start < 400, 'Session must observe cancellation before attempting to read stdin');
  } finally { clearTimeout(timer); stdin.destroy(); }
});

test('Session files and API request files resolve relative to CLI cwd', async t => {
  const cwd = await temporary(t);
  await writeFile(join(cwd, 'requests.jsonl'), '{"id":"file","method":"disposed"}\n');
  await writeFile(join(cwd, 'request.json'), '{"id":"api","method":"disposed"}');
  assert.equal(JSON.parse((await invoke(['session', 'requests.jsonl'], { cwd })).stdout).id, 'file');
  assert.equal(JSON.parse((await invoke(['api', '--request', 'request.json'], { cwd })).stdout).id, 'api');
  const failed = await invoke(['api', 'request.json', '--request', 'request.json'], { cwd });
  assert.equal(failed.code, 2);
  assert.equal(JSON.parse(failed.stdout).error.code, 'CLI_USAGE');
});

test('Batch produces one response per request and rejects a non-array before compiler startup', async () => {
  const result = await invoke(['batch'], { stdin: '[{"id":1,"method":"disposed"},{"id":2,"method":"dispose"},{"id":3,"method":"disposed"}]' });
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line).result), [false, { disposed: true }, true]);
  assert.equal((await invoke(['batch'], { stdin: '{}' })).code, 2);
});

test('Malformed API objects and transport arguments use the documented usage exit status', async () => {
  for (const stdin of ['null', '{"method":"compile","args":{}}', '{"method":"compile","args":[{"$bigint":"not-an-integer"}]}']) {
    const result = await invoke(['api'], { stdin });
    assert.equal(result.code, 2);
    assert.equal(JSON.parse(result.stdout).success, false);
    assert(['INVALID_REQUEST', 'INVALID_ARGUMENT'].includes(JSON.parse(result.stdout).error.code));
    assert.equal(result.stderr, '');
  }
});

test('Broken stdout is a clean exit both during writing and while a session waits for stdin', { timeout: 3000 }, async () => {
  const error = Object.assign(new Error('Pipe closed'), { code: 'EPIPE' });
  const output = new Writable({ write(chunk, encoding, callback) { callback(error); } });
  assert.equal(await runCli(['--version'], { stdin: Readable.from([]), stdout: output, stderr: capture().stream, signals: false }), 0);
  const input = new PassThrough(), pendingOutput = capture();
  const completion = runCli(['session'], { stdin: input, stdout: pendingOutput.stream, stderr: capture().stream, signals: false });
  setTimeout(() => pendingOutput.stream.emit('error', error), 10);
  assert.equal(await completion, 0);
  assert.equal(pendingOutput.text, '');
});

test('Artifact application exit codes are normalized without booting Roslyn', async t => {
  const cwd = await temporary(t);
  for (const value of [-1, 258, 7]) {
    await writeFile(join(cwd, `program-${value}.mjs`), `export default function createAssembly() { return { run() { return ${value}; } }; }`);
    const result = await invoke(['run', `program-${value}.mjs`, '--json', '--runtime', '/does/not/exist'], { cwd });
    assert.equal(result.code, value === -1 ? 255 : value === 258 ? 2 : 7);
    assert.equal(JSON.parse(result.stdout).exitCode, value, 'JSON preserves the original managed program exit code');
    assert.equal(result.stderr, '');
  }
});

test('Watch coalesces input changes, ignores explicit generated outputs, and stops promptly', { timeout: 5000 }, async t => {
  const cwd = await temporary(t), controller = new AbortController();
  await writeFile(join(cwd, 'program.cs'), '// initial');
  const calls = [];
  const done = watchCommand('compile', ['.'], { pollMs: 10, output: 'program.dll', manifest: 'program.json' }, { cwd, signal: controller.signal }, async event => {
    calls.push(event);
    await writeFile(join(cwd, 'program.dll'), `artifact ${event.iteration}`);
    await writeFile(join(cwd, 'program.json'), `manifest ${event.iteration}`);
  });
  try {
    await eventually(() => calls.length === 1, 'Initial compilation did not run');
    await delay(60);
    assert.equal(calls.length, 1, 'Generated artifacts must not retrigger watch');
    await writeFile(join(cwd, 'program.cs'), '// changed content');
    await eventually(() => calls.length === 2, 'Source change did not retrigger compilation');
    assert.deepEqual(calls[1].changed, [join(cwd, 'program.cs')]);
    controller.abort(); await done;
  } finally { controller.abort(); await done; }
});

test('Watch includes uppercase C# inputs and editor configuration changes in directories', { timeout: 5000 }, async t => {
  const cwd = await temporary(t), controller = new AbortController();
  await writeFile(join(cwd, 'Program.CS'), '// initial');
  await writeFile(join(cwd, '.editorconfig'), 'root = true');
  const calls = [];
  const done = watchCommand('compile', ['.'], { pollMs: 10 }, { cwd, signal: controller.signal }, async event => { calls.push(event); });
  try {
    await eventually(() => calls.length === 1, 'Initial watch callback did not run');
    await writeFile(join(cwd, 'Program.CS'), '// uppercase source changed');
    await eventually(() => calls.length === 2, 'Uppercase source change was ignored');
    await writeFile(join(cwd, '.editorconfig'), 'root = false');
    await eventually(() => calls.length === 3, '.editorconfig change was ignored');
    assert.deepEqual(calls[2].changed, [join(cwd, '.editorconfig')]);
  } finally { controller.abort(); await done; }
});

test('Watch learns default artifact paths while retaining unrelated dependency DLL changes', { timeout: 5000 }, async t => {
  const cwd = await temporary(t), controller = new AbortController();
  await writeFile(join(cwd, 'Program.cs'), '// initial');
  await writeFile(join(cwd, 'dependency.dll'), 'dependency 1');
  await writeFile(join(cwd, 'Program.dll'), 'old generated output');
  const calls = [];
  const done = watchCommand('compile', ['.'], { pollMs: 10 }, { cwd, signal: controller.signal }, async event => {
    calls.push(event);
    await writeFile(join(cwd, 'Program.dll'), `output ${event.iteration}`);
    return { output: join(cwd, 'Program.dll') };
  });
  try {
    await eventually(() => calls.length === 1, 'Initial compilation did not run');
    await delay(70);
    assert.equal(calls.length, 1, 'Default generated output must not retrigger compilation');
    await writeFile(join(cwd, 'dependency.dll'), 'dependency 2 changed');
    await eventually(() => calls.length === 2, 'Dependency update did not retrigger compilation');
    assert.deepEqual(calls[1].changed, [join(cwd, 'dependency.dll')]);
    await delay(70);
    assert.equal(calls.length, 2, 'Updated default artifact must remain ignored');
  } finally { controller.abort(); await done; }
});

test('Watch keeps source edits made during a compilation pending for the next iteration', { timeout: 5000 }, async t => {
  const cwd = await temporary(t), controller = new AbortController();
  await writeFile(join(cwd, 'Program.cs'), '// initial');
  const calls = [];
  const done = watchCommand('compile', ['.'], { pollMs: 10 }, { cwd, signal: controller.signal }, async event => {
    calls.push(event);
    if(event.iteration === 1) {
      await writeFile(join(cwd, 'Program.cs'), '// edited during compilation');
      await writeFile(join(cwd, 'Program.dll'), 'generated');
    }
    return { output: join(cwd, 'Program.dll') };
  });
  try {
    await eventually(() => calls.length === 2, 'Concurrent source edit was lost when ignoring new output');
    assert.deepEqual(calls[1].changed, [join(cwd, 'Program.cs')]);
  } finally { controller.abort(); await done; }
});

test('Watch run follows project sources and treats inline JSON options as configuration rather than paths', { timeout: 5000 }, async t => {
  const cwd = await temporary(t), controller = new AbortController();
  await writeFile(join(cwd, 'App.csproj'), '<Project />');
  await writeFile(join(cwd, 'Program.cs'), '// initial');
  const calls = [];
  const done = watchCommand('run', ['App.csproj'], { pollMs: 10, options: JSON.stringify({ assemblyName: 'A'.repeat(300) }) }, { cwd, signal: controller.signal }, async event => { calls.push(event); });
  try {
    await eventually(() => calls.length === 1, 'Initial project execution did not run');
    await writeFile(join(cwd, 'Program.cs'), '// updated project source');
    await eventually(() => calls.length === 2, 'Project source update did not trigger watch run');
    assert.deepEqual(calls[1].changed, [join(cwd, 'Program.cs')]);
  } finally { controller.abort(); await done; }
});

test('Watch handles deletion and recreation without overlapping executions', { timeout: 5000 }, async t => {
  const cwd = await temporary(t), controller = new AbortController();
  const path = join(cwd, 'program.cs');
  await writeFile(path, '// initial');
  let active = 0, peak = 0;
  const calls = [];
  const done = watchCommand('compile', ['program.cs'], { pollMs: 10 }, { cwd, signal: controller.signal }, async event => {
    active++; peak = Math.max(peak, active); calls.push(event);
    await delay(20); active--;
  });
  try {
    await eventually(() => calls.length === 1 && active === 0, 'Initial watch callback did not complete');
    await rm(path);
    await eventually(() => calls.length === 2 && active === 0, 'Deletion was ignored');
    await writeFile(path, '// recreated');
    await eventually(() => calls.length === 3, 'Recreation was ignored');
    assert.equal(peak, 1);
  } finally { controller.abort(); await done; }
});

test('Static server serves Wasm with correct MIME, supports HEAD and rejects methods', async t => {
  const cwd = await temporary(t);
  await writeFile(join(cwd, 'index.html'), '<h1>CLI server</h1>');
  await writeFile(join(cwd, 'module.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const server = await startServer({ root: '.', port: 0 }, { cwd });
  t.after(() => server.close());
  const home = await fetch(server.url);
  assert.equal(home.status, 200);
  assert.equal(await home.text(), '<h1>CLI server</h1>');
  const wasm = await fetch(new URL('module.wasm', server.url), { method: 'HEAD' });
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.equal(wasm.headers.get('content-length'), '8');
  assert.equal((await wasm.arrayBuffer()).byteLength, 0);
  assert.equal(wasm.headers.get('x-content-type-options'), 'nosniff');
  const post = await fetch(server.url, { method: 'POST', body: 'ignored' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
});

test('Static server confines decoded paths and symlinks to the public root', async t => {
  const cwd = await temporary(t);
  await mkdir(join(cwd, 'public'));
  await mkdir(join(cwd, 'public/.private'));
  await writeFile(join(cwd, 'secret.txt'), 'outside root');
  await writeFile(join(cwd, 'public/.private/token.txt'), 'hidden');
  await symlink(join(cwd, 'secret.txt'), join(cwd, 'public/leak.txt'));
  await symlink(join(cwd, 'public/.private/token.txt'), join(cwd, 'public/hidden.txt'));
  await symlink(cwd, join(cwd, 'public/outer'));
  const server = await startServer({ root: 'public', port: 0 }, { cwd });
  t.after(() => server.close());
  for (const path of ['leak.txt', 'hidden.txt', 'outer/secret.txt', '.private/token.txt', '%2eprivate/token.txt', '%2e%2e%2fsecret.txt', 'bad%00name', 'bad%5cname', 'bad%ZZ']) {
    const response = await fetch(new URL(path, server.url));
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), 'Not found', path);
  }
});

test('CLI subprocess session exits on SIGINT while waiting for another request', { timeout: 5000 }, async t => {
  const running = child(['session'], t);
  running.process.stdin.write('{"id":"ready","method":"disposed"}\n');
  await eventually(() => running.stdout.includes('"ready"'), 'Session subprocess did not answer', 3000);
  running.process.kill('SIGINT');
  const result = await running.completed;
  assert.equal(result.code, 130);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
});

test('CLI subprocess static server exits on SIGTERM and closes its socket', { timeout: 5000 }, async t => {
  const cwd = await temporary(t);
  await writeFile(join(cwd, 'index.html'), 'served');
  const running = child(['serve', '--root', cwd, '--port', '0', '--json'], t);
  await eventually(() => running.stdout.includes('\n'), 'Server subprocess did not report its URL', 3000);
  const { url } = JSON.parse(running.stdout.trim());
  assert.equal(await (await fetch(url)).text(), 'served');
  running.process.kill('SIGTERM');
  const result = await running.completed;
  assert.equal(result.code, 143);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  await assert.rejects(fetch(url));
});
