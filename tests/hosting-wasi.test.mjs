import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { WasmCommandRegistry } from '../src/hosting/wasi.js';
const fixture = JSON.parse(await readFile(new URL('./fixtures/wasi-command.json', import.meta.url), 'utf8'));
const bytes = Uint8Array.from(Buffer.from(fixture.base64, 'base64'));
const decode = value => new TextDecoder().decode(value);
async function registry() { const commands = new WasmCommandRegistry(); await commands.register('native-tool', bytes); return commands; }
test('WASI fixture is genuine reproducible compiled C with matching source and wasm hashes', async () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(hash(bytes), fixture.wasmSha256); assert.equal(hash(await readFile(new URL('./fixtures/wasi-command.c', import.meta.url))), fixture.sourceSha256);
  const imports = WebAssembly.Module.imports(await WebAssembly.compile(bytes)); assert.ok(imports.some(entry => entry.name === 'path_open')); assert.ok(imports.some(entry => entry.name === 'fd_readdir'));
});
test('native C command reads files, args and env and generates real C# source', async () => {
  const result = await (await registry()).run('native-tool', { args: ['generate', 'input.txt', 'Generated.cs'], env: { OFFSET: '2' }, workingDirectory: '/project', files: { 'input.txt': '40' } });
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.stdout, 'Generated Generated.cs with value 42\n');
  assert.equal(decode(result.files['/project/Generated.cs']), 'public static class NativeGenerated { public static int Value => 42; }\n'); assert.deepEqual(result.unsupportedCalls, []);
});
test('native libc streams, arguments, environment, clocks, random and exit work', async () => {
  const commands = await registry(); const result = await commands.run('native-tool', { args: ['stdio', 'argument with spaces'], env: { GREETING: 'hello' }, stdin: 'input line\n' });
  assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(result.stdout, 'args:3:argument with spaces\nenv:hello\nstdin:input line\nclock+random:ok\n'); assert.equal(result.stderr, 'native stderr\n');
  assert.equal((await commands.run('native-tool', { args: ['exit', '23'] })).exitCode, 23);
});
test('native libc file descriptors support seek, positioned IO, truncate, rename and directory enumeration', async () => {
  const result = await (await registry()).run('native-tool', { args: ['io'] }); assert.equal(result.exitCode, 0, JSON.stringify(result)); assert.equal(decode(result.files['/work/b.bin']), 'aXYZ'); assert.equal(result.stdout, 'io:aXYZ\n'); assert.deepEqual(result.unsupportedCalls, []);
});
test('WASI invocations isolate and copy files and report removals', async () => {
  const commands = await registry(), original = new Uint8Array([52, 48]);
  const generated = await commands.run('native-tool', { args: ['generate'], files: { 'input.txt': original } }); assert.equal(generated.exitCode, 0);
  generated.files['/input.txt'][0] = 0; assert.equal(original[0], 52);
  assert.equal((await commands.run('native-tool', { args: ['generate'] })).exitCode, 2);
  const removed = await commands.run('native-tool', { args: ['remove'], files: { 'old.txt': 'old' } }); assert.equal(removed.exitCode, 0); assert.deepEqual(removed.removedFiles, ['/old.txt']); assert.deepEqual(removed.files, {});
});
test('WASI reports explicitly unsupported native facilities as NOSYS', async () => {
  const result = await (await registry()).run('native-tool', { args: ['unsupported'] }); assert.equal(result.exitCode, 0); assert.equal(result.stdout, 'symlink:52\n'); assert.deepEqual(result.unsupportedCalls, ['path_symlink']);
});
test('WASI bounds file growth and rejects escaping paths', async () => {
  const commands = await registry(); const quota = await commands.run('native-tool', { args: ['quota'], maxFileBytes: 16 }); assert.equal(quota.exitCode, 0); assert.equal(quota.stdout, 'quota:1\n'); assert.equal(quota.files['/large.bin'].length, 0);
  const escaped = await commands.run('native-tool', { args: ['escape'], workingDirectory: '/project' }); assert.equal(escaped.exitCode, 0); assert.equal(Object.hasOwn(escaped.files, '/outside.txt'), false);
  await assert.rejects(commands.run('native-tool', { args: ['generate'], files: { '/../../bad': '' } }), /WASI errno 76/);
  await assert.rejects(commands.run('native-tool', { maxMemoryBytes: 1 }), /maxMemoryBytes/);
});
test('registration, errors, cancellation and lifecycle are explicit', async () => {
  const commands = await registry(); await assert.rejects(commands.register('native-tool', bytes), /already registered/); await assert.rejects(commands.run('missing'), /not registered/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(commands.run('native-tool', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(commands.unregister('native-tool'), true); commands.dispose(); await assert.rejects(commands.register('new', bytes), /disposed/);
});

test('native WASI descriptor rights cannot be regained or bypassed', async () => {
  const result = await (await registry()).run('native-tool', { args: ['rights'] }); assert.equal(result.exitCode, 0, result.stdout + result.stderr); assert.equal(result.stdout, 'rights:enforced\n'); assert.equal(result.files['/rights.bin'].length, 0); assert.deepEqual(result.unsupportedCalls, []);
});
test('unlinked open file descriptors retain their quota until closed', async () => {
  const result = await (await registry()).run('native-tool', { args: ['orphan'], maxFileBytes: 6 }); assert.equal(result.exitCode, 0, result.stdout + result.stderr); assert.equal(result.stdout, 'orphan:quota preserved\n'); assert.equal(decode(result.files['/next.bin']), 'X'); assert.equal(Object.hasOwn(result.files, '/old.bin'), false);
});

test('empty project directories are available to native generators', async () => {
  const result = await (await registry()).run('native-tool', { args: ['generate', 'input.txt', 'obj/Generated.cs'], workingDirectory: '/project', directories: ['/project/obj'], files: { 'input.txt': '42' } }); assert.equal(result.exitCode, 0, result.stdout + result.stderr); assert.match(decode(result.files['/project/obj/Generated.cs']), /Value => 42/); assert.ok(result.directories.includes('/project/obj'));
});

test('native WASI validates vectored-memory overflow, renumber allocation and path components', async () => {
  const result = await (await registry()).run('native-tool', { args: ['edges'] }); assert.equal(result.exitCode, 0, result.stdout + result.stderr); assert.equal(result.stdout, 'edges:checked\n'); assert.equal(decode(result.files['/edge.bin']), 'original'); assert.equal(decode(result.files['/second.bin']), 'next'); assert.ok(result.directories.includes('/trailing'));
});
