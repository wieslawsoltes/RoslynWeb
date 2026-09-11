import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const sourceUrl = new URL('tests/fixtures/wasi-command.c', root);
const compiler = process.env.WASI_SDK_PATH ? join(process.env.WASI_SDK_PATH, 'bin/clang') : 'clang';
const directory = await mkdtemp(join(tmpdir(), 'roslynweb-wasi-fixture-'));
try {
  const args = ['--target=wasm32-wasip1', '-O2', '-Wl,--strip-all', '-Wl,-z,stack-size=1048576', '-Wl,--initial-memory=2097152', '-Wl,--max-memory=16777216', sourceUrl.pathname, '-o', join(directory, 'command.wasm')];
  execFileSync(compiler, args, { stdio: 'inherit' });
  const bytes = await readFile(join(directory, 'command.wasm'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const fixture = { description: 'Real C program linked against wasi-libc by WASI SDK 34 / clang 23.1.0. Runs directly in WebAssembly.', sdk: 'wasi-sdk-34', compiler: execFileSync(compiler, ['--version'], { encoding: 'utf8' }).split('\n')[0], source: 'wasi-command.c', sourceSha256: hash(await readFile(sourceUrl)), wasmSha256: hash(bytes), byteLength: bytes.byteLength, args: args.slice(0, -3), base64: bytes.toString('base64') };
  await writeFile(new URL('tests/fixtures/wasi-command.json', root), JSON.stringify(fixture, null, 2) + '\n');
  await writeFile(new URL('demo/native-command.json', root), JSON.stringify({ ...fixture, source: 'native-command.c' }, null, 2) + '\n');
  await writeFile(new URL('demo/native-command.c', root), await readFile(sourceUrl));
  console.log(`Wrote ${bytes.byteLength} native WASI bytes; sha256 ${fixture.wasmSha256}`);
} finally { await rm(directory, { recursive: true, force: true }); }
