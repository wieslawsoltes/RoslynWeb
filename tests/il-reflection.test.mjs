import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileAssembly } from '../src/il/compiler.mjs';
import { toJS, i4, ManagedException } from '../src/il/runtime.mjs';
import { reflectionType, invokeReflectionBuiltin, isReflectionBuiltin, BindingFlags } from '../src/il/reflection.mjs';
import { ILAssemblyBuilder, DynamicMethodBuilder } from '../src/il/emitter.mjs';
const I = 'System.Int32', O = 'System.Object', T = 'System.Type', BF = 'System.Reflection.BindingFlags';
const ref = (owner, name, parameters = [], isStatic = false) => ({ declaringType: owner, name, parameters: parameters.map(type => ({ type })), isStatic });
const arr = (items, elementType = O) => ({ $array: true, $type: `${elementType}[]`, elementType, items });
function call(runtime, owner, name, parameters, args, self, isStatic = false) {
  const result = invokeReflectionBuiltin(runtime, ref(owner, name, parameters, isStatic), args, self);
  assert.equal(result.handled, true, `${owner}::${name}`); return result.value;
}
function fixture() {
  const a = new ILAssemblyBuilder('ReflectionFixture');
  const type = a.defineType('Example.Counter');
  const field = type.defineField('Value', I);
  const hidden = type.defineField('Secret', I, { isStatic: true, attributes: 'Private, Static', constant: 7 });
  type.defineConstructor([I]).emit('ldarg.0').emit('ldarg.1').emit('stfld', field).emit('ret');
  type.defineMethod('Twice', { parameters: [I], returnType: I }).emit('ldarg.0').emit('ldc.i4.2').emit('mul').emit('ret');
  type.defineMethod('Add', { parameters: [I], returnType: I, isStatic: false }).emit('ldarg.0').emit('ldfld', field).emit('ldarg.1').emit('add').emit('ret');
  type.defineMethod('Overload', { parameters: [I], returnType: I }).emit('ldarg.0').emit('ret');
  type.defineMethod('Overload', { parameters: ['System.String'], returnType: 'System.String' }).emit('ldarg.0').emit('ret');
  type.defineMethod('Increment', { parameters: [I + '&'], returnType: 'System.Void' }).emit('ldarg.0').emit('dup').emit('ldind.i4').emit('ldc.i4.1').emit('add').emit('stind.i4').emit('ret');
  type.defineMethod('Fail', { returnType: I }).emit('ldc.i4.1').emit('ldc.i4.0').emit('div').emit('ret');
  type.defineMethod('PrivateMethod', { attributes: 'Private, Static', returnType: I }).emit('ldc.i4.8').emit('ret');
  return a.compile();
}
const getMethod = (rt, type, name) => call(rt, T, 'GetMethod', ['System.String'], [name], type);

test('runtime IL builder compiles a loop with marked branches and exact integer semantics', () => {
  const m = new DynamicMethodBuilder('Sum', I, [I]);
  m.declareLocal(I); m.declareLocal(I);
  const body = m.defineLabel('body'), condition = m.defineLabel('condition');
  m.emit('ldc.i4.0').emit('stloc.0').emit('ldc.i4.0').emit('stloc.1').emit('br', condition);
  m.markLabel(body).emit('ldloc.0').emit('ldloc.1').emit('add').emit('stloc.0').emit('ldloc.1').emit('ldc.i4.1').emit('add').emit('stloc.1');
  m.markLabel(condition).emit('ldloc.1').emit('ldarg.0').emit('blt', body).emit('ldloc.0').emit('ret');
  assert.equal(m.createDelegate()(100), 4950);
  assert.equal(m.createDelegate()(0), 0);
});

test('IL builder rejects undefined, duplicate, cross-method and trailing branch labels', () => {
  const a = new DynamicMethodBuilder('Invalid', I), b = new DynamicMethodBuilder('Other', I);
  const l = a.defineLabel('missing'); a.emit('br', l);
  assert.throws(() => a.toModel(), /Unmarked/);
  assert.throws(() => a.emit('br', b.defineLabel()), /different method/);
  a.markLabel(l); assert.throws(() => a.toModel(), /beyond/);
  assert.throws(() => a.markLabel(l), /already marked/);
});

test('IL builder labeled exception region executes real finally generated JS', () => {
  const m = new DynamicMethodBuilder('Finally', I); m.declareLocal(I);
  const start = m.defineLabel(), end = m.defineLabel(), handler = m.defineLabel(), finish = m.defineLabel();
  m.markLabel(start).emit('ldc.i4.1').emit('stloc.0').emit('leave', finish).markLabel(end).markLabel(handler);
  m.emit('ldloc.0').emit('ldc.i4.2').emit('add').emit('stloc.0').emit('endfinally').markLabel(finish).emit('ldloc.0').emit('ret');
  m.addExceptionHandler({ kind: 'finally', tryStart: start, tryEnd: end, handlerStart: handler, handlerEnd: finish });
  assert.equal(m.createDelegate()(), 3);
});

test('dynamic builder exports portable JS without runtime eval construction', async () => {
  const m = new DynamicMethodBuilder('Double', I, [I]); m.emit('ldarg.0').emit('ldc.i4.2').emit('mul').emit('ret');
  const directory = await mkdtemp(join(tmpdir(), 'roslyn-emitter-'));
  try {
    const source = m.generateModule({ runtimeImport: new URL('../src/il/runtime.mjs', import.meta.url).href });
    assert.doesNotMatch(source, /\bFunction\(/);
    const file = join(directory, 'dynamic.mjs'); await writeFile(file, source);
    assert.equal((await import(pathToFileURL(file))).createAssembly().invoke('Double', [21]), 42);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reflection selects signatures, reports ambiguity and filters member visibility', () => {
  const rt = fixture(), type = reflectionType(rt, 'Example.Counter');
  const publicMethods = call(rt, T, 'GetMethods', [], [], type).items;
  assert.ok(publicMethods.some(m => m.$member.name === 'Twice'));
  assert.ok(publicMethods.every(m => m.$member.name !== 'PrivateMethod' && m.$member.name !== '.ctor'));
  const privateMethods = call(rt, T, 'GetMethods', [BF], [i4(BindingFlags.Static | BindingFlags.NonPublic)], type).items;
  assert.deepEqual(privateMethods.map(m => m.$member.name), ['PrivateMethod']);
  assert.throws(() => getMethod(rt, type, 'Overload'), e => e.$type === 'System.Reflection.AmbiguousMatchException');
  const matched = call(rt, T, 'GetMethod', ['System.String', 'System.Type[]'], ['Overload', arr([reflectionType(rt, I)], T)], type);
  assert.equal(matched.$member.parameters[0].type, I);
  assert.equal(getMethod(rt, type, 'Absent'), null);
});

test('reflection invocation boxes return values and preserves ref parameter updates', () => {
  const rt = fixture(), type = reflectionType(rt, 'Example.Counter');
  const twice = getMethod(rt, type, 'Twice');
  const answer = call(rt, 'System.Reflection.MethodInfo', 'Invoke', [O, 'System.Object[]'], [null, arr([rt.box(i4(21), I)])], twice);
  assert.equal(answer.$box, true); assert.equal(toJS(answer), 42);
  const increment = getMethod(rt, type, 'Increment'), args = arr([rt.box(i4(9), I)]);
  call(rt, 'System.Reflection.MethodInfo', 'Invoke', [O, 'System.Object[]'], [null, args], increment);
  assert.equal(toJS(args.items[0]), 10);
});

test('Activator constructors, reflected instance invocation and field updates use linked object storage', () => {
  const rt = fixture(), type = reflectionType(rt, 'Example.Counter');
  const obj = call(rt, 'System.Activator', 'CreateInstance', [T, 'System.Object[]'], [type, arr([rt.box(i4(12), I)])], null, true);
  const add = getMethod(rt, type, 'Add');
  assert.equal(toJS(call(rt, 'System.Reflection.MethodInfo', 'Invoke', [O, 'System.Object[]'], [obj, arr([rt.box(i4(30), I)])], add)), 42);
  const field = call(rt, T, 'GetField', ['System.String'], ['Value'], type);
  assert.equal(toJS(call(rt, 'System.Reflection.FieldInfo', 'GetValue', [O], [obj], field)), 12);
  call(rt, 'System.Reflection.FieldInfo', 'SetValue', [O, O], [obj, rt.box(i4(25), I)], field);
  assert.equal(toJS(call(rt, 'System.Reflection.FieldInfo', 'GetValue', [O], [obj], field)), 25);
  const secret = call(rt, T, 'GetField', ['System.String', BF], ['Secret', i4(BindingFlags.NonPublic | BindingFlags.Static)], type);
  assert.equal(toJS(call(rt, 'System.Reflection.FieldInfo', 'GetValue', [O], [null], secret)), 7);
});

test('reflected errors retain typed target/count errors and wrap target exceptions', () => {
  const rt = fixture(), type = reflectionType(rt, 'Example.Counter');
  assert.throws(() => call(rt, 'System.Reflection.MethodInfo', 'Invoke', [O, 'System.Object[]'], [null, arr([])], getMethod(rt, type, 'Twice')), e => e.$type === 'System.Reflection.TargetParameterCountException');
  assert.throws(() => call(rt, 'System.Reflection.MethodInfo', 'Invoke', [O, 'System.Object[]'], [null, arr([i4(1)])], getMethod(rt, type, 'Add')), e => e.$type === 'System.Reflection.TargetException');
  assert.throws(() => call(rt, 'System.Reflection.MethodInfo', 'Invoke', [O, 'System.Object[]'], [null, arr([])], getMethod(rt, type, 'Fail')), e => e instanceof ManagedException && e.$type === 'System.Reflection.TargetInvocationException' && e.innerException.$type === 'System.DivideByZeroException');
});

test('reflection exposes linked type, assembly and parameter metadata', () => {
  const rt = fixture(), type = reflectionType(rt, 'Example.Counter');
  assert.equal(call(rt, T, 'get_Name', [], [], type), 'Counter');
  assert.equal(call(rt, T, 'get_Namespace', [], [], type), 'Example');
  assert.equal(call(rt, T, 'get_BaseType', [], [], type).typeName, 'System.Object');
  const assembly = call(rt, T, 'get_Assembly', [], [], type);
  assert.equal(call(rt, 'System.Reflection.Assembly', 'get_FullName', [], [], assembly), 'ReflectionFixture');
  assert.deepEqual(call(rt, 'System.Reflection.Assembly', 'GetTypes', [], [], assembly).items.map(x => x.typeName), ['Example.Counter']);
  const parameters = call(rt, 'System.Reflection.MethodInfo', 'GetParameters', [], [], getMethod(rt, type, 'Twice')).items;
  assert.equal(call(rt, 'System.Reflection.ParameterInfo', 'get_ParameterType', [], [], parameters[0]).typeName, I);
});

test('reflection overload gate rejects unsupported binding and binder overloads', () => {
  assert.equal(isReflectionBuiltin(ref(T, 'GetMethod', ['System.String'])), true);
  assert.equal(isReflectionBuiltin(ref(T, 'GetMethod', ['System.String', BF, 'System.Reflection.Binder', 'System.Type[]', 'System.Reflection.ParameterModifier[]'])), false);
  assert.equal(isReflectionBuiltin(ref('System.Reflection.MethodInfo', 'Invoke', [O, BF, 'System.Reflection.Binder', 'System.Object[]', 'System.Globalization.CultureInfo'])), false);
});

test('real Roslyn generic reflection constructs closed types and invokes specialized methods', async () => {
  const model = JSON.parse(await readFile(new URL('./il-v2-fixture.json', import.meta.url), 'utf8'));
  const rt = compileAssembly(model, { externals: { 'NativeFixture::Add': (a, b) => a + b } });
  const open = reflectionType(rt, 'Box`1');
  const closed = call(rt, T, 'MakeGenericType', ['System.Type[]'], [arr([reflectionType(rt, I)], T)], open);
  assert.equal(closed.typeName, 'Box`1<System.Int32>');
  const obj = call(rt, 'System.Activator', 'CreateInstance', [T, 'System.Object[]'], [closed, arr([rt.box(i4(42), I)])], null, true);
  const get = getMethod(rt, closed, 'Get');
  assert.equal(get.$member.returnType, I);
  assert.equal(toJS(call(rt, 'System.Reflection.MethodInfo', 'Invoke', [O, 'System.Object[]'], [obj, arr([])], get)), 42);
  const echo = getMethod(rt, reflectionType(rt, 'GenericAlgorithms'), 'Echo');
  assert.throws(() => call(rt, 'System.Reflection.MethodInfo', 'Invoke', [O, 'System.Object[]'], [null, arr([i4(9)])], echo), e => e.$type === 'System.InvalidOperationException');
  const closedEcho = call(rt, 'System.Reflection.MethodInfo', 'MakeGenericMethod', ['System.Type[]'], [arr([reflectionType(rt, I)], T)], echo);
  assert.equal(toJS(call(rt, 'System.Reflection.MethodInfo', 'Invoke', [O, 'System.Object[]'], [null, arr([rt.box(i4(99), I)])], closedEcho)), 99);
});
