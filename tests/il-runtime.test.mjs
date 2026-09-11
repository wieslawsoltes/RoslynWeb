import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileAssembly, analyzeAssembly, generateModule, ILCompilationError, ILExecutionError, ManagedException, i4, i8, r8, binary, compare, convert, toJS } from '../src/il/index.mjs';

const int = 'System.Int32', str = 'System.String', voidType = 'System.Void';
const ins = (opcode, operand = null) => ({ opcode, operand });
function method(name, code, extra = {}) {
  return { token: 0x06000001, name, declaringType: 'Test', isStatic: true, returnType: int, parameters: [], locals: [], body: code.map((i, offset) => ({ offset, ...i })), exceptionHandlers: [], ...extra };
}
function model(methods, extra = {}) { return { name: 'Fixture', entryPoint: methods[0].token, types: [{ name: 'Test', fields: [], methods }], ...extra }; }
const ref = (name, parameters = [], returnType = int, extra = {}) => ({ token: 0x0a000001, name, declaringType: 'Test', isStatic: true, returnType, parameters: parameters.map(type => ({ type })), ...extra });
const exec = (code, args = [], extra = {}) => compileAssembly(model([method('Main', code, extra)])).invoke('Main', args);

test('integer stack arithmetic wraps, signed division truncates, uint comparisons differ', () => {
  assert.equal(toJS(binary('add', i4(2147483647), i4(1))), -2147483648);
  assert.equal(toJS(binary('mul', i4(0x7fffffff), i4(0x7fffffff))), 1);
  assert.equal(toJS(binary('div', i4(-7), i4(2))), -3);
  assert.equal(toJS(binary('div.un', i4(-1), i4(2))), 2147483647);
  assert.equal(compare('cgt', i4(-1), i4(1)), false);
  assert.equal(compare('cgt.un', i4(-1), i4(1)), true);
  assert.equal(toJS(binary('shr.un', i4(-1), i4(1))), 2147483647);
});

test('64-bit arithmetic preserves bits beyond Number precision', () => {
  assert.equal(toJS(binary('add', i8('9007199254740993'), i8(2))), 9007199254740995n);
  assert.equal(toJS(binary('add', i8('9223372036854775807'), i8(1))), -9223372036854775808n);
  assert.equal(toJS(binary('shr.un', i8(-1), i4(1))), 9223372036854775807n);
  assert.equal(exec([ins('ldc.i8', '9007199254740993'), ins('ldc.i8', '2'), ins('add'), ins('ret')], [], { returnType: 'System.Int64' }), 9007199254740995n);
});

test('floating arithmetic, unordered comparisons, and integer conversion', () => {
  assert.equal(toJS(binary('div', r8(7), r8(2))), 3.5);
  assert.equal(toJS(binary('div', r8(1), r8(0))), Infinity);
  assert.equal(compare('clt.un', r8(NaN), r8(0)), true);
  assert.equal(compare('clt', r8(NaN), r8(0)), false);
  assert.equal(compare('ceq', r8(NaN), r8(NaN)), false);
  assert.equal(toJS(convert('conv.i4', r8(-2.75))), -2);
  assert.equal(toJS(convert('conv.u1', i4(-1))), 255);
  assert.equal(toJS(convert('conv.i1', i4(255))), -1);
  assert.equal(toJS(convert('conv.r.un', i4(-1))), 4294967295);
});

test('checked arithmetic, checked conversion, divide-by-zero have managed exception types', () => {
  assert.throws(() => binary('add.ovf', i4(2147483647), i4(1)), e => e.$type === 'System.OverflowException');
  assert.throws(() => binary('mul.ovf.un', i4(-1), i4(2)), e => e.$type === 'System.OverflowException');
  assert.throws(() => convert('conv.ovf.u1', i4(256)), e => e.$type === 'System.OverflowException');
  assert.throws(() => binary('div', i8(-9223372036854775808n), i8(-1)), e => e.$type === 'System.OverflowException');
  assert.throws(() => exec([ins('ldc.i4.1'), ins('ldc.i4.0'), ins('div'), ins('ret')]), e => e.$type === 'System.DivideByZeroException');
});

test('generated control flow handles loops and switch targets', () => {
  const code = [ins('ldc.i4.0'), ins('stloc.0'), ins('ldc.i4.0'), ins('stloc.1'), ins('br', 13), ins('ldloc.0'), ins('ldloc.1'), ins('add'), ins('stloc.0'), ins('ldloc.1'), ins('ldc.i4.1'), ins('add'), ins('stloc.1'), ins('ldloc.1'), ins('ldarg.0'), ins('blt', 5), ins('ldloc.0'), ins('ret')];
  assert.equal(exec(code, [100], { locals: [int, int], parameters: [{ type: int }] }), 4950);
  const switchCode = [ins('ldarg.0'), ins('switch', [4, 6]), ins('ldc.i4.m1'), ins('ret'), ins('ldc.i4.7'), ins('ret'), ins('ldc.i4.8'), ins('ret')];
  assert.equal(exec(switchCode, [0], { parameters: [{ type: int }] }), 7);
  assert.equal(exec(switchCode, [1], { parameters: [{ type: int }] }), 8);
  assert.equal(exec(switchCode, [-1], { parameters: [{ type: int }] }), -1);
});

test('managed method calls resolve member references and recurse', () => {
  const factorial = method('Factorial', [ins('ldarg.0'), ins('ldc.i4.1'), ins('ble', 10), ins('ldarg.0'), ins('ldarg.0'), ins('ldc.i4.1'), ins('sub'), ins('call', ref('Factorial', [int])), ins('mul'), ins('ret'), ins('ldc.i4.1'), ins('ret')], { parameters: [{ type: int }] });
  assert.equal(compileAssembly(model([factorial]), { strict: true }).invoke('Factorial', [10]), 3628800);
});

test('arrays initialize, truncate stores, mutate through managed element addresses', () => {
  const code = [ins('ldc.i4.2'), ins('newarr', { name: 'System.Byte' }), ins('stloc.0'), ins('ldloc.0'), ins('ldc.i4.0'), ins('ldc.i4', 257), ins('stelem.i1'), ins('ldloc.0'), ins('ldc.i4.1'), ins('ldelema', { name: 'System.Byte' }), ins('ldc.i4.s', 42), ins('stind.i1'), ins('ldloc.0'), ins('ldc.i4.0'), ins('ldelem.u1'), ins('ldloc.0'), ins('ldc.i4.1'), ins('ldelem.u1'), ins('add'), ins('ret')];
  assert.equal(exec(code, [], { locals: ['System.Byte[]'] }), 43);
  assert.throws(() => exec([ins('ldc.i4.1'), ins('newarr', { name: int }), ins('ldc.i4.1'), ins('ldelem.i4'), ins('ret')]), e => e.$type === 'System.IndexOutOfRangeException');
});

test('byref parameters modify caller locals', () => {
  const main = method('Main', [ins('ldc.i4.5'), ins('stloc.0'), ins('ldloca.s', 0), ins('call', ref('Increment', [int + '&'], voidType)), ins('ldloc.0'), ins('ret')], { locals: [int] });
  const increment = method('Increment', [ins('ldarg.0'), ins('ldarg.0'), ins('ldind.i4'), ins('ldc.i4.1'), ins('add'), ins('stind.i4'), ins('ret')], { token: 0x06000002, parameters: [{ type: int + '&' }], returnType: voidType });
  assert.equal(compileAssembly(model([main, increment])).run(), 6);
});

test('boxing keeps object identity and unboxing checks the exact type', () => {
  assert.equal(exec([ins('ldc.i4.7'), ins('box', { name: int }), ins('unbox.any', { name: int }), ins('ret')]), 7);
  assert.throws(() => exec([ins('ldc.i4.7'), ins('box', { name: int }), ins('unbox.any', { name: 'System.Int64' }), ins('ret')]), e => e.$type === 'System.InvalidCastException');
  assert.equal(exec([ins('ldstr', 'hello'), ins('ldnull'), ins('cgt.un'), ins('ret')]), 1);
});

test('instance fields, constructors and virtual dispatch', () => {
  const f = { token: 0x04000001, name: 'Value', declaringType: 'Base', type: int, isStatic: false };
  const ctor = method('.ctor', [ins('ldarg.0'), ins('ldarg.1'), ins('stfld', f), ins('ret')], { token: 0x06000002, declaringType: 'Derived', isStatic: false, parameters: [{ type: int }], returnType: voidType });
  const virtual = method('Get', [ins('ldarg.0'), ins('ldfld', f), ins('ldc.i4.2'), ins('mul'), ins('ret')], { token: 0x06000003, declaringType: 'Derived', isStatic: false });
  const main = method('Main', [ins('ldc.i4.8'), ins('newobj', ref('.ctor', [int], voidType, { declaringType: 'Derived', isStatic: false })), ins('callvirt', ref('Get', [], int, { declaringType: 'Base', isStatic: false })), ins('ret')]);
  const m = model([main]); m.types.push({ name: 'Base', baseType: 'System.Object', fields: [f], methods: [] }, { name: 'Derived', baseType: 'Base', fields: [], methods: [ctor, virtual] });
  assert.equal(compileAssembly(m).run(), 16);
});

test('static initialization runs exactly once', () => {
  const field = { name: 'Count', declaringType: 'Test', type: int, isStatic: true };
  const main = method('Main', [ins('ldsfld', field), ins('ret')]);
  const ctor = method('.cctor', [ins('ldsfld', field), ins('ldc.i4.1'), ins('add'), ins('stsfld', field), ins('ret')], { token: 0x06000002, returnType: voidType });
  const m = model([main, ctor]); m.types[0].fields = [field];
  const runtime = compileAssembly(m); assert.equal(runtime.run(), 1); assert.equal(runtime.run(), 1);
});

test('catch handlers receive typed managed arithmetic errors', () => {
  const m = method('Main', [ins('ldc.i4.1'), ins('ldc.i4.0'), ins('div'), ins('stloc.0'), ins('leave', 9), ins('pop'), ins('ldc.i4.s', 42), ins('stloc.0'), ins('leave', 9), ins('ldloc.0'), ins('ret')], { locals: [int], exceptionHandlers: [{ kind: 'catch', tryOffset: 0, tryLength: 5, handlerOffset: 5, handlerLength: 4, catchType: 'System.DivideByZeroException' }] });
  assert.equal(compileAssembly(model([m])).run(), 42);
});

test('finally executes for leave and exceptional unwind before an outer catch', () => {
  const normal = method('Main', [ins('ldc.i4.1'), ins('stloc.0'), ins('leave', 8), ins('ldloc.0'), ins('ldc.i4.2'), ins('add'), ins('stloc.0'), ins('endfinally'), ins('ldloc.0'), ins('ret')], { locals: [int], exceptionHandlers: [{ kind: 'finally', tryOffset: 0, tryLength: 3, handlerOffset: 3, handlerLength: 5 }] });
  assert.equal(compileAssembly(model([normal])).run(), 3);
  const exceptional = method('Main', [ins('ldc.i4.1'), ins('ldc.i4.0'), ins('div'), ins('pop'), ins('leave', 11), ins('ldc.i4.7'), ins('stloc.0'), ins('endfinally'), ins('pop'), ins('leave', 11), ins('nop'), ins('ldloc.0'), ins('ret')], { locals: [int], exceptionHandlers: [{ kind: 'finally', tryOffset: 0, tryLength: 5, handlerOffset: 5, handlerLength: 3 }, { kind: 'catch', tryOffset: 0, tryLength: 8, handlerOffset: 8, handlerLength: 3, catchType: 'System.Exception' }] });
  assert.equal(compileAssembly(model([exceptional])).run(), 7);
});

test('exception filters select catches and rejected filters continue search', () => {
  const make = accept => method('Main', [ins('ldc.i4.1'), ins('ldc.i4.0'), ins('div'), ins('ret'), ins('pop'), ins('ldc.i4', accept ? 1 : 0), ins('endfilter'), ins('pop'), ins('ldc.i4.7'), ins('ret'), ins('pop'), ins('ldc.i4.8'), ins('ret')], { exceptionHandlers: [{ kind: 'filter', tryOffset: 0, tryLength: 4, filterOffset: 4, handlerOffset: 7, handlerLength: 3 }, { kind: 'catch', tryOffset: 0, tryLength: 4, handlerOffset: 10, handlerLength: 3, catchType: 'System.Exception' }] });
  assert.equal(compileAssembly(model([make(true)])).run(), 7);
  assert.equal(compileAssembly(model([make(false)])).run(), 8);
});

test('explicit JavaScript externals use plain arguments and typed return values', () => {
  const external = ref('Double', [int], int, { declaringType: 'Host.Api' });
  const m = model([method('Main', [ins('ldc.i4.s', 21), ins('call', external), ins('ret')])]);
  assert.equal(analyzeAssembly(m).supported, false);
  const runtime = compileAssembly(m, { externals: { 'Host.Api::Double': value => value * 2 }, strict: true });
  assert.equal(runtime.run(), 42);
});

test('linked normalized assemblies resolve cross-assembly method signatures', () => {
  const dependency = model([method('Double', [ins('ldarg.0'), ins('ldc.i4.2'), ins('mul'), ins('ret')], { declaringType: 'Library', parameters: [{ type: int }] })], { name: 'Dependency' });
  dependency.types[0].name = 'Library';
  const main = model([method('Main', [ins('ldc.i4.s', 21), ins('call', ref('Double', [int], int, { declaringType: 'Library', assemblyName: 'Dependency' })), ins('ret')])]);
  assert.equal(compileAssembly(main, { assemblies: [dependency], strict: true }).run(), 42);
});

test('delegate function pointers invoke generated managed methods', () => {
  const target = method('Double', [ins('ldarg.0'), ins('ldc.i4.2'), ins('mul'), ins('ret')], { token: 0x06000002, parameters: [{ type: int }] });
  const type = 'System.Func`2[System.Int32,System.Int32]';
  const main = method('Main', [ins('ldnull'), ins('ldftn', ref('Double', [int])), ins('newobj', ref('.ctor', ['System.Object', 'System.IntPtr'], voidType, { declaringType: type, isStatic: false })), ins('ldc.i4.s', 21), ins('callvirt', ref('Invoke', [int], int, { declaringType: type, isStatic: false })), ins('ret')]);
  assert.equal(compileAssembly(model([main, target])).run(), 42);
});

test('field RVA initialization loads precise signed and 64-bit array contents', () => {
  const m = method('Main', [ins('ldc.i4.2'), ins('newarr', { name: int }), ins('dup'), ins('ldtoken', { name: 'Data', initialData: [1, 0, 0, 0, 255, 255, 255, 255] }), ins('call', ref('InitializeArray', ['System.Array', 'System.RuntimeFieldHandle'], voidType, { declaringType: 'System.Runtime.CompilerServices.RuntimeHelpers' })), ins('ldc.i4.1'), ins('ldelem.i4'), ins('ret')]);
  assert.equal(compileAssembly(model([m])).run(), -1);
});

test('unsupported opcodes, unresolved calls and malformed branch targets fail explicitly', () => {
  const m = model([method('Main', [ins('arglist'), ins('ret')])]);
  assert.equal(analyzeAssembly(m).supported, false);
  assert.throws(() => compileAssembly(m, { strict: true }), ILCompilationError);
  assert.throws(() => compileAssembly(m).run(), ILExecutionError);
  assert.ok(analyzeAssembly(model([method('Main', [ins('br', 42)])])).diagnostics.some(d => d.code === 'IL_INVALID_BRANCH'));
  assert.throws(() => compileAssembly(model([method('Main', [ins('call', ref('Missing', [], int, { declaringType: 'Missing' })), ins('ret')])])).run(), /No managed or JavaScript implementation/);
});

test('instruction budgets stop unbounded generated loops', () => {
  const runtime = compileAssembly(model([method('Main', [ins('br', 0)])]), { maxInstructions: 100 });
  assert.throws(() => runtime.run(), /instruction budget/);
});

test('portable generated ES modules execute without Function construction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'roslyn-il-'));
  try {
    const path = join(dir, 'compiled.mjs');
    const source = generateModule(model([method('Main', [ins('ldc.i4.s', 42), ins('ret')])]), { runtimeImport: new URL('../src/il/runtime.mjs', import.meta.url).href });
    assert.match(source, /switch\(\$pc\)/);
    assert.doesNotMatch(source, /\bFunction\(/);
    await writeFile(path, source);
    const module = await import(pathToFileURL(path));
    assert.equal(module.createAssembly().run(), 42);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('actual Roslyn-emitted and inspected IL executes in generated JavaScript', async t => {
  const path = new URL('../managed/SelfTest/bin/Release/net10.0/il-fixture.json', import.meta.url);
  let fixture;
  try { fixture = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Run the managed SelfTest to generate the actual Roslyn IL fixture.'); return; } throw error; }
  const runtime = compileAssembly(fixture, { strict: true });
  assert.equal(runtime.invoke('Arithmetic::Sum', [100]), 4950);
  assert.equal(runtime.invoke('Arithmetic::Branch', [5]), 10);
  assert.equal(runtime.invoke('Arithmetic::Branch', [12]), 13);
});

test('real Roslyn comprehensive fixture covers object, struct, collection, delegate, formatting and exception paths', async () => {
  const fixture = JSON.parse(await readFile(new URL('./il-fixture.json', import.meta.url), 'utf8'));
  const runtime = compileAssembly(fixture, { strict: true });
  assert.equal(runtime.invoke('Comprehensive::Checked', [20, 22]), 42);
  assert.throws(() => runtime.invoke('Comprehensive::Checked', [2147483647, 1]), e => e.$type === 'System.OverflowException');
  assert.equal(runtime.invoke('Comprehensive::Long'), 9007199254740995n);
  assert.equal(runtime.invoke('Comprehensive::Array'), 15);
  assert.equal(runtime.invoke('Comprehensive::ByRef'), 21);
  assert.equal(runtime.invoke('Comprehensive::Virtual'), 14);
  assert.equal(runtime.invoke('Comprehensive::Exceptions', [0]), 44);
  assert.equal(runtime.invoke('Comprehensive::Exceptions', [4]), 28);
  assert.equal(runtime.invoke('Comprehensive::Filter', [0]), 17);
  assert.equal(runtime.invoke('Comprehensive::NestedFinally'), 12);
  assert.throws(() => runtime.invoke('Comprehensive::CatchInsideFinally'), e => e.$type === 'System.InvalidOperationException');
  assert.equal(runtime.invoke('Comprehensive::List'), 12);
  assert.equal(runtime.invoke('Comprehensive::Delegate'), 42);
  assert.equal(runtime.invoke('Comprehensive::Interpolate', [7]), 'n = 007');
  assert.equal(runtime.invoke('Comprehensive::Struct'), 20);
});

test('builtin preflight rejects unsupported overloads before any program output', () => {
  const unsupportedRefs = [
    ref('.ctor', ['System.Char', int], voidType, { declaringType: 'System.String', isStatic: false }),
    ref('Round', ['System.Double', int], 'System.Double', { declaringType: 'System.Math' }),
    ref('Equals', [str, str, 'System.StringComparison'], 'System.Boolean', { declaringType: 'System.String' }),
    ref('WriteLine', ['System.Char[]', int, int], voidType, { declaringType: 'System.Console' }),
  ];
  for (const call of unsupportedRefs) {
    const fixture = model([method('Main', [ins(call.name === '.ctor' ? 'newobj' : 'call', call), ins('ret')])]);
    assert.equal(analyzeAssembly(fixture).supported, false, call.declaringType + '::' + call.name);
    assert.throws(() => compileAssembly(fixture, { strict: true }), ILCompilationError);
  }
  const supported = model([method('Main', [ins('ldc.i4.s', 42), ins('call', ref('WriteLine', [int], voidType, { declaringType: 'System.Console' })), ins('ldc.i4.0'), ins('ret')])]);
  const analysis = analyzeAssembly(supported);
  assert.equal(analysis.supported, true);
  assert.equal(analysis.dependencies[0].overloadValidatedAtRuntime, false);
});

test('portable generated modules embed linked managed assemblies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roslyn-il-linked-'));
  try {
    const dependency = model([method('Double', [ins('ldarg.0'), ins('ldc.i4.2'), ins('mul'), ins('ret')], { declaringType: 'Library', parameters: [{ type: int }] })], { name: 'Dependency' });
    dependency.types[0].name = 'Library';
    const main = model([method('Main', [ins('ldc.i4.s', 21), ins('call', ref('Double', [int], int, { declaringType: 'Library', assemblyName: 'Dependency' })), ins('ret')])]);
    const source = generateModule(main, { strict: true, assemblies: [dependency], runtimeImport: new URL('../src/il/runtime.mjs', import.meta.url).href });
    const path = join(directory, 'linked.mjs'); await writeFile(path, source);
    const module = await import(pathToFileURL(path));
    assert.equal(module.linkedAssemblies.length, 1);
    assert.equal(module.createAssembly().run(), 42);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public return values and Console formatting preserve unsigned and boolean types', () => {
  assert.equal(exec([ins('ldc.i4.m1'), ins('ret')], [], { returnType: 'System.UInt32' }), 4294967295);
  assert.equal(exec([ins('ldc.i8', '-1'), ins('ret')], [], { returnType: 'System.UInt64' }), 18446744073709551615n);
  assert.equal(exec([ins('ldc.i4.1'), ins('ret')], [], { returnType: 'System.Boolean' }), true);
  const lines = [];
  const main = method('Main', [ins('ldc.i4.m1'), ins('call', ref('WriteLine', ['System.UInt32'], voidType, { declaringType: 'System.Console' })), ins('ldc.i4.1'), ins('call', ref('WriteLine', ['System.Boolean'], voidType, { declaringType: 'System.Console' })), ins('ret')], { returnType: voidType });
  compileAssembly(model([main]), { output: line => lines.push(line) }).run();
  assert.deepEqual(lines, ['4294967295', 'True']);
});

test('64-bit metadata constants support both revived BigInt and bridge JSON tags', () => {
  for (const constant of [9007199254740993n, { $int64: '9007199254740993' }]) {
    const field = { name: 'LongValue', declaringType: 'Test', type: 'System.Int64', isStatic: true, constant };
    const main = method('Main', [ins('ldsfld', field), ins('ret')], { returnType: 'System.Int64' });
    const fixture = model([main]); fixture.types[0].fields.push(field);
    assert.equal(compileAssembly(fixture, { strict: true }).run(), 9007199254740993n);
    assert.doesNotThrow(() => generateModule(fixture, { strict: true }));
  }
});

test('external fields fail explicitly and supported framework static fields retain their values', () => {
  const missing = { name: 'MinValue', declaringType: 'System.DateTime', type: 'System.DateTime', isStatic: true };
  const fixture = model([method('Main', [ins('ldsfld', missing), ins('ret')], { returnType: 'System.DateTime' })]);
  assert.equal(analyzeAssembly(fixture).supported, false);
  assert.throws(() => compileAssembly(fixture).run(), /No linked storage/);
  assert.equal(exec([ins('ldsfld', { name: 'Empty', declaringType: 'System.String', type: str, isStatic: true }), ins('ret')], [], { returnType: str }), '');
});
