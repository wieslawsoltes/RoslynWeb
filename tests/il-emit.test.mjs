import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeAssembly, compileAssembly } from '../src/il/compiler.mjs';
import { invokeEmitBuiltin, isEmitBuiltin, reflectedOpcode } from '../src/il/reflection-emit.mjs';
import { reflectionType } from '../src/il/reflection.mjs';
import { i4 } from '../src/il/runtime.mjs';

const model = JSON.parse(await readFile(new URL('./il-emit-fixture.json', import.meta.url), 'utf8'));
const E = 'System.Reflection.Emit.', T = 'System.Type', I = 'System.Int32';
const ref = (declaringType, name, parameters = [], isStatic = false) => ({ declaringType, name, parameters: parameters.map(type => ({ type })), isStatic });
const rt = () => compileAssembly(model, { strict: true });
const invoke = (runtime, method, args = []) => runtime.invoke(`EmitFixture::${method}`, args);

test('real JS Reflection.Emit execution matches all captured native .NET differential cases', async () => {
  const baseline = JSON.parse(await readFile(new URL('./il-emit-native-baseline.json', import.meta.url), 'utf8'));
  const runtime = rt();
  const cases = { Add: ['Add', [20, 22]], CustomDelegate: ['CustomDelegate', [6, 7]], Loop: ['Loop', [100]], Switch0: ['Switch', [0]], Switch1: ['Switch', [1]], Switch2: ['Switch', [2]], ExactLong: ['ExactLong', [42n]], LinkedState: ['LinkedState', [7]], BoundTarget: ['BoundTarget', [20, 22]], ReflectedInvoke: ['ReflectedInvoke', [21]], CatchFinally0: ['CatchFinally', [0]], CatchFinally2: ['CatchFinally', [2]], CatchThrowsFinally: ['CatchThrowsFinally'], Metadata: ['Metadata'], InvalidDelegate: ['InvalidDelegate'], InvalidLabel: ['InvalidLabel'], ReflectedDelegates: ['ReflectedDelegates'] };
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(baseline.results).sort());
  for (const [name, [method, args]] of Object.entries(cases)) assert.equal(String(invoke(runtime, method, args)), baseline.results[name], name);
});

test('real Roslyn Reflection.Emit fixture passes strict JS compatibility analysis', () => {
  assert.deepEqual(analyzeAssembly(model).diagnostics, []);
});

test('C# DynamicMethod generates callable built-in and custom managed delegates', () => {
  const runtime = rt();
  assert.equal(invoke(runtime, 'Add', [20, 22]), 42);
  assert.equal(invoke(runtime, 'Add', [-50, 8]), -42);
  assert.equal(invoke(runtime, 'CustomDelegate', [6, 7]), 42);
});

test('C# ILGenerator local variables, labels and switch generate correct control flow', () => {
  const runtime = rt();
  assert.equal(invoke(runtime, 'Loop', [100]), 4950);
  assert.equal(invoke(runtime, 'Loop', [0]), 0);
  assert.equal(invoke(runtime, 'Switch', [0]), 10);
  assert.equal(invoke(runtime, 'Switch', [1]), 20);
  assert.equal(invoke(runtime, 'Switch', [2]), -1);
  assert.equal(invoke(runtime, 'Switch', [-1]), -1);
});

test('C# dynamic IL preserves 64-bit constants beyond JavaScript safe integer precision', () => {
  const runtime = rt();
  assert.equal(invoke(runtime, 'ExactLong', [42n]), 9007199254741035n);
  assert.equal(invoke(runtime, 'ExactLong', [-9007199254740993n]), 0n);
});

test('dynamic methods call reflected linked methods and mutate the same static storage', () => {
  const runtime = rt();
  assert.equal(invoke(runtime, 'LinkedState', [7]), 42);
  assert.equal(runtime.raw(runtime.staticFields.get('EmitFixture::Shared')), 21);
  assert.equal(invoke(runtime, 'LinkedState', [9]), 54);
});

test('dynamic delegates bind managed objects and reflection invocation boxes returned values', () => {
  const runtime = rt();
  assert.equal(invoke(runtime, 'BoundTarget', [20, 22]), 42);
  assert.equal(invoke(runtime, 'ReflectedInvoke', [21]), 42);
});

test('ILGenerator catch/finally runs on success and exception paths', () => {
  const runtime = rt();
  assert.equal(invoke(runtime, 'CatchFinally', [0]), 99);
  assert.equal(invoke(runtime, 'CatchFinally', [2]), 121);
  assert.equal(invoke(runtime, 'CatchThrowsFinally'), 42);
});

test('dynamic parameter/local/opcode metadata works through inherited reflection APIs', () => {
  assert.equal(invoke(rt(), 'Metadata'), 'Metadata:value:0:ldarg.0');
});

test('invalid delegate signatures and incomplete branch targets are observable managed errors', () => {
  const runtime = rt();
  assert.equal(invoke(runtime, 'InvalidDelegate'), 1);
  assert.equal(invoke(runtime, 'InvalidLabel'), 1);
});

test('Reflection.Emit admits exact overloads and does not advertise unimplemented native emission', () => {
  assert.equal(isEmitBuiltin(ref(E + 'ILGenerator', 'Emit', [E + 'OpCode', I])), true);
  assert.equal(isEmitBuiltin(ref(E + 'ILGenerator', 'EmitCalli', [E + 'OpCode', 'System.Runtime.InteropServices.CallingConvention', T, T + '[]'])), false);
  assert.equal(isEmitBuiltin(ref(E + 'DynamicMethod', 'GetDynamicILInfo')), false);
  assert.equal(isEmitBuiltin(ref(E + 'AssemblyBuilder', 'DefineDynamicAssembly', ['System.Reflection.AssemblyName', E + 'AssemblyBuilderAccess'])), true);
  assert.equal(reflectedOpcode('Unimplemented'), null);
  assert.equal(reflectedOpcode('Tailcall').$opcode, 'tail.');
});

test('emitted instructions share the configured execution budget', () => {
  const runtime = compileAssembly(model, { strict: true, maxInstructions: 500 });
  assert.throws(() => invoke(runtime, 'Loop', [1000000]), e => e.runtimeLimitation && /instruction budget/.test(e.message));
});

test('ILGenerator rejects labels/locals from another method before code publication', () => {
  const runtime = rt();
  const make = name => {
    const self = runtime.allocate(E + 'DynamicMethod');
    invokeEmitBuiltin(runtime, ref(E + 'DynamicMethod', '.ctor', ['System.String', T, T + '[]']), [name, reflectionType(runtime, I), { $array: true, items: [] }], self);
    return self.$generator;
  };
  const a = make('One'), b = make('Two');
  const foreignLabel = invokeEmitBuiltin(runtime, ref(E + 'ILGenerator', 'DefineLabel'), [], b).value;
  assert.throws(() => invokeEmitBuiltin(runtime, ref(E + 'ILGenerator', 'Emit', [E + 'OpCode', E + 'Label']), [reflectedOpcode('Br'), foreignLabel], a), e => e.$type === 'System.ArgumentException');
  const foreignLocal = invokeEmitBuiltin(runtime, ref(E + 'ILGenerator', 'DeclareLocal', [T]), [reflectionType(runtime, I)], b).value;
  assert.throws(() => invokeEmitBuiltin(runtime, ref(E + 'ILGenerator', 'Emit', [E + 'OpCode', E + 'LocalBuilder']), [reflectedOpcode('Ldloc'), foreignLocal], a), e => e.$type === 'System.ArgumentException');
});

test('MethodInfo.CreateDelegate supports static and open/closed instance linked methods', () => {
  const runtime = rt();
  assert.equal(invoke(runtime, 'ReflectedDelegates'), 42);
  const triple = runtime.resolveMethod('EmitFixture::Triple');
  const delegate = invokeEmitBuiltin(runtime, ref('System.Reflection.MethodInfo', 'CreateDelegate', [T]), [reflectionType(runtime, 'System.Func`2<System.Int32,System.Int32>')], { $member: triple }).value;
  assert.equal(runtime.raw(runtime.invokeDelegate(delegate, [i4(14)])), 42);
  assert.throws(() => invokeEmitBuiltin(runtime, ref('System.Reflection.MethodInfo', 'CreateDelegate', [T]), [reflectionType(runtime, 'System.Func`1<System.Int32>')], { $member: triple }), e => e.$type === 'System.ArgumentException');
});
