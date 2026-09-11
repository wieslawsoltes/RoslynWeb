import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_METHODS, createApiSession } from '../src/cli/session.mjs';
import { decodeJson, encodeJson, stringifyJson } from '../src/cli/codec.mjs';

function mockSession(overrides = {}, options = {}) {
  const calls = [];
  const compiler = {
    info: { bridgeVersion: 'test' }, disposed: false,
    dispose() { this.disposed = true; calls.push(['dispose']); },
    compile(source, options) { calls.push(['compile', source, options]); return { success: true, assemblyId: 'assembly1', pe: Uint8Array.of(77, 90, 1), source }; },
    run(assembly, options) { calls.push(['run', assembly, options]); return { success: true, result: 42n }; },
    references() { return ['System.Runtime.dll']; },
    ...overrides,
  };
  let starts = 0;
  return { compiler, calls, get starts() { return starts; }, session: createApiSession({ getCompiler: async () => { starts++; return compiler; }, ...options }) };
}

test('API allowlist matches every public compiler member', async () => {
  const source = await readFile(new URL('../src/browser.js', import.meta.url), 'utf8');
  const api = source.slice(source.indexOf('  const api = {'), source.indexOf('\n  return api;'));
  const discovered = new Set(['info', ...[...api.matchAll(/^    (?:(?:async |get )?)(\w+)\(/gm)].map(match => match[1])]);
  assert.deepEqual([...API_METHODS].sort(), [...discovered].sort());
});

test('JSON codecs preserve BigInt, special floats and visible bytes without functions', async () => {
  const view = Uint8Array.of(9, 1, 2, 8).subarray(1, 3);
  const source = { big: 18446744073709551615n, floats: [NaN, Infinity, -Infinity, -0], bytes: view, callback() {}, absent: undefined };
  const encoded = encodeJson(source);
  assert.deepEqual(encoded.bytes, { $bytes: 'AQI=' });
  assert.equal('callback' in encoded, false);
  assert.equal('absent' in encoded, false);
  const decoded = await decodeJson(JSON.parse(stringifyJson(source)));
  assert.equal(decoded.big, source.big);
  assert.deepEqual(decoded.floats, source.floats);
  assert.deepEqual(decoded.bytes, Uint8Array.of(1, 2));
});

test('JSON codecs preserve every typed-array class, DataView, ArrayBuffer and Map', async () => {
  const types = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array];
  for (const Type of types) {
    const original = new Type(Type.name.startsWith('Big') ? [1n, 2n] : [1, 2]);
    const decoded = await decodeJson(encodeJson(original));
    assert.equal(decoded.constructor, Type);
    assert.deepEqual(decoded, original);
  }
  const buffer = Uint8Array.of(3, 4, 5).buffer;
  const decodedBuffer = await decodeJson(encodeJson(buffer));
  assert.ok(decodedBuffer instanceof ArrayBuffer);
  assert.deepEqual(new Uint8Array(decodedBuffer), new Uint8Array(buffer));
  const decodedView = await decodeJson(encodeJson(new DataView(buffer, 1, 2)));
  assert.ok(decodedView instanceof DataView);
  assert.deepEqual(new Uint8Array(decodedView.buffer), Uint8Array.of(4, 5));
  const map = new Map([[12n, new Map([['bytes', Uint8Array.of(6)]])], ['float', -Infinity]]);
  assert.deepEqual(await decodeJson(encodeJson(map)), map);
});

test('JSON codecs read files and nested text relative to explicit cwd', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roslyn-cli-codec-'));
  try {
    await writeFile(join(directory, 'Program.cs'), 'Console.WriteLine("CLI");');
    await writeFile(join(directory, 'Library.dll'), Uint8Array.of(77, 90));
    assert.deepEqual(await decodeJson([{ $text: 'Program.cs' }, { $file: 'Library.dll' }], { cwd: directory }), ['Console.WriteLine("CLI");', Uint8Array.of(77, 90)]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid transport markers reject explicitly', async () => {
  const invalid = [{ $bigint: '1e2' }, { $bigint: 12 }, { $number: '12' }, { $number: NaN }, { $bytes: '@@@' }, { $bytes: 'a' }, { $bytes: 'Zh==' }, { $bytes: 'AQ==', $type: 'Int32Array' }, { $bytes: '', $type: 'Function' }, { $map: [[1]] }, { $text: '' }, { $file: 12 }, { $bytes: '', extra: true }, { $bigint: '1', $number: 'NaN' }];
  for (const value of invalid) await assert.rejects(decodeJson(value), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(decodeJson({ $ref: 'one.pe' }), { code: 'INVALID_REFERENCE' });
  const circular = {}; circular.self = circular;
  assert.throws(() => encodeJson(circular), { code: 'JSON_CYCLE' });
});

test('decoded data keys cannot pollute prototypes', async () => {
  const original = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}');
  const decoded = await decodeJson(original);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(decoded.constructor, 'data');
  assert.equal(decoded.__proto__.polluted, true);
  assert.equal(JSON.parse(stringifyJson(decoded)).__proto__.polluted, true);
});

test('compile then run reuses the same raw PE and preserves result envelopes', async () => {
  const fixture = mockSession();
  const compiled = await fixture.session.dispatch({ id: 'compiled', method: 'compile', args: ['return 42;', { outputKind: 'console' }] });
  assert.deepEqual(compiled.result.pe, { $bytes: 'TVoB' });
  const run = await fixture.session.dispatch({ id: 'executed', method: 'run', args: [{ $ref: 'compiled.pe' }, { backend: 'wasm' }] });
  assert.deepEqual(run, { id: 'executed', success: true, result: { success: true, result: { $bigint: '42' } } });
  assert.deepEqual(fixture.calls[1][1], Uint8Array.of(77, 90, 1));
  assert.equal(fixture.starts, 1);
  await fixture.session.dispose();
});

test('failed compilation retains diagnostics and raw result without stopping session', async () => {
  const fixture = mockSession({ compile() { return { success: false, diagnostics: [{ id: 'CS1002', message: '; expected' }] }; } });
  const failed = await fixture.session.dispatch({ id: 10, method: 'compile', args: ['bad'] });
  assert.equal(failed.success, false);
  assert.equal(failed.error.code, 'COMPILE_FAILED');
  assert.equal(failed.error.diagnostics[0].id, 'CS1002');
  assert.equal(failed.result.success, false);
  assert.equal((await fixture.session.dispatch({ method: 'references' })).success, true);
  await fixture.session.dispose();
});

test('startup exceptions stay failed and never silently create another compiler', async () => {
  let starts = 0;
  const session = createApiSession({ getCompiler() { starts++; throw Object.assign(new Error('missing runtime'), { code: 'RUNTIME_MISSING' }); } });
  for (let index = 0; index < 2; index++) assert.equal((await session.dispatch({ method: 'info' })).error.code, 'RUNTIME_MISSING');
  assert.equal(starts, 1);
  await session.dispose();
});

test('timed-out hosts remain disposed across subsequent requests', async () => {
  const fixture = mockSession({ run() { this.disposed = true; throw Object.assign(new Error('operation timed out'), { code: 'TIMEOUT' }); } });
  assert.equal((await fixture.session.dispatch({ method: 'run', args: ['pe'] })).error.code, 'TIMEOUT');
  assert.equal((await fixture.session.dispatch({ method: 'compile', args: ['source'] })).error.code, 'DISPOSED');
  assert.equal((await fixture.session.dispatch({ method: 'disposed' })).result, true);
  assert.equal(fixture.starts, 1);
  await fixture.session.dispose();
});

test('disposed can be queried before initialization and dispose is idempotent', async () => {
  const fixture = mockSession();
  assert.equal((await fixture.session.dispatch({ method: 'disposed' })).result, false);
  assert.equal(fixture.starts, 0);
  assert.deepEqual((await fixture.session.dispatch({ method: 'dispose' })).result, { disposed: true });
  await fixture.session.dispose();
  assert.equal(fixture.starts, 0);
  assert.equal((await fixture.session.dispatch({ method: 'info' })).error.code, 'DISPOSED');
  assert.equal((await fixture.session.dispatch({ method: 'disposed' })).result, true);
});

test('bounded result history evicts old results and replaces duplicate ids', async () => {
  const fixture = mockSession({}, { maxResults: 2 });
  await fixture.session.dispatch({ id: 'first', method: 'compile', args: ['one'] });
  await fixture.session.dispatch({ id: 'second', method: 'compile', args: ['two'] });
  await fixture.session.dispatch({ id: 'third', method: 'compile', args: ['three'] });
  assert.equal(fixture.session.resultCount, 2);
  assert.equal((await fixture.session.dispatch({ method: 'run', args: [{ $ref: 'first' }] })).error.code, 'INVALID_REFERENCE');
  await fixture.session.dispatch({ id: 'second', method: 'compile', args: ['replacement'] });
  await fixture.session.dispatch({ id: 'used', method: 'run', args: [{ $ref: 'second.source' }] });
  assert.equal(fixture.calls.at(-1)[1], 'replacement');
  await fixture.session.dispose();
  assert.equal(fixture.session.resultCount, 0);
});

test('retained results have an encoded byte budget and oversized replies remain usable without retention', async () => {
  const fixture = mockSession({ compile(source) { return { success: true, source }; } }, { maxResults: 64, maxResultBytes: 100 });
  await fixture.session.dispatch({ id: 'first', method: 'compile', args: ['a'.repeat(30)] });
  await fixture.session.dispatch({ id: 'second', method: 'compile', args: ['b'.repeat(30)] });
  assert.equal(fixture.session.resultCount, 1);
  assert(fixture.session.resultBytes <= 100);
  assert.equal((await fixture.session.dispatch({ method: 'run', args: [{ $ref: 'first' }] })).error.code, 'INVALID_REFERENCE');
  const oversized = await fixture.session.dispatch({ id: 'second', method: 'compile', args: ['c'.repeat(1000)] });
  assert.equal(oversized.success, true);
  assert.equal(oversized.result.source.length, 1000);
  assert.equal(fixture.session.resultCount, 0);
  assert.equal(fixture.session.resultBytes, 0);
  assert.equal((await fixture.session.dispatch({ method: 'run', args: [{ $ref: 'second' }] })).error.code, 'INVALID_REFERENCE');
  await fixture.session.dispose();
});

test('session dispose awaits production Node close when available', async () => {
  let closed = false;
  const fixture = mockSession({ async close() { await new Promise(resolve => setTimeout(resolve, 1)); this.disposed = true; closed = true; } });
  await fixture.session.dispatch({ method: 'info' });
  await fixture.session.dispose();
  assert.equal(closed, true);
  assert.equal(fixture.compiler.disposed, true);
});

test('abort closes the compiler immediately and repeated disposal awaits the same shutdown', async () => {
  const controller = new AbortController();
  let release, closeStarted = false, closeCompleted = false;
  const fixture = mockSession({ async close() { closeStarted = true; await new Promise(resolve => { release = resolve; }); closeCompleted = true; this.disposed = true; } }, { signal: controller.signal });
  await fixture.session.dispatch({ method: 'info' });
  controller.abort();
  await Promise.resolve();
  assert.equal(closeStarted, true);
  const first = fixture.session.dispose();
  const second = fixture.session.dispose();
  assert.equal(first, second);
  assert.equal(closeCompleted, false);
  release();
  await second;
  assert.equal(closeCompleted, true);
  assert.equal(fixture.session.resultCount, 0);
});

test('unsafe, inherited, accessor, function and missing result paths reject', async () => {
  const fixture = mockSession({ compile() { return Object.assign(Object.create({ inherited: 1 }), { success: true, nested: { count: 1 }, invoke() {} }); } });
  await fixture.session.dispatch({ id: 'entry', method: 'compile' });
  for (const path of ['entry.__proto__', 'entry.constructor', 'entry.nested.prototype', 'entry.inherited', 'entry.missing', 'entry.invoke', 'entry..nested']) {
    assert.equal((await fixture.session.dispatch({ method: 'run', args: [{ $ref: path }] })).error.code, 'INVALID_REFERENCE', path);
  }
  const dotted = await fixture.session.dispatch({ id: 'entry.dot', method: 'compile' });
  assert.equal(dotted.success, true);
  await fixture.session.dispatch({ method: 'run', args: [{ $ref: 'entry.dot.nested.count' }] });
  assert.equal(fixture.calls.at(-1)[1], 1);
  await fixture.session.dispose();
});

test('only compileFunction results can be targets and invoke preserves argument spread', async () => {
  const fixture = mockSession({
    compileFunction() { return { success: true, source: 'C#', invoke: (...args) => ({ success: true, result: args.reduce((a, b) => a + b, 0n) }) }; },
    compile() { return { success: true, invoke() { throw new Error('must not run'); } }; },
  });
  const compiled = await fixture.session.dispatch({ id: 'function', method: 'compileFunction', args: [{ body: 'return x+y;' }] });
  assert.equal('invoke' in compiled.result, false);
  const invoked = await fixture.session.dispatch({ id: 'answer', target: 'function', method: 'invoke', args: [{ $bigint: '2' }, { $bigint: '3' }] });
  assert.deepEqual(invoked.result.result, { $bigint: '5' });
  await fixture.session.dispatch({ id: 'assembly', method: 'compile' });
  assert.equal((await fixture.session.dispatch({ target: 'assembly', method: 'invoke' })).error.code, 'INVALID_TARGET');
  assert.equal((await fixture.session.dispatch({ target: 'function', method: 'run' })).error.code, 'INVALID_TARGET');
  await fixture.session.dispose();
});

test('concurrent dispatch is sequential, so later requests can reference earlier results', async () => {
  const fixture = mockSession({ async compile() { await new Promise(resolve => setTimeout(resolve, 10)); return { success: true, pe: Uint8Array.of(42) }; } });
  const first = fixture.session.dispatch({ id: 'build', method: 'compile' });
  const second = fixture.session.dispatch({ method: 'run', args: [{ $ref: 'build.pe' }] });
  assert.equal((await first).success, true);
  assert.equal((await second).success, true);
  assert.deepEqual(fixture.calls[0][1], Uint8Array.of(42));
  await fixture.session.dispose();
});

test('malformed requests return machine-readable errors and do not initialize compiler', async () => {
  const fixture = mockSession();
  for (const request of [null, [], 'compile', {}, { id: {}, method: 'compile' }, { id: Infinity, method: 'info' }, { method: 'compile', args: {} }, { method: '__proto__' }, { method: 'toString' }, { method: 'onEvent' }]) {
    const response = await fixture.session.dispatch(request);
    assert.equal(response.success, false);
    assert.doesNotThrow(() => JSON.stringify(response));
  }
  assert.equal(fixture.starts, 0);
  assert.equal((await fixture.session.dispatch({ method: 'info' })).result.bridgeVersion, 'test');
  await fixture.session.dispose();
});

test('aborted sessions reject before reading files or initializing a compiler', async () => {
  const controller = new AbortController();
  const fixture = mockSession({}, { signal: controller.signal });
  controller.abort();
  const response = await fixture.session.dispatch({ method: 'compile', args: [{ $text: 'missing-file.cs' }] });
  assert.equal(response.error.code, 'ABORTED');
  assert.equal(fixture.starts, 0);
  assert.equal(fixture.session.disposed, true);
  await fixture.session.dispose();
});
